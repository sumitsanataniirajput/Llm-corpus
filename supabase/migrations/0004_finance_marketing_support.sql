-- =====================================================================
-- 0004_finance_marketing_support.sql
-- payments, wallets, payouts, coupons, campaigns, notifications,
-- support, safety, reports
-- =====================================================================

-- ---------------------------------------------------------------------
-- Marketing
-- ---------------------------------------------------------------------
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  campaign_type text not null check (campaign_type in ('coupon','referral','announcement','first_ride','driver_incentive')),
  audience text not null default 'customers' check (audience in ('customers','drivers','all')),
  city_id uuid references public.cities(id) on delete set null,
  budget_paise bigint not null default 0 check (budget_paise >= 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft','active','paused','ended')),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code) and length(code) between 3 and 24),
  description text,
  discount_type text not null check (discount_type in ('percent','fixed')),
  percent_bp integer check (percent_bp between 1 and 10000),
  fixed_paise bigint check (fixed_paise > 0),
  max_discount_paise bigint check (max_discount_paise > 0),
  min_fare_paise bigint not null default 0,
  first_ride_only boolean not null default false,
  city_id uuid references public.cities(id) on delete cascade,
  category_id uuid references public.vehicle_categories(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  total_usage_limit integer check (total_usage_limit > 0),
  per_customer_limit integer not null default 1 check (per_customer_limit > 0),
  used_count integer not null default 0,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((discount_type = 'percent' and percent_bp is not null) or (discount_type = 'fixed' and fixed_paise is not null))
);

alter table public.bookings add constraint bookings_coupon_fk
  foreign key (coupon_id) references public.coupons(id) on delete set null;

create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  discount_paise bigint not null,
  status text not null default 'applied' check (status in ('applied','released')),
  created_at timestamptz not null default now()
);
create index coupon_redemptions_lookup_idx on public.coupon_redemptions(coupon_id, customer_id) where status = 'applied';

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referral_kind text not null check (referral_kind in ('customer','driver')),
  referrer_customer_id uuid references public.customers(id) on delete cascade,
  referrer_driver_id uuid references public.drivers(id) on delete cascade,
  referee_customer_id uuid unique references public.customers(id) on delete cascade,
  referee_driver_id uuid unique references public.drivers(id) on delete cascade,
  code_used text not null,
  status text not null default 'pending' check (status in ('pending','qualified','rewarded','rejected')),
  reward_paise bigint not null default 0,
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  check ((referral_kind = 'customer' and referrer_customer_id is not null and referee_customer_id is not null)
      or (referral_kind = 'driver' and referrer_driver_id is not null and referee_driver_id is not null))
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null check (audience in ('drivers','customers','staff','all')),
  city_id uuid references public.cities(id) on delete set null,
  is_emergency boolean not null default false,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  is_published boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  txn_code text not null unique default public.next_code('TXN', 'public.txn_code_seq'),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  refunded_paise bigint not null default 0 check (refunded_paise >= 0),
  currency text not null default 'INR',
  method text not null check (method in ('cash','upi','card','netbanking','wallet')),
  status text not null default 'created' check (status in ('created','pending','captured','failed','refunded','partially_refunded')),
  provider text not null default 'none',
  provider_order_id text,
  provider_payment_id text,
  failure_reason text,
  idempotency_key text not null unique,
  recorded_by uuid,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refunded_paise <= amount_paise)
);
create index payments_booking_idx on public.payments(booking_id);
create index payments_status_idx on public.payments(status, created_at desc);
create index payments_created_idx on public.payments(created_at desc);
create unique index payments_provider_payment_idx on public.payments(provider, provider_payment_id) where provider_payment_id is not null;
create index payments_provider_order_idx on public.payments(provider_order_id) where provider_order_id is not null;
-- Only one successful payment per booking.
create unique index payments_one_capture_per_booking on public.payments(booking_id)
  where status in ('captured','refunded','partially_refunded');

create table public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text not null,
  signature_valid boolean not null,
  payload jsonb not null,
  processing_status text not null default 'received' check (processing_status in ('received','processed','ignored','failed')),
  processing_note text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)   -- webhook replay protection
);
create index payment_webhook_events_received_idx on public.payment_webhook_events(received_at desc);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  txn_code text not null unique default public.next_code('RFD', 'public.txn_code_seq'),
  payment_id uuid not null references public.payments(id) on delete restrict,
  booking_id uuid not null references public.bookings(id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null default 'INR',
  reason text not null,
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  provider_refund_id text,
  failure_reason text,
  idempotency_key text not null unique,
  requested_by uuid references public.staff_accounts(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index refunds_payment_idx on public.refunds(payment_id);
create index refunds_status_idx on public.refunds(status, created_at desc);

create table public.driver_wallets (
  driver_id uuid primary key references public.drivers(id) on delete cascade,
  balance_paise bigint not null default 0,   -- negative = driver owes commission on cash rides
  updated_at timestamptz not null default now()
);

create table public.customer_wallets (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  balance_paise bigint not null default 0 check (balance_paise >= 0),
  updated_at timestamptz not null default now()
);

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_code text not null unique default public.next_code('WTX', 'public.txn_code_seq'),
  owner_type text not null check (owner_type in ('driver','customer')),
  driver_id uuid references public.drivers(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  direction text not null check (direction in ('credit','debit')),
  amount_paise bigint not null check (amount_paise > 0),
  balance_after_paise bigint not null,
  reason text not null check (reason in ('ride_earning','cash_commission','payout','incentive','refund',
    'ride_payment','referral_reward','adjustment','topup')),
  booking_id uuid references public.bookings(id) on delete set null,
  reference text,
  idempotency_key text not null unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((owner_type = 'driver' and driver_id is not null) or (owner_type = 'customer' and customer_id is not null))
);
create index wallet_tx_driver_idx on public.wallet_transactions(driver_id, created_at desc);
create index wallet_tx_customer_idx on public.wallet_transactions(customer_id, created_at desc);

create table public.driver_payouts (
  id uuid primary key default gen_random_uuid(),
  txn_code text not null unique default public.next_code('PAY', 'public.txn_code_seq'),
  driver_id uuid not null references public.drivers(id) on delete restrict,
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('pending','approved','paid','failed','cancelled')),
  method text not null default 'bank_transfer' check (method in ('bank_transfer','upi','cash')),
  provider_reference text,
  failure_reason text,
  idempotency_key text not null unique,
  requested_by uuid references public.staff_accounts(id) on delete set null,
  approved_by uuid references public.staff_accounts(id) on delete set null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index driver_payouts_driver_idx on public.driver_payouts(driver_id, created_at desc);
create index driver_payouts_status_idx on public.driver_payouts(status, created_at desc);

-- Operating expenses (for profit & loss).
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('salary','rent','marketing','technology','fuel','maintenance','gateway_fees','sms','other')),
  description text not null,
  amount_paise bigint not null check (amount_paise > 0),
  incurred_on date not null default current_date,
  city_id uuid references public.cities(id) on delete set null,
  branch_id uuid references public.branches(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index expenses_date_idx on public.expenses(incurred_on desc);

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  channel text not null check (channel in ('sms','push','email','whatsapp','in_app')),
  title text,
  body text not null,
  dlt_template_id text,   -- required by Indian telecom rules for SMS
  is_active boolean not null default true,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (code, channel)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('staff','driver','customer','all_drivers','all_customers','all_staff')),
  recipient_staff_id uuid references public.staff_accounts(id) on delete cascade,
  recipient_driver_id uuid references public.drivers(id) on delete cascade,
  recipient_customer_id uuid references public.customers(id) on delete cascade,
  city_id uuid references public.cities(id) on delete set null,
  category text not null default 'system' check (category in ('booking','payment','document','approval',
    'emergency','otp','tracking','system','announcement','support','security')),
  priority text not null default 'normal' check (priority in ('normal','high','emergency')),
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  channels text[] not null default '{in_app}',
  dispatch_status text not null default 'pending' check (dispatch_status in ('pending','dispatched','partial','failed','in_app_only')),
  read_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index notifications_staff_idx on public.notifications(recipient_staff_id, created_at desc);
create index notifications_audience_idx on public.notifications(audience, created_at desc);
create index notifications_pending_idx on public.notifications(created_at) where dispatch_status = 'pending';

create table public.notification_delivery_logs (
  id bigint generated always as identity primary key,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('sms','push','email','whatsapp','in_app')),
  provider text not null,
  status text not null check (status in ('sent','delivered','failed','not_configured','skipped')),
  recipients_count integer not null default 1,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);
create index notification_delivery_logs_n_idx on public.notification_delivery_logs(notification_id);
create index notification_delivery_logs_created_idx on public.notification_delivery_logs(created_at desc);

create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  app text not null check (app in ('manager','driver','customer')),
  platform text not null check (platform in ('android','ios','web')),
  token text not null unique,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index device_tokens_user_idx on public.device_tokens(user_id);

-- ---------------------------------------------------------------------
-- Support & safety
-- ---------------------------------------------------------------------
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_code text not null unique default public.next_code('TKT', 'public.ticket_code_seq'),
  ticket_type text not null check (ticket_type in ('customer_complaint','driver_complaint','support','lost_and_found','fraud_report','dispute')),
  raised_by_type text not null check (raised_by_type in ('customer','driver','staff')),
  customer_id uuid references public.customers(id) on delete set null,
  driver_id uuid references public.drivers(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  subject text not null,
  description text not null,
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  assigned_staff_id uuid references public.staff_accounts(id) on delete set null,
  resolution text,
  resolved_at timestamptz,
  item_description text,           -- lost & found
  item_status text check (item_status in ('reported','found','returned','not_found')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('resolved','closed') or resolution is not null)
);
create index support_tickets_status_idx on public.support_tickets(status, priority, created_at desc);
create index support_tickets_assigned_idx on public.support_tickets(assigned_staff_id, status);
create index support_tickets_customer_idx on public.support_tickets(customer_id, created_at desc);
create index support_tickets_driver_idx on public.support_tickets(driver_id, created_at desc);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  sender_type text not null check (sender_type in ('staff','customer','driver','system')),
  sender_id uuid,
  body text not null,
  is_internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index support_messages_ticket_idx on public.support_messages(ticket_id, created_at);

create table public.safety_incidents (
  id uuid primary key default gen_random_uuid(),
  incident_code text not null unique default public.next_code('INC', 'public.ticket_code_seq'),
  incident_type text not null check (incident_type in ('sos','accident','harassment','theft','medical','vehicle_breakdown','other')),
  severity text not null default 'high' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','acknowledged','investigating','resolved','false_alarm')),
  booking_id uuid references public.bookings(id) on delete set null,
  driver_id uuid references public.drivers(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  reported_by_type text not null check (reported_by_type in ('customer','driver','staff','system')),
  lat numeric(9,6),
  lng numeric(9,6),
  description text,
  investigation_notes text,
  resolution text,
  assigned_staff_id uuid references public.staff_accounts(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index safety_incidents_open_idx on public.safety_incidents(created_at desc) where status in ('open','acknowledged','investigating');
create index safety_incidents_type_idx on public.safety_incidents(incident_type, created_at desc);

create table public.evidence_files (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references public.safety_incidents(id) on delete cascade,
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  check (incident_id is not null or ticket_id is not null)
);

-- ---------------------------------------------------------------------
-- Reports & insights
-- ---------------------------------------------------------------------
create table public.daily_reports (
  report_date date not null,
  city_id uuid references public.cities(id) on delete cascade,
  payload jsonb not null,
  generated_at timestamptz not null default now()
);
create unique index daily_reports_unique on public.daily_reports(report_date, coalesce(city_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Output of optional AI / statistical jobs. Always labelled as estimates.
create table public.ai_insights (
  id uuid primary key default gen_random_uuid(),
  insight_type text not null,
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  source text not null check (source in ('statistical','llm')),
  model text,
  requested_by uuid,
  created_at timestamptz not null default now()
);
create index ai_insights_created_idx on public.ai_insights(created_at desc);

create table public.data_import_jobs (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('drivers','vehicles','customers')),
  file_name text,
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  failed_rows integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);
