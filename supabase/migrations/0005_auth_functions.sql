-- =====================================================================
-- 0005_auth_functions.sql — identity, permissions, sessions, audit helpers
-- =====================================================================

create or replace function public.jwt_claims() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- TRUE for Edge Functions using the service-role key, and for direct database
-- sessions (SQL editor, pg_cron) which carry no API JWT at all.
create or replace function public.is_privileged() returns boolean
language sql stable as $$
  select public.jwt_claims() = '{}'::jsonb or public.jwt_claims()->>'role' = 'service_role';
$$;

create or replace function public.is_direct_db() returns boolean
language sql stable as $$
  select public.jwt_claims() = '{}'::jsonb;
$$;

create or replace function public.request_header(p_name text) returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb) ->> lower(p_name);
$$;

create or replace function public.request_ip() returns text
language sql stable as $$
  select coalesce(nullif(public.request_header('cf-connecting-ip'), ''),
                  nullif(trim(split_part(public.request_header('x-forwarded-for'), ',', 1)), ''));
$$;

create or replace function public.get_setting(p_key text, p_default jsonb default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from system_settings where key = p_key), p_default);
$$;

create or replace function public.setting_int(p_key text, p_default integer) returns integer
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  select value into v from system_settings where key = p_key;
  if v is null or jsonb_typeof(v) <> 'number' then return p_default; end if;
  return (v #>> '{}')::numeric::integer;
end $$;

create or replace function public.setting_bool(p_key text, p_default boolean) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  select value into v from system_settings where key = p_key;
  if v is null or jsonb_typeof(v) <> 'boolean' then return p_default; end if;
  return (v #>> '{}')::boolean;
end $$;

-- Fixed-window rate limiter. Internal use only.
create or replace function public.check_rate_limit(p_key text, p_max integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into rate_limits(key, window_start, count) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set count = rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_max;
end $$;

-- ---------------------------------------------------------------------
-- IP rules
-- ---------------------------------------------------------------------
create or replace function public.ip_allowed() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_ip inet;
begin
  if not exists (select 1 from ip_rules where is_active) then return true; end if;
  begin
    v_ip := public.request_ip()::inet;
  exception when others then v_ip := null;
  end;
  if v_ip is null then
    -- Unknown address: only acceptable when no allow-list is in force.
    return not exists (select 1 from ip_rules where is_active and action = 'allow');
  end if;
  if exists (select 1 from ip_rules where is_active and action = 'deny' and v_ip <<= cidr) then return false; end if;
  if exists (select 1 from ip_rules where is_active and action = 'allow') then
    return exists (select 1 from ip_rules where is_active and action = 'allow' and v_ip <<= cidr);
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Who is calling?
-- ---------------------------------------------------------------------
create or replace function public.current_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff_accounts where user_id = auth.uid() and status = 'active';
$$;

create or replace function public.current_driver_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from drivers where user_id = auth.uid();
$$;

create or replace function public.current_customer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from customers where user_id = auth.uid() and status <> 'deleted';
$$;

-- The single authorisation gate used by every RLS policy and RPC.
-- A permission is granted only if ALL of these hold:
--   * the caller is an ACTIVE staff member whose role holds the permission
--   * MFA is satisfied when required for that staff member
--   * the JWT session is registered (begin_session) and not revoked
--   * the request IP passes the configured IP rules
create or replace function public.has_permission(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from staff_accounts s
    join roles r on r.id = s.role_id
    left join admin_users au on au.staff_id = s.id
    where s.user_id = auth.uid()
      and s.status = 'active'
      and (r.code = 'super_admin'
           or exists (select 1 from role_permissions rp where rp.role_id = s.role_id and rp.permission_code = p_code))
      and (not coalesce(au.mfa_required, false) or public.jwt_claims()->>'aal' = 'aal2')
      and exists (select 1 from admin_sessions x
                  where x.session_id = nullif(public.jwt_claims()->>'session_id', '')::uuid
                    and x.staff_id = s.id and x.revoked_at is null)
  ) and public.ip_allowed();
$$;

create or replace function public.require_permission(p_code text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_permission(p_code) then
    raise exception 'PERMISSION_DENIED: %', p_code using errcode = '42501';
  end if;
end $$;

-- City scoping for regional / city managers.
create or replace function public.staff_city_ok(p_city_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_city_id is null or exists (
    select 1 from staff_accounts s
    where s.user_id = auth.uid() and s.status = 'active'
      and (s.city_scope is null or p_city_id = any (s.city_scope)));
$$;

-- ---------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------
create or replace function public.write_audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_old jsonb default null, p_new jsonb default null, p_reason text default null,
  p_staff_override uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_staff uuid := coalesce(p_staff_override, public.current_staff_id());
  v_type text;
begin
  v_type := case
    when v_staff is not null then 'staff'
    when v_uid is not null and exists (select 1 from drivers where user_id = v_uid) then 'driver'
    when v_uid is not null and exists (select 1 from customers where user_id = v_uid) then 'customer'
    when public.jwt_claims()->>'role' = 'service_role' then 'service'
    else 'system' end;
  insert into audit_logs(actor_user_id, actor_staff_id, actor_type, action, entity_type, entity_id, old_data, new_data, reason, ip)
  values (v_uid, v_staff, v_type, p_action, p_entity_type, p_entity_id, p_old, p_new, p_reason, public.request_ip());
end $$;

-- Generic row-change audit trigger for sensitive configuration tables.
create or replace function public.tg_audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('UPDATE','INSERT') then to_jsonb(new) end;
  v_id text := coalesce(v_new->>'id', v_old->>'id', v_new->>'key', v_old->>'key',
                        v_new->>'staff_id', v_old->>'staff_id', v_new->>'role_id', v_old->>'role_id');
  v_noise text[] := array['updated_at','availability','availability_changed_at','rating_avg','rating_count','used_count',
                          'loyalty_points','failed_login_count','last_login_at','last_login_ip','last_run_at','last_deleted_count'];
begin
  -- Ignore high-frequency operational columns so the audit trail stays meaningful.
  if tg_op = 'UPDATE' and (v_old - v_noise) = (v_new - v_noise) then return new; end if;
  perform public.write_audit(tg_table_name || '.' || lower(tg_op), tg_table_name, v_id, v_old, v_new, null);
  return coalesce(new, old);
end $$;

-- Notify every active staff member whose role holds a permission.
create or replace function public.notify_staff(
  p_permission text, p_category text, p_priority text, p_title text, p_body text, p_data jsonb default '{}'::jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  insert into notifications(audience, recipient_staff_id, category, priority, title, body, data, channels, dispatch_status)
  select 'staff', s.id, p_category, p_priority, p_title, p_body, coalesce(p_data, '{}'::jsonb),
         case when p_priority = 'emergency' then array['in_app','push'] else array['in_app'] end,
         case when p_priority = 'emergency' then 'pending' else 'in_app_only' end
  from staff_accounts s join roles r on r.id = s.role_id
  where s.status = 'active'
    and (r.code = 'super_admin' or exists (select 1 from role_permissions rp where rp.role_id = s.role_id and rp.permission_code = p_permission));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Console sessions and login security
-- ---------------------------------------------------------------------
create or replace function public.login_precheck(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_until timestamptz;
begin
  if not public.check_rate_limit('precheck:' || coalesce(public.request_ip(), 'unknown'), 60, 600) then
    return jsonb_build_object('allowed', false, 'code', 'RATE_LIMITED');
  end if;
  if not public.ip_allowed() then
    return jsonb_build_object('allowed', false, 'code', 'IP_BLOCKED');
  end if;
  select au.locked_until into v_until
  from staff_accounts s join admin_users au on au.staff_id = s.id
  where lower(s.email) = lower(trim(p_email));
  if v_until is not null and v_until > now() then
    return jsonb_build_object('allowed', false, 'code', 'LOCKED', 'locked_until', v_until);
  end if;
  return jsonb_build_object('allowed', true);
end $$;

create or replace function public.record_login_failure(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_staff staff_accounts;
  v_max integer := public.setting_int('security.max_failed_logins', 5);
  v_lock integer := public.setting_int('security.lockout_minutes', 15);
  v_count integer;
begin
  if not public.check_rate_limit('loginfail:' || coalesce(public.request_ip(), 'unknown'), 30, 600) then return; end if;
  select * into v_staff from staff_accounts where lower(email) = lower(trim(p_email));
  insert into admin_activity_logs(staff_id, email, event, ip, user_agent)
  values (v_staff.id, left(trim(p_email), 200), 'login_failed', public.request_ip(), left(public.request_header('user-agent'), 400));
  if v_staff.id is null then return; end if;
  insert into admin_users(staff_id) values (v_staff.id) on conflict do nothing;
  update admin_users set failed_login_count = failed_login_count + 1, updated_at = now()
  where staff_id = v_staff.id returning failed_login_count into v_count;
  if v_count >= v_max then
    update admin_users set locked_until = now() + make_interval(mins => v_lock), failed_login_count = 0 where staff_id = v_staff.id;
    insert into admin_activity_logs(staff_id, email, event, ip, is_suspicious, details)
    values (v_staff.id, v_staff.email, 'locked', public.request_ip(), true, jsonb_build_object('minutes', v_lock));
    perform public.notify_staff('security.view', 'security', 'high', 'Console account locked',
      v_staff.full_name || ' was locked for ' || v_lock || ' minutes after repeated failed logins.',
      jsonb_build_object('staff_id', v_staff.id));
  end if;
end $$;

-- Must be called right after sign-in (and MFA). Registers the JWT session.
create or replace function public.begin_session(p_device text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_staff staff_accounts;
  v_au admin_users;
  v_sid uuid;
  v_ip text := public.request_ip();
  v_ua text := left(public.request_header('user-agent'), 400);
  v_new_device boolean := false;
  v_is_new boolean;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED'); end if;
  select * into v_staff from staff_accounts where user_id = v_uid;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_STAFF'); end if;
  if v_staff.status <> 'active' then
    insert into admin_activity_logs(staff_id, email, event, ip, user_agent, details)
    values (v_staff.id, v_staff.email, 'login_blocked', v_ip, v_ua, jsonb_build_object('reason', v_staff.status));
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_' || upper(v_staff.status));
  end if;
  if not public.ip_allowed() then
    insert into admin_activity_logs(staff_id, email, event, ip, user_agent, is_suspicious, details)
    values (v_staff.id, v_staff.email, 'login_blocked', v_ip, v_ua, true, jsonb_build_object('reason', 'ip_rule'));
    return jsonb_build_object('ok', false, 'code', 'IP_BLOCKED');
  end if;
  insert into admin_users(staff_id) values (v_staff.id) on conflict do nothing;
  select * into v_au from admin_users where staff_id = v_staff.id for update;
  if v_au.locked_until is not null and v_au.locked_until > now() then
    insert into admin_activity_logs(staff_id, email, event, ip, user_agent, details)
    values (v_staff.id, v_staff.email, 'login_blocked', v_ip, v_ua, jsonb_build_object('reason', 'locked'));
    return jsonb_build_object('ok', false, 'code', 'LOCKED', 'locked_until', v_au.locked_until);
  end if;
  begin
    v_sid := nullif(public.jwt_claims()->>'session_id', '')::uuid;
  exception when others then v_sid := null;
  end;
  if v_sid is null then return jsonb_build_object('ok', false, 'code', 'NO_SESSION'); end if;
  if exists (select 1 from admin_sessions where session_id = v_sid and (revoked_at is not null or staff_id <> v_staff.id)) then
    return jsonb_build_object('ok', false, 'code', 'SESSION_REVOKED');
  end if;
  v_is_new := not exists (select 1 from admin_sessions where session_id = v_sid);
  if v_is_new then
    v_new_device := exists (select 1 from admin_sessions where staff_id = v_staff.id)
      and not exists (select 1 from admin_sessions where staff_id = v_staff.id
                      and (ip is not distinct from v_ip or user_agent is not distinct from v_ua));
    insert into admin_sessions(session_id, staff_id, ip, user_agent, device_label)
    values (v_sid, v_staff.id, v_ip, v_ua, left(p_device, 120));
    update admin_users set failed_login_count = 0, locked_until = null, last_login_at = now(), last_login_ip = v_ip, updated_at = now()
    where staff_id = v_staff.id;
    insert into admin_activity_logs(staff_id, email, event, ip, user_agent, device_label, is_suspicious)
    values (v_staff.id, v_staff.email, 'login_success', v_ip, v_ua, left(p_device, 120), v_new_device);
    if v_new_device then
      perform public.notify_staff('security.view', 'security', 'high', 'Login from a new device',
        v_staff.full_name || ' signed in from an unrecognised device or network.',
        jsonb_build_object('staff_id', v_staff.id, 'ip', v_ip));
    end if;
  else
    update admin_sessions set last_seen_at = now() where session_id = v_sid;
  end if;
  return jsonb_build_object('ok', true, 'mfa_required', v_au.mfa_required,
    'aal', coalesce(public.jwt_claims()->>'aal', 'aal1'), 'suspicious', v_new_device,
    'session_timeout_min', v_au.session_timeout_min);
end $$;

create or replace function public.end_session() returns void
language plpgsql security definer set search_path = public as $$
declare v_sid uuid; v_staff uuid := public.current_staff_id();
begin
  begin v_sid := nullif(public.jwt_claims()->>'session_id', '')::uuid; exception when others then return; end;
  update admin_sessions set revoked_at = now(), revoked_reason = 'logout'
  where session_id = v_sid and revoked_at is null and staff_id = v_staff;
  if found then
    insert into admin_activity_logs(staff_id, event, ip) values (v_staff, 'logout', public.request_ip());
  end if;
end $$;

create or replace function public.revoke_session(p_session_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.current_staff_id(); v_owner uuid;
begin
  select staff_id into v_owner from admin_sessions where session_id = p_session_id;
  if v_owner is null then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_owner <> v_me then perform public.require_permission('security.manage'); end if;
  if v_me is null then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  update admin_sessions set revoked_at = now(), revoked_by = v_me, revoked_reason = coalesce(nullif(trim(p_reason), ''), 'revoked')
  where session_id = p_session_id and revoked_at is null;
  insert into admin_activity_logs(staff_id, event, ip, details)
  values (v_owner, 'session_revoked', public.request_ip(), jsonb_build_object('by', v_me, 'reason', p_reason));
  perform public.write_audit('session.revoke', 'admin_sessions', p_session_id::text, null, null, p_reason);
end $$;

create or replace function public.log_auth_event(p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare v_staff uuid;
begin
  if p_event not in ('mfa_enrolled','mfa_verified','mfa_failed','password_reset') then
    raise exception 'INVALID_EVENT';
  end if;
  select id into v_staff from staff_accounts where user_id = auth.uid();
  if v_staff is null then return; end if;
  insert into admin_activity_logs(staff_id, event, ip, user_agent)
  values (v_staff, p_event, public.request_ip(), left(public.request_header('user-agent'), 400));
end $$;

-- Everything the console needs to render for the signed-in staff member.
create or replace function public.my_access() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_staff staff_accounts; v_role roles; v_au admin_users; v_perms jsonb; v_session_ok boolean;
begin
  select * into v_staff from staff_accounts where user_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_STAFF'); end if;
  if v_staff.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'ACCOUNT_' || upper(v_staff.status)); end if;
  select * into v_role from roles where id = v_staff.role_id;
  select * into v_au from admin_users where staff_id = v_staff.id;
  v_session_ok := exists (select 1 from admin_sessions x
     where x.session_id = nullif(public.jwt_claims()->>'session_id', '')::uuid and x.staff_id = v_staff.id and x.revoked_at is null);
  if not v_session_ok then return jsonb_build_object('ok', false, 'code', 'SESSION_REVOKED'); end if;
  if not public.ip_allowed() then return jsonb_build_object('ok', false, 'code', 'IP_BLOCKED'); end if;
  if coalesce(v_au.mfa_required, false) and coalesce(public.jwt_claims()->>'aal', 'aal1') <> 'aal2' then
    return jsonb_build_object('ok', false, 'code', 'MFA_REQUIRED');
  end if;
  if v_role.code = 'super_admin' then
    select coalesce(jsonb_agg(code order by code), '[]'::jsonb) into v_perms from permissions;
  else
    select coalesce(jsonb_agg(permission_code order by permission_code), '[]'::jsonb) into v_perms
    from role_permissions where role_id = v_staff.role_id;
  end if;
  return jsonb_build_object('ok', true,
    'staff', jsonb_build_object('id', v_staff.id, 'full_name', v_staff.full_name, 'email', v_staff.email,
       'employee_code', v_staff.employee_code, 'city_scope', v_staff.city_scope, 'branch_id', v_staff.branch_id),
    'role', jsonb_build_object('code', v_role.code, 'name', v_role.name),
    'permissions', v_perms,
    'session_timeout_min', coalesce(v_au.session_timeout_min, 30),
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from system_settings where is_public));
end $$;

-- First Super Admin. Runs ONLY from the SQL editor (direct database session)
-- and ONLY while no Super Admin exists. There are no built-in accounts.
create or replace function public.bootstrap_super_admin(p_email text, p_full_name text default 'Owner') returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_role uuid; v_staff uuid;
begin
  if not public.is_direct_db() then raise exception 'bootstrap_super_admin can only be run from the SQL editor' using errcode = '42501'; end if;
  select id into v_role from roles where code = 'super_admin';
  if exists (select 1 from staff_accounts where role_id = v_role and status = 'active') then
    raise exception 'A Super Admin already exists. Create further staff from the console.';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No auth user with email %. Create the user first in Authentication > Users.', p_email;
  end if;
  insert into profiles(id, user_type, full_name) values (v_uid, 'staff', p_full_name)
  on conflict (id) do update set user_type = 'staff', full_name = excluded.full_name;
  insert into staff_accounts(user_id, full_name, email, role_id) values (v_uid, p_full_name, lower(trim(p_email)), v_role)
  returning id into v_staff;
  insert into admin_users(staff_id) values (v_staff);
  perform public.write_audit('staff.bootstrap_super_admin', 'staff_accounts', v_staff::text, null, jsonb_build_object('email', p_email), 'initial owner setup');
  return 'Super Admin created for ' || p_email;
end $$;

create or replace function public.log_client_error(p_source text, p_level text, p_message text, p_context jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null and not public.is_privileged() then return; end if;
  if not public.check_rate_limit('errlog:' || coalesce(auth.uid()::text, 'service'), 60, 600) then return; end if;
  insert into error_logs(source, level, message, context, user_id)
  values (p_source, coalesce(p_level, 'error'), left(p_message, 2000), coalesce(p_context, '{}'::jsonb), auth.uid());
end $$;
