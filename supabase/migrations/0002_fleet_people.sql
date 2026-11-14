-- =====================================================================
-- 0002_fleet_people.sql — vehicle categories, drivers, vehicles, customers
-- =====================================================================

create table public.vehicle_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  capacity integer not null default 1 check (capacity between 1 and 50),
  icon text not null default 'fa-car',
  is_active boolean not null default true,
  is_custom boolean not null default false,
  -- Optional service schedule: [{"days":[1..7],"start":"06:00","end":"23:00"}]. Empty = always.
  schedule jsonb not null default '[]'::jsonb,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.category_city_availability (
  category_id uuid not null references public.vehicle_categories(id) on delete cascade,
  city_id uuid not null references public.cities(id) on delete cascade,
  is_enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (category_id, city_id)
);

-- ---------------------------------------------------------------------
-- Drivers
-- ---------------------------------------------------------------------
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  driver_code text not null unique default public.next_code('DRV', 'public.driver_code_seq'),
  full_name text not null,
  phone text not null unique,
  email text,
  date_of_birth date,
  gender text check (gender in ('male','female','other')),
  address_line text,
  locality text,
  pincode text,
  city_id uuid references public.cities(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete set null,
  photo_path text,
  status text not null default 'pending' check (status in
    ('pending','under_review','approved','rejected','suspended','deactivated','blacklisted')),
  status_reason text,
  availability text not null default 'offline' check (availability in ('offline','online','on_ride')),
  availability_changed_at timestamptz,
  -- Only masked identifiers are stored. Full numbers live solely inside the uploaded document.
  aadhaar_last4 text check (aadhaar_last4 ~ '^[0-9]{4}$'),
  pan_masked text,
  licence_masked text,
  licence_expiry date,
  police_verification_status text not null default 'not_started' check (police_verification_status in
    ('not_started','submitted','verified','failed')),
  emergency_contact_name text,
  emergency_contact_phone text,
  rating_avg numeric(3,2) not null default 0,
  rating_count integer not null default 0,
  referral_code text unique,
  location_consent_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references public.staff_accounts(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index drivers_status_idx on public.drivers(status);
create index drivers_city_idx on public.drivers(city_id, availability);
create index drivers_name_trgm on public.drivers using gin (full_name extensions.gin_trgm_ops);
create index drivers_created_idx on public.drivers(created_at desc);

create table public.driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  doc_type text not null check (doc_type in
    ('aadhaar','pan','driving_licence','photo','police_verification','address_proof','bank_proof','other')),
  storage_path text not null,
  doc_number_masked text,
  expiry_date date,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  rejection_reason text,
  notes text,
  reviewed_by uuid references public.staff_accounts(id) on delete set null,
  reviewed_at timestamptz,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'rejected' or rejection_reason is not null)
);
create index driver_documents_driver_idx on public.driver_documents(driver_id);
create index driver_documents_expiry_idx on public.driver_documents(expiry_date) where expiry_date is not null;
create index driver_documents_pending_idx on public.driver_documents(created_at) where status = 'pending';

-- Immutable verification history (who decided what, when and why).
create table public.driver_verifications (
  id bigint generated always as identity primary key,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  document_id uuid references public.driver_documents(id) on delete set null,
  action text not null,
  from_status text,
  to_status text,
  reason text,
  notes text,
  staff_id uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index driver_verifications_driver_idx on public.driver_verifications(driver_id, created_at desc);

create table public.driver_attendance (
  id bigint generated always as identity primary key,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  work_date date not null,
  first_online_at timestamptz,
  last_offline_at timestamptz,
  online_seconds integer not null default 0,
  rides_completed integer not null default 0,
  unique (driver_id, work_date)
);

create table public.driver_notes (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note','disciplinary','recovery','support')),
  severity text check (severity in ('low','medium','high')),
  body text not null,
  staff_id uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index driver_notes_driver_idx on public.driver_notes(driver_id, created_at desc);

create table public.driver_incentives (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  incentive_type text not null check (incentive_type in ('bonus','incentive','referral','penalty_reversal')),
  amount_paise bigint not null check (amount_paise > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending','credited','cancelled')),
  credited_at timestamptz,
  created_by uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index driver_incentives_driver_idx on public.driver_incentives(driver_id, created_at desc);

-- ---------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  vehicle_code text not null unique default public.next_code('VEH', 'public.vehicle_code_seq'),
  registration_number text not null unique,
  category_id uuid not null references public.vehicle_categories(id) on delete restrict,
  -- Ownership is independent from who currently drives the vehicle.
  ownership_type text not null check (ownership_type in ('company','driver_owned')),
  owner_name text not null,
  owner_phone text,
  owner_driver_id uuid references public.drivers(id) on delete set null,
  manufacturer text not null,
  model text not null,
  manufacture_year integer check (manufacture_year between 1990 and 2100),
  color text,
  fuel_type text check (fuel_type in ('petrol','diesel','cng','electric','hybrid','lpg')),
  seating_capacity integer check (seating_capacity between 1 and 50),
  city_id uuid references public.cities(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','active','maintenance','suspended','retired')),
  status_reason text,
  odometer_km numeric(10,1) not null default 0,
  gps_device_id text,
  photos jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ownership_type <> 'driver_owned' or owner_driver_id is not null)
);
create index vehicles_category_idx on public.vehicles(category_id);
create index vehicles_city_idx on public.vehicles(city_id, status);
create index vehicles_reg_trgm on public.vehicles using gin (registration_number extensions.gin_trgm_ops);

create table public.vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  doc_type text not null check (doc_type in ('rc','insurance','pollution','fitness','permit','photo','other')),
  storage_path text not null,
  doc_number_masked text,
  expiry_date date,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  rejection_reason text,
  reviewed_by uuid references public.staff_accounts(id) on delete set null,
  reviewed_at timestamptz,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'rejected' or rejection_reason is not null)
);
create index vehicle_documents_vehicle_idx on public.vehicle_documents(vehicle_id);
create index vehicle_documents_expiry_idx on public.vehicle_documents(expiry_date) where expiry_date is not null;

-- Service, repair, fuel fill-ups and accident records in one history table.
create table public.vehicle_maintenance (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  record_type text not null check (record_type in ('service','repair','fuel','accident','inspection')),
  description text not null,
  cost_paise bigint not null default 0 check (cost_paise >= 0),
  odometer_km numeric(10,1),
  fuel_litres numeric(7,2),
  performed_on date not null default current_date,
  next_due_on date,
  next_due_odometer_km numeric(10,1),
  vendor text,
  driver_id uuid references public.drivers(id) on delete set null,
  created_by uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index vehicle_maintenance_vehicle_idx on public.vehicle_maintenance(vehicle_id, performed_on desc);

create table public.vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  is_active boolean not null default true,
  assigned_by uuid references public.staff_accounts(id) on delete set null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  unassigned_reason text
);
-- A vehicle has at most one active driver, and a driver at most one active vehicle.
create unique index vehicle_assignments_one_driver on public.vehicle_assignments(vehicle_id) where is_active;
create unique index vehicle_assignments_one_vehicle on public.vehicle_assignments(driver_id) where is_active;

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  customer_code text not null unique default public.next_code('CUS', 'public.customer_code_seq'),
  full_name text not null,
  phone text not null unique,
  email text,
  phone_verified boolean not null default false,
  email_verified boolean not null default false,
  city_id uuid references public.cities(id) on delete set null,
  status text not null default 'active' check (status in ('active','blocked','deletion_requested','deleted')),
  status_reason text,
  is_suspicious boolean not null default false,
  suspicious_reason text,
  loyalty_tier text not null default 'standard' check (loyalty_tier in ('standard','silver','gold','platinum')),
  loyalty_points integer not null default 0,
  rating_avg numeric(3,2) not null default 0,
  rating_count integer not null default 0,
  referral_code text unique,
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_status_idx on public.customers(status);
create index customers_name_trgm on public.customers using gin (full_name extensions.gin_trgm_ops);
create index customers_created_idx on public.customers(created_at desc);

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  label text not null default 'other',
  address text not null,
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  created_at timestamptz not null default now()
);
create index customer_addresses_customer_idx on public.customer_addresses(customer_id);

create table public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  body text not null,
  staff_id uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index customer_notes_customer_idx on public.customer_notes(customer_id, created_at desc);
