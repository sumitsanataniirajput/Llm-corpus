-- =====================================================================
-- 0003_rides.sql — pricing, bookings, assignments, GPS, OTP, distance
-- =====================================================================

-- Multipliers / percentages use basis points (10000 bp = 1.00x = 100%).
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.vehicle_categories(id) on delete cascade,
  city_id uuid not null references public.cities(id) on delete cascade,
  zone_id uuid references public.service_zones(id) on delete cascade,  -- NULL = whole city
  base_fare_paise bigint not null check (base_fare_paise >= 0),
  per_km_paise bigint not null check (per_km_paise >= 0),
  per_minute_paise bigint not null default 0 check (per_minute_paise >= 0),
  minimum_fare_paise bigint not null default 0 check (minimum_fare_paise >= 0),
  free_waiting_minutes integer not null default 3 check (free_waiting_minutes >= 0),
  waiting_per_minute_paise bigint not null default 0 check (waiting_per_minute_paise >= 0),
  cancellation_fee_paise bigint not null default 0 check (cancellation_fee_paise >= 0),
  night_start time not null default '22:00',
  night_end time not null default '06:00',
  night_multiplier_bp integer not null default 10000 check (night_multiplier_bp between 10000 and 50000),
  -- [{"days":[1,2,3,4,5],"start":"08:00","end":"11:00","multiplier_bp":12500}]  (1 = Monday)
  peak_windows jsonb not null default '[]'::jsonb,
  surge_multiplier_bp integer not null default 10000 check (surge_multiplier_bp between 10000 and 50000),
  commission_bp integer not null default 2000 check (commission_bp between 0 and 10000),
  gst_bp integer not null default 500 check (gst_bp between 0 and 10000),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create index pricing_rules_lookup_idx on public.pricing_rules(city_id, category_id, effective_from desc) where is_active;

create table public.pricing_history (
  id bigint generated always as identity primary key,
  pricing_rule_id uuid,
  change_type text not null check (change_type in ('created','updated','deactivated','deleted')),
  old_data jsonb,
  new_data jsonb,
  changed_by uuid,
  created_at timestamptz not null default now()
);
create index pricing_history_rule_idx on public.pricing_history(pricing_rule_id, created_at desc);

-- Forward declaration target for bookings.coupon_id (table created in 0004).
-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------
create type public.booking_status as enum (
  'BOOKING_CREATED','DRIVER_SEARCHING','DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING',
  'DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED','RIDE_COMPLETED',
  'PAYMENT_PENDING','PAYMENT_COMPLETED','CANCELLED','DISPUTED');

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_code text not null unique default public.next_code('BKG', 'public.booking_code_seq'),
  customer_id uuid not null references public.customers(id) on delete restrict,
  driver_id uuid references public.drivers(id) on delete restrict,
  vehicle_id uuid references public.vehicles(id) on delete restrict,
  category_id uuid not null references public.vehicle_categories(id) on delete restrict,
  city_id uuid not null references public.cities(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete set null,
  status public.booking_status not null default 'BOOKING_CREATED',
  status_before_dispute public.booking_status,
  pickup_address text not null,
  pickup_lat numeric(9,6) not null check (pickup_lat between -90 and 90),
  pickup_lng numeric(9,6) not null check (pickup_lng between -180 and 180),
  drop_address text not null,
  drop_lat numeric(9,6) not null check (drop_lat between -90 and 90),
  drop_lng numeric(9,6) not null check (drop_lng between -180 and 180),
  scheduled_for timestamptz,
  -- Distance values are deliberately kept separate (see ride_distance_records).
  booked_distance_km numeric(8,2) not null check (booked_distance_km >= 0),
  estimated_route_distance_km numeric(8,2),
  actual_distance_km numeric(8,2),
  final_billable_distance_km numeric(8,2),
  distance_source text not null default 'haversine_estimate' check (distance_source in ('google_routes','haversine_estimate','manual')),
  estimated_duration_min integer,
  actual_duration_min integer,
  waiting_minutes integer not null default 0,
  -- Fare (paise)
  estimated_fare_paise bigint not null default 0,
  base_fare_paise bigint not null default 0,
  distance_fare_paise bigint not null default 0,
  time_fare_paise bigint not null default 0,
  waiting_fare_paise bigint not null default 0,
  surcharge_paise bigint not null default 0,
  discount_paise bigint not null default 0,
  tax_paise bigint not null default 0,
  total_fare_paise bigint not null default 0,
  commission_paise bigint not null default 0,
  driver_earning_paise bigint not null default 0,
  cancellation_fee_paise bigint not null default 0,
  -- Exact pricing configuration applied, so historical fares stay explainable.
  pricing_snapshot jsonb not null default '{}'::jsonb,
  fare_breakdown jsonb not null default '{}'::jsonb,
  coupon_id uuid,
  payment_method text not null default 'cash' check (payment_method in ('cash','upi','card','netbanking','wallet')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','pending','paid','failed','refunded','partially_refunded')),
  cancelled_by text check (cancelled_by in ('customer','driver','staff','system')),
  cancellation_reason text,
  is_emergency boolean not null default false,
  created_via text not null default 'customer_app' check (created_via in ('customer_app','manager_console','api')),
  created_by_staff uuid references public.staff_accounts(id) on delete set null,
  ride_start_authorized_at timestamptz,
  assigned_at timestamptz,
  accepted_at timestamptz,
  arrived_at timestamptz,
  otp_verified_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookings_status_idx on public.bookings(status, created_at desc);
create index bookings_created_idx on public.bookings(created_at desc);
create index bookings_customer_idx on public.bookings(customer_id, created_at desc);
create index bookings_driver_idx on public.bookings(driver_id, created_at desc);
create index bookings_city_idx on public.bookings(city_id, created_at desc);
create index bookings_completed_idx on public.bookings(completed_at) where completed_at is not null;
-- A driver / vehicle can only be on ONE active ride at a time.
create unique index bookings_one_active_per_driver on public.bookings(driver_id)
  where driver_id is not null and status in ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING',
    'DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED');
create unique index bookings_one_active_per_vehicle on public.bookings(vehicle_id)
  where vehicle_id is not null and status in ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING',
    'DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED');

create table public.booking_stops (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  stop_order integer not null,
  address text not null,
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  reached_at timestamptz,
  unique (booking_id, stop_order)
);

create table public.booking_status_history (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  from_status public.booking_status,
  to_status public.booking_status not null,
  actor_type text not null default 'system',
  actor_id uuid,
  reason text,
  created_at timestamptz not null default now()
);
create index booking_status_history_booking_idx on public.booking_status_history(booking_id, created_at);

create table public.driver_assignments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  assignment_type text not null check (assignment_type in ('auto','manual','reassign')),
  status text not null default 'offered' check (status in ('offered','accepted','rejected','superseded','cancelled')),
  reason text,
  assigned_by uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create index driver_assignments_booking_idx on public.driver_assignments(booking_id, created_at desc);
create index driver_assignments_driver_idx on public.driver_assignments(driver_id, created_at desc);

create table public.ride_disputes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  raised_by_type text not null check (raised_by_type in ('customer','driver','staff')),
  category text not null check (category in ('fare','distance','behaviour','payment','safety','other')),
  description text not null,
  status text not null default 'open' check (status in ('open','investigating','resolved','rejected')),
  resolution text,
  opened_by uuid,
  resolved_by uuid references public.staff_accounts(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ride_disputes_booking_idx on public.ride_disputes(booking_id);
create index ride_disputes_status_idx on public.ride_disputes(status, created_at desc);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  reviewer_type text not null check (reviewer_type in ('customer','driver')),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (booking_id, reviewer_type)
);
create index reviews_driver_idx on public.reviews(driver_id, created_at desc);
create index reviews_customer_idx on public.reviews(customer_id, created_at desc);

-- ---------------------------------------------------------------------
-- GPS
-- ---------------------------------------------------------------------
-- Latest position: exactly one row per driver (cheap to broadcast via Realtime).
create table public.driver_locations (
  driver_id uuid primary key references public.drivers(id) on delete cascade,
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  speed_kmh numeric(6,2),
  heading numeric(5,2),
  accuracy_m numeric(8,2),
  battery_pct integer,
  booking_id uuid references public.bookings(id) on delete set null,
  is_sharing boolean not null default true,
  gps_status text not null default 'ok' check (gps_status in ('ok','weak','disabled','permission_denied')),
  recorded_at timestamptz not null,      -- device clock
  received_at timestamptz not null default now()  -- server clock (source of truth for freshness)
);
create index driver_locations_received_idx on public.driver_locations(received_at desc);

-- Thinned breadcrumb trail. High volume: BRIN on time + composite btree.
create table public.driver_location_history (
  id bigint generated always as identity primary key,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  speed_kmh numeric(6,2),
  heading numeric(5,2),
  accuracy_m numeric(8,2),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (driver_id, recorded_at)  -- duplicate location events are dropped
);
create index dlh_booking_idx on public.driver_location_history(booking_id, recorded_at) where booking_id is not null;
create index dlh_received_brin on public.driver_location_history using brin (received_at);

create table public.tracking_alerts (
  id bigint generated always as identity primary key,
  driver_id uuid references public.drivers(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  zone_id uuid references public.service_zones(id) on delete set null,
  alert_type text not null check (alert_type in ('restricted_zone_entry','outside_service_area','stale_location',
    'gps_disabled','overspeed','location_sharing_stopped','route_deviation')),
  message text not null,
  lat numeric(9,6),
  lng numeric(9,6),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.staff_accounts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index tracking_alerts_open_idx on public.tracking_alerts(created_at desc) where acknowledged_at is null;
create index tracking_alerts_driver_idx on public.tracking_alerts(driver_id, alert_type, created_at desc);

create table public.ride_routes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  route_kind text not null check (route_kind in ('planned','actual')),
  encoded_polyline text,
  distance_km numeric(8,2),
  duration_min integer,
  provider text,
  created_at timestamptz not null default now(),
  unique (booking_id, route_kind)
);

-- ---------------------------------------------------------------------
-- Distance bookkeeping (booked vs estimated vs actual vs billable)
-- ---------------------------------------------------------------------
create table public.ride_distance_records (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  original_booked_distance_km numeric(8,2) not null,   -- never changes
  booked_distance_km numeric(8,2) not null,            -- may be corrected through the audited workflow
  estimated_route_distance_km numeric(8,2),
  driver_confirmed_distance_km numeric(8,2),
  driver_confirmed_at timestamptz,
  driver_confirmed_by uuid references public.drivers(id) on delete set null,
  actual_distance_km numeric(10,3) not null default 0,  -- accumulated from GPS in metres precision
  final_billable_distance_km numeric(8,2),
  corrected_by uuid references public.staff_accounts(id) on delete set null,
  corrected_at timestamptz,
  correction_reason text,
  updated_at timestamptz not null default now()
);

create table public.ride_discrepancies (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  discrepancy_type text not null check (discrepancy_type in ('distance_confirmation_mismatch','actual_vs_booked_distance')),
  expected_km numeric(8,2) not null,
  reported_km numeric(8,2) not null,
  reported_by_driver uuid references public.drivers(id) on delete set null,
  status text not null default 'open' check (status in ('open','corrected','dismissed')),
  corrected_km numeric(8,2),
  resolution_reason text,
  resolved_by uuid references public.staff_accounts(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index ride_discrepancies_booking_idx on public.ride_discrepancies(booking_id);
create index ride_discrepancies_open_idx on public.ride_discrepancies(created_at desc) where status = 'open';

-- Append-only audit of every distance confirmation / correction event.
create table public.distance_audit_logs (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event text not null,
  actor_type text not null,
  actor_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index distance_audit_booking_idx on public.distance_audit_logs(booking_id, created_at);

-- ---------------------------------------------------------------------
-- Ride OTP
-- ---------------------------------------------------------------------
-- NOTE: the OTP itself is never stored. Only an HMAC-SHA256 hash keyed with a
-- per-OTP salt and a private server pepper. No API role can read this table
-- directly; the console uses the ride_otp_overview view (no hash columns).
create table public.ride_otps (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  otp_hash text not null,
  salt text not null,
  status text not null default 'active' check (status in ('active','verified','expired','invalidated','locked','overridden')),
  generation_type text not null check (generation_type in ('auto','resend','manual')),
  generated_by_staff uuid references public.staff_accounts(id) on delete set null,
  expires_at timestamptz not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  locked_until timestamptz,
  verified_at timestamptz,
  verified_by_driver uuid references public.drivers(id) on delete set null,
  override_by_staff uuid references public.staff_accounts(id) on delete set null,
  override_reason text,
  invalidated_reason text,
  created_at timestamptz not null default now()
);
create unique index ride_otps_one_active on public.ride_otps(booking_id) where status = 'active';
create index ride_otps_booking_idx on public.ride_otps(booking_id, created_at desc);
create index ride_otps_created_idx on public.ride_otps(created_at desc);

create table public.otp_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  otp_id uuid not null references public.ride_otps(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  channel text not null check (channel in ('sms','whatsapp','voice')),
  provider text not null,
  delivery_type text not null default 'automatic' check (delivery_type in ('automatic','resend','manual')),
  status text not null default 'queued' check (status in ('queued','sent','delivered','failed','not_configured')),
  provider_message_id text,
  phone_masked text,
  error text,
  initiated_by_staff uuid references public.staff_accounts(id) on delete set null,
  provider_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index otp_delivery_logs_booking_idx on public.otp_delivery_logs(booking_id, created_at desc);
create index otp_delivery_logs_status_idx on public.otp_delivery_logs(status, created_at desc);
create index otp_delivery_logs_msg_idx on public.otp_delivery_logs(provider_message_id) where provider_message_id is not null;

create table public.otp_verification_attempts (
  id bigint generated always as identity primary key,
  otp_id uuid references public.ride_otps(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  driver_id uuid references public.drivers(id) on delete set null,
  result text not null check (result in ('success','incorrect_otp','expired','locked','not_assigned_driver',
    'invalid_state','cancelled','already_used','distance_mismatch','no_active_otp','rate_limited')),
  submitted_distance_km numeric(8,2),
  is_suspicious boolean not null default false,
  ip text,
  created_at timestamptz not null default now()
);
create index otp_attempts_booking_idx on public.otp_verification_attempts(booking_id, created_at desc);
create index otp_attempts_created_idx on public.otp_verification_attempts(created_at desc);
create index otp_attempts_suspicious_idx on public.otp_verification_attempts(created_at desc) where is_suspicious;

create table public.otp_audit_logs (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  otp_id uuid,
  event text not null,
  actor_type text not null check (actor_type in ('system','staff','driver','service')),
  actor_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index otp_audit_booking_idx on public.otp_audit_logs(booking_id, created_at);
create index otp_audit_created_idx on public.otp_audit_logs(created_at desc);

create trigger otp_audit_immutable before update or delete on public.otp_audit_logs
for each row execute function public.tg_audit_immutable();
create trigger distance_audit_immutable before update or delete on public.distance_audit_logs
for each row execute function public.tg_audit_immutable();
