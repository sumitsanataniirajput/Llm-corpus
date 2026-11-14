-- =====================================================================
-- 0011_rls_policies.sql — Row Level Security, grants, triggers,
-- Realtime publication, Storage buckets
--
-- Model: RLS is enabled on EVERY table in public. A table with no policy
-- is unreachable through the API. Staff policies are generated from the
-- matrix below; "self" policies for the future Driver / Customer apps
-- follow. All privileged writes go through SECURITY DEFINER functions.
-- =====================================================================

-- ---------- updated_at + audit triggers ----------
do $$
declare t record;
begin
  for t in select c.table_name from information_schema.columns c join information_schema.tables tb
             on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
           where c.table_schema = 'public' and c.column_name = 'updated_at' and c.table_name <> 'bookings' loop
    execute format('drop trigger if exists set_updated_at on public.%I', t.table_name);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t.table_name);
  end loop;
  for t in select unnest(array['drivers','vehicles','customers','staff_accounts','admin_users','role_permissions','roles','pricing_rules','coupons',
      'campaigns','system_settings','service_zones','cities','branches','vehicle_categories','category_city_availability','integration_settings',
      'ip_rules','data_retention_policies','driver_documents','vehicle_documents','vehicle_assignments','driver_incentives','expenses',
      'notification_templates','announcements','support_tickets','safety_incidents','referrals']) as table_name loop
    execute format('drop trigger if exists audit_row on public.%I', t.table_name);
    execute format('create trigger audit_row after insert or update or delete on public.%I for each row execute function public.tg_audit_row()', t.table_name);
  end loop;
end $$;

-- Keep driver / customer rating averages in step with reviews.
create or replace function public.tg_review_rating() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reviewer_type = 'customer' then
    update drivers set rating_count = rating_count + 1,
      rating_avg = round(((rating_avg * rating_count) + new.rating)::numeric / (rating_count + 1), 2) where id = new.driver_id;
  else
    update customers set rating_count = rating_count + 1,
      rating_avg = round(((rating_avg * rating_count) + new.rating)::numeric / (rating_count + 1), 2) where id = new.customer_id;
  end if;
  return new;
end $$;
create trigger reviews_rating after insert on public.reviews for each row execute function public.tg_review_rating();

-- ---------- enable RLS everywhere ----------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------- staff policy matrix ----------
-- read / write: permission code; "a|b" = either; "*staff" = any active staff; "*auth" = any signed-in user.
-- ops: which writes the write permission allows (i = insert, u = update, d = delete).
-- Tables with a city_id column are additionally restricted to the staff member's city scope.
do $$
declare
  m record; v_has_city boolean; v_read text; v_write text; v_city text;
begin
  for m in
    select * from (values
      ('cities','*staff','locations.manage','iu'),
      ('branches','*staff','settings.manage','iu'),
      ('service_zones','*staff','locations.manage','iud'),
      ('roles','*staff',null,''),
      ('permissions','*staff',null,''),
      ('role_permissions','*staff',null,''),
      ('audit_logs','audit.view',null,''),
      ('settings_history','settings.view',null,''),
      ('integration_settings','settings.view','integrations.manage','iu'),
      ('integration_events','settings.view',null,''),
      ('ip_rules','security.view','security.manage','iud'),
      ('api_keys','security.view',null,''),
      ('error_logs','security.view',null,''),
      ('backup_records','security.view','security.manage','i'),
      ('consent_records','security.view',null,''),
      ('data_retention_policies','security.view','security.manage','u'),
      ('vehicle_categories','*auth','services.manage','iu'),
      ('category_city_availability','*auth','services.manage','iud'),
      ('drivers','drivers.view','drivers.create','iu'),
      ('driver_documents','drivers.documents','drivers.create','i'),
      ('driver_verifications','drivers.view',null,''),
      ('driver_attendance','drivers.view',null,''),
      ('driver_notes','drivers.notes','drivers.notes','i'),
      ('driver_incentives','drivers.view','drivers.incentives','i'),
      ('vehicles','vehicles.view','vehicles.edit','iu'),
      ('vehicle_documents','vehicles.view','vehicles.edit','i'),
      ('vehicle_maintenance','vehicles.view','vehicles.edit','iud'),
      ('vehicle_assignments','vehicles.view',null,''),
      ('customers','customers.view_pii','customers.manage','iu'),
      ('customer_addresses','customers.view_pii',null,''),
      ('customer_notes','customers.notes','customers.notes','i'),
      ('pricing_rules','pricing.view','pricing.manage','iud'),
      ('pricing_history','pricing.view',null,''),
      ('bookings','rides.view',null,''),
      ('booking_stops','rides.view',null,''),
      ('booking_status_history','rides.view',null,''),
      ('driver_assignments','rides.view',null,''),
      ('ride_disputes','rides.view',null,''),
      ('reviews','rides.view|drivers.view',null,''),
      ('ride_routes','rides.view|tracking.view',null,''),
      ('ride_distance_records','rides.view|otp.view',null,''),
      ('ride_discrepancies','otp.view',null,''),
      ('distance_audit_logs','otp.view',null,''),
      ('otp_delivery_logs','otp.view',null,''),
      ('otp_verification_attempts','otp.view',null,''),
      ('otp_audit_logs','otp.view',null,''),
      ('driver_locations','tracking.view',null,''),
      ('driver_location_history','tracking.history',null,''),
      ('tracking_alerts','tracking.view',null,''),
      ('campaigns','marketing.view','marketing.manage','iud'),
      ('coupons','marketing.view','marketing.manage','iu'),
      ('coupon_redemptions','marketing.view',null,''),
      ('referrals','marketing.view','marketing.manage','u'),
      ('announcements','marketing.view','marketing.manage','iud'),
      ('payments','finance.view',null,''),
      ('payment_webhook_events','finance.view|settings.view',null,''),
      ('refunds','finance.view',null,''),
      ('driver_wallets','finance.view|drivers.view',null,''),
      ('customer_wallets','finance.view',null,''),
      ('wallet_transactions','finance.view',null,''),
      ('driver_payouts','finance.view',null,''),
      ('expenses','finance.view','finance.expenses','iud'),
      ('notification_templates','notifications.view','notifications.templates','iud'),
      ('notification_delivery_logs','notifications.view',null,''),
      ('support_tickets','support.view','support.manage','iu'),
      ('support_messages','support.view','support.manage','i'),
      ('safety_incidents','safety.view','safety.manage','iu'),
      ('evidence_files','safety.view|support.view','safety.manage|support.manage','i'),
      ('daily_reports','analytics.view',null,''),
      ('ai_insights','ai.view',null,''),
      ('data_import_jobs','settings.view',null,'')
    ) as t(tbl, read_perm, write_perm, ops)
  loop
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = m.tbl and column_name = 'city_id') into v_has_city;
    v_city := case when v_has_city then ' and public.staff_city_ok(city_id)' else '' end;
    select '(' || string_agg(case p when '*staff' then '(select public.current_staff_id()) is not null'
                                      when '*auth' then '(select auth.uid()) is not null'
                                      else format('(select public.has_permission(%L))', p) end, ' or ') || ')'
      into v_read from unnest(string_to_array(m.read_perm, '|')) p;
    execute format('drop policy if exists staff_read on public.%I', m.tbl);
    execute format('create policy staff_read on public.%I for select to authenticated using (%s%s)', m.tbl, v_read, v_city);
    if m.write_perm is not null then
      select '(' || string_agg(format('(select public.has_permission(%L))', p), ' or ') || ')' into v_write from unnest(string_to_array(m.write_perm, '|')) p;
      execute format('drop policy if exists staff_insert on public.%I', m.tbl);
      execute format('drop policy if exists staff_update on public.%I', m.tbl);
      execute format('drop policy if exists staff_delete on public.%I', m.tbl);
      if position('i' in m.ops) > 0 then
        execute format('create policy staff_insert on public.%I for insert to authenticated with check (%s%s)', m.tbl, v_write, v_city);
      end if;
      if position('u' in m.ops) > 0 then
        execute format('create policy staff_update on public.%I for update to authenticated using (%s%s) with check (%s%s)', m.tbl, v_write, v_city, v_write, v_city);
      end if;
      if position('d' in m.ops) > 0 then
        execute format('create policy staff_delete on public.%I for delete to authenticated using (%s%s)', m.tbl, v_write, v_city);
      end if;
    end if;
  end loop;
end $$;

-- ---------- policies that do not fit the matrix ----------
-- Staff directory: own row, or staff.view.
create policy staff_read on public.staff_accounts for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_permission('staff.view')));
create policy staff_read on public.admin_users for select to authenticated
  using (staff_id = (select public.current_staff_id()) or (select public.has_permission('staff.view')));
create policy staff_read on public.admin_sessions for select to authenticated
  using (staff_id = (select public.current_staff_id()) or (select public.has_permission('security.view')));
create policy staff_read on public.admin_activity_logs for select to authenticated
  using (staff_id = (select public.current_staff_id()) or (select public.has_permission('security.view')));
create policy staff_read on public.staff_activity for select to authenticated
  using (staff_id = (select public.current_staff_id()) or (select public.has_permission('staff.view')));
create policy staff_read on public.system_settings for select to authenticated
  using (is_public or (select public.has_permission('settings.view')));
create policy own_profile_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.has_permission('staff.view')));
create policy own_profile_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Notifications: a staff member sees their own; notifications.view sees the outbox.
create policy notifications_read on public.notifications for select to authenticated using (
  recipient_staff_id = (select public.current_staff_id())
  or (select public.has_permission('notifications.view'))
  or recipient_driver_id = (select public.current_driver_id())
  or recipient_customer_id = (select public.current_customer_id())
  or (audience = 'all_drivers' and (select public.current_driver_id()) is not null)
  or (audience = 'all_customers' and (select public.current_customer_id()) is not null));

create policy own_device_tokens on public.device_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Driver incentives may only be created in the pending state (crediting is an RPC).
drop policy if exists staff_insert on public.driver_incentives;
create policy staff_insert on public.driver_incentives for insert to authenticated
  with check ((select public.has_permission('drivers.incentives')) and status = 'pending' and credited_at is null);

-- ---------- future Driver App: self access ----------
create policy driver_self_read on public.drivers for select to authenticated using (user_id = (select auth.uid()));
create policy driver_self_docs_read on public.driver_documents for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_docs_insert on public.driver_documents for insert to authenticated
  with check (driver_id = (select public.current_driver_id()) and status = 'pending' and reviewed_by is null);
create policy driver_self_bookings on public.bookings for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_assignments on public.driver_assignments for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_vehicle on public.vehicle_assignments for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_location on public.driver_locations for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_wallet on public.driver_wallets for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_wallet_tx on public.wallet_transactions for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_payouts on public.driver_payouts for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_attendance on public.driver_attendance for select to authenticated using (driver_id = (select public.current_driver_id()));
create policy driver_self_tickets on public.support_tickets for select to authenticated using (driver_id = (select public.current_driver_id()) and raised_by_type = 'driver');
create policy driver_self_tickets_insert on public.support_tickets for insert to authenticated
  with check (driver_id = (select public.current_driver_id()) and raised_by_type = 'driver' and status = 'open' and assigned_staff_id is null);

-- ---------- future Customer App: self access ----------
create policy customer_self_read on public.customers for select to authenticated using (user_id = (select auth.uid()));
create policy customer_self_bookings on public.bookings for select to authenticated using (customer_id = (select public.current_customer_id()));
create policy customer_self_addresses on public.customer_addresses for all to authenticated
  using (customer_id = (select public.current_customer_id())) with check (customer_id = (select public.current_customer_id()));
create policy customer_self_wallet on public.customer_wallets for select to authenticated using (customer_id = (select public.current_customer_id()));
create policy customer_self_wallet_tx on public.wallet_transactions for select to authenticated using (customer_id = (select public.current_customer_id()));
create policy customer_self_tickets on public.support_tickets for select to authenticated using (customer_id = (select public.current_customer_id()) and raised_by_type = 'customer');
create policy customer_self_tickets_insert on public.support_tickets for insert to authenticated
  with check (customer_id = (select public.current_customer_id()) and raised_by_type = 'customer' and status = 'open' and assigned_staff_id is null);
-- A customer can follow the driver only while that driver is on THEIR active ride.
create policy customer_ride_driver_location on public.driver_locations for select to authenticated using (
  exists (select 1 from public.bookings b where b.id = driver_locations.booking_id and b.customer_id = (select public.current_customer_id())
          and b.status in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED')));
create policy customer_review_insert on public.reviews for insert to authenticated with check (
  reviewer_type = 'customer' and customer_id = (select public.current_customer_id())
  and exists (select 1 from public.bookings b where b.id = booking_id and b.customer_id = reviews.customer_id and b.driver_id = reviews.driver_id
              and b.status in ('PAYMENT_PENDING','PAYMENT_COMPLETED')));
create policy published_announcements on public.announcements for select to authenticated using (
  is_published and starts_at <= now() and (ends_at is null or ends_at > now()) and (
    audience = 'all'
    or (audience = 'drivers' and (select public.current_driver_id()) is not null)
    or (audience = 'customers' and (select public.current_customer_id()) is not null)
    or (audience = 'staff' and (select public.current_staff_id()) is not null)));
create policy consent_self_insert on public.consent_records for insert to authenticated with check (
  (subject_type = 'driver' and subject_id = (select public.current_driver_id()))
  or (subject_type = 'customer' and subject_id = (select public.current_customer_id())));

-- NOTE: ride_otps, rate_limits and the private schema deliberately have NO policies.

-- ---------- table grants ----------
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to authenticated, service_role;
revoke all on public.ride_otps, public.rate_limits from authenticated;
-- Defence in depth: these are written only by SECURITY DEFINER functions.
revoke insert, update, delete on public.bookings, public.payments, public.refunds, public.wallet_transactions, public.driver_wallets,
  public.customer_wallets, public.driver_payouts, public.booking_status_history, public.audit_logs, public.otp_audit_logs,
  public.otp_verification_attempts, public.otp_delivery_logs, public.ride_distance_records, public.payment_webhook_events from authenticated;

-- Column-level UPDATE: status / verification / money columns can only be
-- changed by the audited server functions, never by a direct table update.
revoke update on public.drivers, public.vehicles, public.customers, public.coupons, public.referrals,
  public.support_tickets, public.safety_incidents, public.data_retention_policies from authenticated;
grant update (full_name, phone, email, date_of_birth, gender, address_line, locality, pincode, city_id, branch_id, photo_path,
  aadhaar_last4, pan_masked, licence_masked, licence_expiry, police_verification_status, emergency_contact_name, emergency_contact_phone)
  on public.drivers to authenticated;
grant update (registration_number, category_id, ownership_type, owner_name, owner_phone, owner_driver_id, manufacturer, model,
  manufacture_year, color, fuel_type, seating_capacity, city_id, branch_id, odometer_km, gps_device_id, photos) on public.vehicles to authenticated;
grant update (full_name, phone, email, city_id, loyalty_tier) on public.customers to authenticated;
grant update (description, max_discount_paise, min_fare_paise, valid_from, valid_until, total_usage_limit, per_customer_limit, is_active, campaign_id)
  on public.coupons to authenticated;
grant update (status, reward_paise) on public.referrals to authenticated;
grant update (subject, description, priority, status, assigned_staff_id, resolution, resolved_at, item_description, item_status) on public.support_tickets to authenticated;
grant update (severity, status, description, investigation_notes, resolution, assigned_staff_id, acknowledged_at, resolved_at) on public.safety_incidents to authenticated;
grant update (retain_days, is_active) on public.data_retention_policies to authenticated;

grant select on public.ride_otp_overview, public.customer_directory to authenticated;

-- ---------- function grants ----------
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on function public.login_precheck(text), public.record_login_failure(text) to anon;
-- Internal / service-role-only functions are not callable by signed-in users.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'otp_issue','otp_record_delivery','otp_update_delivery_status','otp_override','otp_hash','otp_random_digits','otp_expire_sweep',
      'payment_attach_order','apply_payment_webhook','finish_refund','refund_gateway_result','settle_booking_payment','wallet_post',
      'create_staff_record','notification_dispatch_result','report_integration_status','log_integration_event','scan_tracking_health',
      'document_expiry_scan','run_scheduled_jobs','check_rate_limit','notify_staff','write_audit','set_actor','invalidate_ride_otp',
      'bootstrap_super_admin','coupon_discount','staff_has_permission','find_pricing_rule','get_setting','setting_int','setting_bool',
      'tg_audit_row','tg_audit_immutable','tg_booking_guard','tg_booking_history','tg_pricing_history','tg_review_rating')
  loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon;

-- ---------- Realtime ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['bookings','drivers','driver_locations','notifications','safety_incidents','tracking_alerts','payments',
        'otp_audit_logs','otp_verification_attempts','otp_delivery_logs','ride_discrepancies','support_tickets'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  else
    raise notice 'supabase_realtime publication not found — Realtime not configured (expected outside Supabase).';
  end if;
end $$;

-- ---------- Storage (private buckets + signed URLs) ----------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not found — skipping bucket setup (expected outside Supabase).';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
    ('driver-documents', 'driver-documents', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf']),
    ('vehicle-documents', 'vehicle-documents', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf']),
    ('evidence', 'evidence', false, 26214400, null),
    ('branding', 'branding', true, 2097152, array['image/jpeg','image/png','image/webp','image/svg+xml'])
  on conflict (id) do nothing;

  execute 'drop policy if exists rms_driver_docs_read on storage.objects';
  execute 'drop policy if exists rms_driver_docs_write on storage.objects';
  execute 'drop policy if exists rms_vehicle_docs_read on storage.objects';
  execute 'drop policy if exists rms_vehicle_docs_write on storage.objects';
  execute 'drop policy if exists rms_evidence_read on storage.objects';
  execute 'drop policy if exists rms_evidence_write on storage.objects';
  execute 'drop policy if exists rms_branding_write on storage.objects';
  -- Path convention: <driver_id>/<file>. A driver may read / upload only inside their own folder.
  execute $p$create policy rms_driver_docs_read on storage.objects for select to authenticated using (
    bucket_id = 'driver-documents' and (public.has_permission('drivers.documents') or (storage.foldername(name))[1] = public.current_driver_id()::text))$p$;
  execute $p$create policy rms_driver_docs_write on storage.objects for insert to authenticated with check (
    bucket_id = 'driver-documents' and (public.has_permission('drivers.create') or (storage.foldername(name))[1] = public.current_driver_id()::text))$p$;
  execute $p$create policy rms_vehicle_docs_read on storage.objects for select to authenticated using (
    bucket_id = 'vehicle-documents' and public.has_permission('vehicles.view'))$p$;
  execute $p$create policy rms_vehicle_docs_write on storage.objects for insert to authenticated with check (
    bucket_id = 'vehicle-documents' and public.has_permission('vehicles.edit'))$p$;
  execute $p$create policy rms_evidence_read on storage.objects for select to authenticated using (
    bucket_id = 'evidence' and (public.has_permission('safety.view') or public.has_permission('support.view')))$p$;
  execute $p$create policy rms_evidence_write on storage.objects for insert to authenticated with check (
    bucket_id = 'evidence' and (public.has_permission('safety.manage') or public.has_permission('support.manage')))$p$;
  execute $p$create policy rms_branding_write on storage.objects for insert to authenticated with check (
    bucket_id = 'branding' and public.has_permission('settings.manage'))$p$;
end $$;

-- ---------- pg_cron schedules (only if the extension is enabled) ----------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not enabled. Enable it, then run supabase/policies/schedule_jobs.sql.';
    return;
  end if;
  perform cron.schedule('rms-minute-jobs', '* * * * *', 'select public.run_scheduled_jobs()');
  perform cron.schedule('rms-daily-report', '35 19 * * *', 'select public.generate_daily_report()');       -- 01:05 IST
  perform cron.schedule('rms-document-expiry', '30 2 * * *', 'select public.document_expiry_scan()');      -- 08:00 IST
  perform cron.schedule('rms-retention', '0 21 * * *', 'select public.apply_retention()');                 -- 02:30 IST
  perform cron.schedule('rms-suspicious-customers', '15 * * * *', 'select public.detect_suspicious_customers()');
end $$;
