-- =====================================================================
-- 0001_foundation.sql
-- Ride Management System — foundation: extensions, geography, RBAC,
-- staff, sessions, audit, settings and security tables.
-- Money is ALWAYS stored as integer paise (bigint). Never floats.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Private schema: never exposed through the Supabase REST API.
create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
-- Server-side pepper used when hashing ride OTPs. Generated per installation.
insert into private.secrets (key, value)
values ('otp_pepper', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Human readable, platform-wide consistent identifiers (DRV-000001 ...).
create sequence if not exists public.staff_code_seq;
create sequence if not exists public.driver_code_seq;
create sequence if not exists public.vehicle_code_seq;
create sequence if not exists public.customer_code_seq;
create sequence if not exists public.booking_code_seq;
create sequence if not exists public.txn_code_seq;
create sequence if not exists public.ticket_code_seq;

create or replace function public.next_code(p_prefix text, p_seq regclass) returns text
language sql volatile set search_path = public as $$
  select p_prefix || '-' || lpad(nextval(p_seq)::text, 6, '0');
$$;

-- ---------------------------------------------------------------------
-- Geography (multi-city ready)
-- ---------------------------------------------------------------------
create table public.cities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  state text not null,
  country text not null default 'IN',
  timezone text not null default 'Asia/Kolkata',
  currency text not null default 'INR',
  center_lat numeric(9,6),
  center_lng numeric(9,6),
  is_active boolean not null default false,
  launched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, state)
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete restrict,
  name text not null,
  code text not null unique,
  address text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index branches_city_idx on public.branches(city_id);

create table public.service_zones (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete cascade,
  name text not null,
  zone_type text not null check (zone_type in
    ('operating','service_boundary','restricted','airport','railway','surge')),
  -- Polygon as ordered JSON array of {"lat":..,"lng":..} vertices.
  polygon jsonb not null default '[]'::jsonb,
  surge_multiplier_bp integer not null default 10000 check (surge_multiplier_bp between 10000 and 50000),
  is_active boolean not null default true,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (city_id, name)
);
create index service_zones_city_idx on public.service_zones(city_id, zone_type) where is_active;

-- ---------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_system boolean not null default false,
  rank integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.permissions (
  code text primary key,
  module text not null,
  description text not null,
  is_sensitive boolean not null default false
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  granted_by uuid,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_code)
);

-- One profile per auth user, shared by all three apps.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  user_type text not null check (user_type in ('staff','driver','customer')),
  full_name text,
  phone text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  employee_code text not null unique default public.next_code('EMP', 'public.staff_code_seq'),
  full_name text not null,
  email text not null unique,
  phone text,
  role_id uuid not null references public.roles(id) on delete restrict,
  -- NULL = all cities. Otherwise restricted to the listed cities.
  city_scope uuid[],
  branch_id uuid references public.branches(id) on delete set null,
  status text not null default 'active' check (status in ('active','suspended','deactivated')),
  suspended_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index staff_accounts_role_idx on public.staff_accounts(role_id);

alter table public.branches add column manager_staff_id uuid references public.staff_accounts(id) on delete set null;

-- Console security state for each staff member.
create table public.admin_users (
  staff_id uuid primary key references public.staff_accounts(id) on delete cascade,
  mfa_required boolean not null default false,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  last_login_ip text,
  session_timeout_min integer not null default 30 check (session_timeout_min between 5 and 720),
  updated_at timestamptz not null default now()
);

-- Server-registered console sessions. A session row is REQUIRED for any
-- permission to be granted (see has_permission), so revoking is immediate.
create table public.admin_sessions (
  session_id uuid primary key,
  staff_id uuid not null references public.staff_accounts(id) on delete cascade,
  ip text,
  user_agent text,
  device_label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text
);
create index admin_sessions_staff_idx on public.admin_sessions(staff_id, created_at desc);

create table public.admin_activity_logs (
  id bigint generated always as identity primary key,
  staff_id uuid references public.staff_accounts(id) on delete set null,
  email text,
  event text not null check (event in ('login_success','login_failed','login_blocked','logout',
    'mfa_enrolled','mfa_verified','mfa_failed','mfa_removed','password_reset','locked','session_revoked')),
  ip text,
  user_agent text,
  device_label text,
  is_suspicious boolean not null default false,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_activity_logs_staff_idx on public.admin_activity_logs(staff_id, created_at desc);
create index admin_activity_logs_created_idx on public.admin_activity_logs(created_at desc);

create table public.staff_activity (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.staff_accounts(id) on delete cascade,
  activity_type text not null check (activity_type in ('check_in','check_out','action')),
  entity_type text,
  entity_id text,
  summary text,
  created_at timestamptz not null default now()
);
create index staff_activity_staff_idx on public.staff_activity(staff_id, created_at desc);

-- ---------------------------------------------------------------------
-- Append-only audit log
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  actor_staff_id uuid,
  actor_type text not null default 'system' check (actor_type in ('staff','driver','customer','system','service')),
  action text not null,
  entity_type text not null,
  entity_id text,
  old_data jsonb,
  new_data jsonb,
  reason text,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs(entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs(actor_staff_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_action_idx on public.audit_logs(action, created_at desc);

create or replace function public.tg_audit_immutable() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.retention_job', true), '') = '1' and tg_op = 'DELETE' then
    return old;
  end if;
  raise exception 'audit records are append-only' using errcode = '42501';
end $$;

create trigger audit_logs_immutable before update or delete on public.audit_logs
for each row execute function public.tg_audit_immutable();

-- ---------------------------------------------------------------------
-- Settings, integrations and security configuration
-- ---------------------------------------------------------------------
create table public.system_settings (
  key text primary key,
  value jsonb not null,
  category text not null default 'general',
  description text,
  -- Public settings may be read by any signed-in app user (branding etc).
  is_public boolean not null default false,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.settings_history (
  id bigint generated always as identity primary key,
  key text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  reason text,
  created_at timestamptz not null default now()
);
create index settings_history_key_idx on public.settings_history(key, created_at desc);

-- Integration registry. SECRETS ARE NEVER STORED HERE — they live in
-- Supabase Edge Function secrets. This table holds status + public config.
create table public.integration_settings (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sms','payment','maps','push','email','whatsapp','ai','cache')),
  provider text not null,
  is_enabled boolean not null default false,
  mode text not null default 'test' check (mode in ('test','live')),
  public_config jsonb not null default '{}'::jsonb,
  status text not null default 'not_configured' check (status in ('not_configured','configured','healthy','error')),
  last_checked_at timestamptz,
  last_error text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, provider)
);

-- Outbound / inbound integration call log (API + webhook monitoring).
create table public.integration_events (
  id bigint generated always as identity primary key,
  kind text not null,
  provider text not null,
  direction text not null check (direction in ('outbound','inbound')),
  operation text not null,
  status text not null check (status in ('success','failure')),
  http_status integer,
  duration_ms integer,
  error text,
  reference text,
  created_at timestamptz not null default now()
);
create index integration_events_created_idx on public.integration_events(created_at desc);
create index integration_events_kind_idx on public.integration_events(kind, provider, created_at desc);

create table public.ip_rules (
  id uuid primary key default gen_random_uuid(),
  cidr cidr not null,
  action text not null check (action in ('allow','deny')),
  note text,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- API keys for future partner/server access. Only a SHA-256 hash is stored.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

create table public.error_logs (
  id bigint generated always as identity primary key,
  source text not null check (source in ('web','android','edge','database','driver_app','customer_app')),
  level text not null default 'error' check (level in ('info','warn','error','fatal')),
  message text not null,
  context jsonb not null default '{}'::jsonb,
  user_id uuid,
  created_at timestamptz not null default now()
);
create index error_logs_created_idx on public.error_logs(created_at desc);

create table public.backup_records (
  id uuid primary key default gen_random_uuid(),
  backup_type text not null check (backup_type in ('platform_daily','pitr','manual_export')),
  status text not null check (status in ('requested','completed','failed','verified')),
  location text,
  size_bytes bigint,
  notes text,
  recorded_by uuid,
  created_at timestamptz not null default now()
);

create table public.consent_records (
  id bigint generated always as identity primary key,
  subject_type text not null check (subject_type in ('driver','customer','staff')),
  subject_id uuid not null,
  consent_type text not null check (consent_type in ('terms','privacy','location_tracking','background_location','marketing','document_processing')),
  granted boolean not null,
  policy_version text not null,
  source text,
  created_at timestamptz not null default now()
);
create index consent_subject_idx on public.consent_records(subject_type, subject_id, consent_type, created_at desc);

create table public.data_retention_policies (
  id uuid primary key default gen_random_uuid(),
  entity text not null unique check (entity in ('driver_location_history','error_logs','integration_events',
    'rate_limits','admin_activity_logs','notification_delivery_logs','otp_delivery_logs','audit_logs')),
  retain_days integer not null check (retain_days >= 1),
  is_active boolean not null default true,
  last_run_at timestamptz,
  last_deleted_count bigint,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
