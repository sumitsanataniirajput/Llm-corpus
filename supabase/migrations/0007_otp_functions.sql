-- =====================================================================
-- 0007_otp_functions.sql — ride OTP + booked-distance confirmation
--
-- Security model
--   * OTPs come from a CSPRNG (pgcrypto gen_random_bytes, rejection sampled).
--   * Only HMAC-SHA256(otp:booking, pepper||salt) is stored. The pepper lives
--     in the private schema which is not reachable through the API.
--   * The plaintext OTP is returned exactly once, to the service role only,
--     so the "otp" Edge Function can hand it to the SMS provider.
--   * Verification is a single atomic transaction with row locks. The
--     frontend can never authorise a ride start on its own.
-- =====================================================================

create or replace function public.otp_hash(p_otp text, p_booking_id uuid, p_salt text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select encode(extensions.hmac(p_otp || ':' || p_booking_id::text,
                (select value from private.secrets where key = 'otp_pepper') || p_salt, 'sha256'), 'hex');
$$;

create or replace function public.otp_random_digits(p_length integer) returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_mod bigint := power(10, p_length)::bigint; v_limit bigint; v bigint;
begin
  if p_length not between 4 and 8 then raise exception 'INVALID_OTP_LENGTH'; end if;
  v_limit := (4294967296 / v_mod) * v_mod;   -- rejection sampling removes modulo bias
  loop
    v := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when v < v_limit;
  end loop;
  return lpad((v % v_mod)::text, p_length, '0');
end $$;

create or replace function public.staff_has_permission(p_staff_id uuid, p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_accounts s join roles r on r.id = s.role_id
    where s.id = p_staff_id and s.status = 'active'
      and (r.code = 'super_admin' or exists (select 1 from role_permissions rp where rp.role_id = s.role_id and rp.permission_code = p_code)));
$$;

-- ---------------------------------------------------------------------
-- Issue (generate) an OTP.  SERVICE ROLE ONLY.
-- ---------------------------------------------------------------------
create or replace function public.otp_issue(p_booking_id uuid, p_generation_type text default 'auto', p_staff_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b bookings; c customers; last_otp ride_otps; v_otp text; v_salt text; v_id uuid;
  v_expiry integer := public.setting_int('otp.expiry_seconds', 300);
  v_max_attempts integer := public.setting_int('otp.max_attempts', 5);
  v_max_resends integer := public.setting_int('otp.max_resends', 3);
  v_gap integer := public.setting_int('otp.resend_gap_seconds', 30);
  v_resends integer;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  if p_generation_type not in ('auto','resend','manual') then raise exception 'INVALID_GENERATION_TYPE'; end if;
  if p_generation_type = 'manual' and not public.staff_has_permission(p_staff_id, 'otp.generate') then
    raise exception 'PERMISSION_DENIED: otp.generate' using errcode = '42501';
  end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if b.status not in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'status', b.status);
  end if;
  select * into last_otp from ride_otps where booking_id = p_booking_id order by created_at desc limit 1;
  if found then
    if p_generation_type = 'auto' and last_otp.status = 'active' and last_otp.expires_at > now() then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_ACTIVE', 'otp_id', last_otp.id, 'expires_at', last_otp.expires_at);
    end if;
    if p_generation_type <> 'manual' and last_otp.status = 'locked' and last_otp.locked_until > now() then
      return jsonb_build_object('ok', false, 'code', 'LOCKED', 'locked_until', last_otp.locked_until);
    end if;
    if p_generation_type = 'resend' then
      if last_otp.created_at > now() - make_interval(secs => v_gap) then
        return jsonb_build_object('ok', false, 'code', 'TOO_SOON', 'retry_after_seconds', v_gap);
      end if;
      select count(*) into v_resends from ride_otps where booking_id = p_booking_id and generation_type = 'resend';
      if v_resends >= v_max_resends then
        insert into otp_audit_logs(booking_id, event, actor_type, actor_id, details)
        values (p_booking_id, 'resend_limit_reached', case when p_staff_id is null then 'service' else 'staff' end, p_staff_id, jsonb_build_object('limit', v_max_resends));
        return jsonb_build_object('ok', false, 'code', 'RESEND_LIMIT', 'limit', v_max_resends);
      end if;
    end if;
    update ride_otps set status = 'invalidated', invalidated_reason = 'superseded'
    where booking_id = p_booking_id and status in ('active','locked');
  end if;

  v_otp := public.otp_random_digits(public.setting_int('otp.length', 6));
  v_salt := encode(extensions.gen_random_bytes(16), 'hex');
  insert into ride_otps(booking_id, otp_hash, salt, generation_type, generated_by_staff, expires_at, max_attempts)
  values (p_booking_id, public.otp_hash(v_otp, p_booking_id, v_salt), v_salt, p_generation_type, p_staff_id,
          now() + make_interval(secs => v_expiry), v_max_attempts)
  returning id into v_id;
  insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id, details)
  values (p_booking_id, v_id, 'otp_generated', case when p_staff_id is null then 'service' else 'staff' end, p_staff_id,
          jsonb_build_object('type', p_generation_type, 'expires_in_seconds', v_expiry));
  if p_staff_id is not null then
    perform public.write_audit('otp.generate_' || p_generation_type, 'bookings', p_booking_id::text, null, jsonb_build_object('otp_id', v_id), null, p_staff_id);
  end if;
  select * into c from customers where id = b.customer_id;
  -- Plaintext OTP leaves the database only here, only to the service role.
  return jsonb_build_object('ok', true, 'code', 'ISSUED', 'otp_id', v_id, 'otp', v_otp, 'expires_at', now() + make_interval(secs => v_expiry),
    'expiry_minutes', ceil(v_expiry / 60.0), 'phone', c.phone, 'customer_name', c.full_name, 'booking_code', b.booking_code);
end $$;

create or replace function public.mask_phone(p text) returns text
language sql immutable as $$
  select case when p is null then null when length(p) <= 4 then '****'
              else repeat('*', length(p) - 4) || right(p, 4) end;
$$;

create or replace function public.otp_record_delivery(
  p_otp_id uuid, p_channel text, p_provider text, p_status text, p_provider_message_id text default null,
  p_error text default null, p_delivery_type text default 'automatic', p_staff_id uuid default null, p_response jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare o ride_otps; v_phone text; v_id uuid; v_code text;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  select * into o from ride_otps where id = p_otp_id;
  if not found then raise exception 'OTP_NOT_FOUND'; end if;
  select c.phone, b.booking_code into v_phone, v_code from bookings b join customers c on c.id = b.customer_id where b.id = o.booking_id;
  insert into otp_delivery_logs(otp_id, booking_id, channel, provider, delivery_type, status, provider_message_id, phone_masked, error, initiated_by_staff, provider_response)
  values (p_otp_id, o.booking_id, p_channel, p_provider, p_delivery_type, p_status, p_provider_message_id, public.mask_phone(v_phone), left(p_error, 500), p_staff_id, p_response)
  returning id into v_id;
  insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id, details)
  values (o.booking_id, p_otp_id, 'delivery_' || p_status, case when p_staff_id is null then 'service' else 'staff' end, p_staff_id,
          jsonb_build_object('channel', p_channel, 'provider', p_provider, 'type', p_delivery_type));
  if p_status in ('failed','not_configured') then
    perform public.notify_staff('otp.view', 'otp', 'high', 'OTP delivery failed — ' || v_code,
      case when p_status = 'not_configured' then 'No SMS provider is configured, so the OTP was NOT delivered.' else 'The SMS provider reported a failure: ' || coalesce(left(p_error, 120), 'unknown error') end,
      jsonb_build_object('booking_id', o.booking_id, 'otp_id', p_otp_id));
  end if;
  return v_id;
end $$;

-- Delivery receipt (DLR) from the SMS provider webhook.
create or replace function public.otp_update_delivery_status(p_provider text, p_provider_message_id text, p_status text, p_error text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare l otp_delivery_logs;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  if p_status not in ('sent','delivered','failed') then raise exception 'INVALID_STATUS'; end if;
  select * into l from otp_delivery_logs where provider = p_provider and provider_message_id = p_provider_message_id for update;
  if not found then return false; end if;
  if l.status = 'delivered' then return true; end if;
  update otp_delivery_logs set status = p_status, error = left(p_error, 500), updated_at = now() where id = l.id;
  insert into otp_audit_logs(booking_id, otp_id, event, actor_type, details)
  values (l.booking_id, l.otp_id, 'delivery_' || p_status, 'service', jsonb_build_object('provider', p_provider, 'receipt', true));
  if p_status = 'failed' then
    perform public.notify_staff('otp.view', 'otp', 'high', 'OTP SMS not delivered', 'The provider reported a delivery failure: ' || coalesce(left(p_error, 120), 'unknown'),
      jsonb_build_object('booking_id', l.booking_id, 'otp_id', l.otp_id));
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- What the Driver App shows on its OTP screen (OTP.21, .24, .25).
-- ---------------------------------------------------------------------
create or replace function public.driver_otp_context(p_booking_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b bookings; v_driver uuid := public.current_driver_id(); v_name text;
begin
  if v_driver is null then raise exception 'NOT_A_DRIVER' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking_id;
  if not found or b.driver_id is distinct from v_driver then raise exception 'NOT_ASSIGNED_DRIVER' using errcode = '42501'; end if;
  select split_part(full_name, ' ', 1) into v_name from customers where id = b.customer_id;
  return jsonb_build_object('booking_id', b.id, 'booking_code', b.booking_code, 'status', b.status,
    'customer_first_name', v_name, 'pickup_address', b.pickup_address, 'drop_address', b.drop_address,
    'booked_distance_km', b.booked_distance_km, 'estimated_fare_paise', b.estimated_fare_paise, 'payment_method', b.payment_method,
    'otp_length', public.setting_int('otp.length', 6), 'ride_start_authorized', b.ride_start_authorized_at is not null);
end $$;

-- ---------------------------------------------------------------------
-- Verify.  Called by the assigned driver. Returns a result object instead of
-- raising, so every failed attempt is durably recorded.
-- ---------------------------------------------------------------------
create or replace function public.otp_verify(p_booking_id uuid, p_otp text, p_confirmed_distance_km numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_driver uuid := public.current_driver_id(); b bookings; o ride_otps;
  v_ip text := public.request_ip(); v_tol numeric; v_left integer; v_recent integer;
  v_lock integer := public.setting_int('otp.lockout_minutes', 15);
begin
  if v_driver is null then raise exception 'NOT_A_DRIVER' using errcode = '42501'; end if;
  if not public.check_rate_limit('otpverify:' || v_driver::text, 30, 600) then
    insert into otp_verification_attempts(booking_id, driver_id, result, is_suspicious, ip) values (p_booking_id, v_driver, 'rate_limited', true, v_ip);
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;

  if b.driver_id is distinct from v_driver then
    insert into otp_verification_attempts(booking_id, driver_id, result, is_suspicious, ip) values (p_booking_id, v_driver, 'not_assigned_driver', true, v_ip);
    insert into otp_audit_logs(booking_id, event, actor_type, actor_id, details)
    values (p_booking_id, 'suspicious_attempt', 'driver', v_driver, jsonb_build_object('reason', 'driver not assigned to this ride'));
    perform public.notify_staff('otp.view', 'otp', 'high', 'Suspicious OTP attempt — ' || b.booking_code,
      'A driver who is NOT assigned to this ride tried to submit its OTP.', jsonb_build_object('booking_id', p_booking_id, 'driver_id', v_driver));
    return jsonb_build_object('ok', false, 'code', 'NOT_ASSIGNED_DRIVER');
  end if;
  if b.status = 'CANCELLED' then
    insert into otp_verification_attempts(booking_id, driver_id, result, ip) values (p_booking_id, v_driver, 'cancelled', v_ip);
    return jsonb_build_object('ok', false, 'code', 'BOOKING_CANCELLED');
  end if;
  if b.status in ('OTP_VERIFIED','RIDE_STARTED','RIDE_COMPLETED','PAYMENT_PENDING','PAYMENT_COMPLETED','DISPUTED') then
    insert into otp_verification_attempts(booking_id, driver_id, result, ip) values (p_booking_id, v_driver, 'already_used', v_ip);
    return jsonb_build_object('ok', false, 'code', 'ALREADY_VERIFIED', 'ride_start_authorized', b.ride_start_authorized_at is not null);
  end if;
  if b.status <> 'OTP_PENDING' then
    insert into otp_verification_attempts(booking_id, driver_id, result, ip) values (p_booking_id, v_driver, 'invalid_state', v_ip);
    return jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'status', b.status, 'message', 'Mark arrival at pickup before entering the OTP.');
  end if;

  select * into o from ride_otps where booking_id = p_booking_id and status in ('active','locked') order by created_at desc limit 1 for update;
  if not found then
    insert into otp_verification_attempts(booking_id, driver_id, result, ip) values (p_booking_id, v_driver, 'no_active_otp', v_ip);
    return jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_OTP', 'message', 'Ask the customer to request a new OTP.');
  end if;
  if o.status = 'locked' then
    insert into otp_verification_attempts(otp_id, booking_id, driver_id, result, is_suspicious, ip)
    values (o.id, p_booking_id, v_driver, 'locked', o.locked_until > now(), v_ip);
    if o.locked_until > now() then
      return jsonb_build_object('ok', false, 'code', 'LOCKED', 'locked_until', o.locked_until);
    end if;
    -- Lockout has elapsed, but a locked OTP can never be reused: a fresh one is required.
    return jsonb_build_object('ok', false, 'code', 'NEW_OTP_REQUIRED', 'message', 'The lockout is over. Request a new OTP.');
  end if;
  if o.expires_at <= now() then
    update ride_otps set status = 'expired' where id = o.id;
    insert into otp_verification_attempts(otp_id, booking_id, driver_id, result, ip) values (o.id, p_booking_id, v_driver, 'expired', v_ip);
    insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id) values (p_booking_id, o.id, 'otp_expired', 'driver', v_driver);
    return jsonb_build_object('ok', false, 'code', 'EXPIRED', 'message', 'OTP expired. Request a new one.');
  end if;

  -- Distance confirmation against the SERVER's booked distance.
  v_tol := coalesce((public.get_setting('otp.distance_tolerance_km', '0.05'::jsonb) #>> '{}')::numeric, 0.05);
  if p_confirmed_distance_km is null or abs(p_confirmed_distance_km - b.booked_distance_km) > v_tol then
    insert into otp_verification_attempts(otp_id, booking_id, driver_id, result, submitted_distance_km, ip)
    values (o.id, p_booking_id, v_driver, 'distance_mismatch', p_confirmed_distance_km, v_ip);
    insert into distance_audit_logs(booking_id, event, actor_type, actor_id, details)
    values (p_booking_id, 'distance_confirmation_mismatch', 'driver', v_driver,
            jsonb_build_object('booked_km', b.booked_distance_km, 'submitted_km', p_confirmed_distance_km));
    if not exists (select 1 from ride_discrepancies where booking_id = p_booking_id and status = 'open' and discrepancy_type = 'distance_confirmation_mismatch') then
      insert into ride_discrepancies(booking_id, discrepancy_type, expected_km, reported_km, reported_by_driver)
      values (p_booking_id, 'distance_confirmation_mismatch', b.booked_distance_km, coalesce(p_confirmed_distance_km, 0), v_driver);
      perform public.notify_staff('otp.view', 'otp', 'high', 'Distance mismatch — ' || b.booking_code,
        'Driver confirmed ' || coalesce(p_confirmed_distance_km::text, 'nothing') || ' km but the booking says ' || b.booked_distance_km || ' km.',
        jsonb_build_object('booking_id', p_booking_id));
    end if;
    if public.setting_bool('otp.block_on_distance_mismatch', true) then
      return jsonb_build_object('ok', false, 'code', 'DISTANCE_MISMATCH', 'booked_distance_km', b.booked_distance_km,
        'message', 'The distance you confirmed does not match the booking. A manager has been alerted.');
    end if;
  end if;

  if p_otp is null or p_otp !~ '^[0-9]{4,8}$' or public.otp_hash(p_otp, p_booking_id, o.salt) <> o.otp_hash then
    update ride_otps set attempt_count = attempt_count + 1 where id = o.id returning attempt_count into o.attempt_count;
    v_left := greatest(o.max_attempts - o.attempt_count, 0);
    select count(*) into v_recent from otp_verification_attempts
    where driver_id = v_driver and result = 'incorrect_otp' and created_at > now() - interval '30 minutes';
    insert into otp_verification_attempts(otp_id, booking_id, driver_id, result, submitted_distance_km, is_suspicious, ip)
    values (o.id, p_booking_id, v_driver, 'incorrect_otp', p_confirmed_distance_km, (o.attempt_count >= 3 or v_recent >= 5), v_ip);
    insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id, details)
    values (p_booking_id, o.id, 'incorrect_otp', 'driver', v_driver, jsonb_build_object('attempt', o.attempt_count, 'remaining', v_left));
    if v_left = 0 then
      update ride_otps set status = 'locked', locked_until = now() + make_interval(mins => v_lock) where id = o.id;
      insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id, details)
      values (p_booking_id, o.id, 'otp_locked', 'system', null, jsonb_build_object('minutes', v_lock));
      perform public.notify_staff('otp.view', 'otp', 'high', 'OTP locked — ' || b.booking_code,
        'Maximum incorrect OTP attempts reached. Verification is locked for ' || v_lock || ' minutes.', jsonb_build_object('booking_id', p_booking_id));
      return jsonb_build_object('ok', false, 'code', 'LOCKED', 'locked_until', now() + make_interval(mins => v_lock), 'attempts_remaining', 0);
    elsif o.attempt_count = 3 then
      perform public.notify_staff('otp.view', 'otp', 'normal', 'Repeated incorrect OTP — ' || b.booking_code,
        'Three incorrect OTP attempts so far.', jsonb_build_object('booking_id', p_booking_id));
    end if;
    return jsonb_build_object('ok', false, 'code', 'INCORRECT_OTP', 'attempts_remaining', v_left);
  end if;

  -- All checks passed: one atomic commit.
  update ride_otps set status = 'verified', verified_at = now(), verified_by_driver = v_driver where id = o.id;
  perform public.set_actor('OTP verified by assigned driver');
  update bookings set status = 'OTP_VERIFIED', ride_start_authorized_at = now() where id = p_booking_id;
  update ride_distance_records set driver_confirmed_distance_km = p_confirmed_distance_km, driver_confirmed_at = now(),
    driver_confirmed_by = v_driver, updated_at = now() where booking_id = p_booking_id;
  insert into distance_audit_logs(booking_id, event, actor_type, actor_id, details)
  values (p_booking_id, 'distance_confirmed', 'driver', v_driver, jsonb_build_object('booked_km', b.booked_distance_km, 'confirmed_km', p_confirmed_distance_km));
  insert into otp_verification_attempts(otp_id, booking_id, driver_id, result, submitted_distance_km, ip)
  values (o.id, p_booking_id, v_driver, 'success', p_confirmed_distance_km, v_ip);
  insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id) values (p_booking_id, o.id, 'otp_verified', 'driver', v_driver);
  return jsonb_build_object('ok', true, 'code', 'VERIFIED', 'ride_start_authorized', true, 'verified_at', now());
end $$;

-- ---------------------------------------------------------------------
-- Exceptional manager override.  SERVICE ROLE ONLY: the "otp" Edge Function
-- first re-authenticates the manager's password, then calls this.
-- ---------------------------------------------------------------------
create or replace function public.otp_override(p_booking_id uuid, p_staff_id uuid, p_reason text, p_identity_confirmation text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bookings; o ride_otps; v_today integer; v_max integer := public.setting_int('otp.max_overrides_per_staff_per_day', 5); v_staff staff_accounts;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED: service role only' using errcode = '42501'; end if;
  if not public.staff_has_permission(p_staff_id, 'otp.override') then raise exception 'PERMISSION_DENIED: otp.override' using errcode = '42501'; end if;
  if coalesce(length(trim(p_reason)), 0) < 20 then raise exception 'REASON_REQUIRED: explain the exceptional circumstances (min 20 characters)'; end if;
  if coalesce(length(trim(p_identity_confirmation)), 0) < 10 then raise exception 'IDENTITY_CONFIRMATION_REQUIRED: record how the customer''s identity was confirmed'; end if;
  select * into v_staff from staff_accounts where id = p_staff_id;
  select count(*) into v_today from otp_audit_logs where event = 'manager_override' and actor_id = p_staff_id and created_at > now() - interval '24 hours';
  if v_today >= v_max then raise exception 'OVERRIDE_LIMIT: daily override limit reached for this manager'; end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if b.status <> 'OTP_PENDING' then raise exception 'INVALID_STATE: override is only possible while the ride is waiting for OTP (currently %)', b.status; end if;
  if b.driver_id is null then raise exception 'NO_DRIVER'; end if;
  select * into o from ride_otps where booking_id = p_booking_id order by created_at desc limit 1 for update;
  if not found then raise exception 'NO_OTP_HISTORY: generate and attempt normal OTP verification before overriding'; end if;
  update ride_otps set status = 'invalidated', invalidated_reason = 'manager_override' where booking_id = p_booking_id and status in ('active','locked') and id <> o.id;
  update ride_otps set status = 'overridden', override_by_staff = p_staff_id, override_reason = trim(p_reason), verified_at = now() where id = o.id;
  perform public.set_actor('OTP manager override: ' || trim(p_reason), p_staff_id);
  update bookings set status = 'OTP_VERIFIED', ride_start_authorized_at = now() where id = p_booking_id;
  insert into otp_audit_logs(booking_id, otp_id, event, actor_type, actor_id, details)
  values (p_booking_id, o.id, 'manager_override', 'staff', p_staff_id,
          jsonb_build_object('reason', trim(p_reason), 'identity_confirmation', trim(p_identity_confirmation), 'previous_otp_status', o.status));
  insert into distance_audit_logs(booking_id, event, actor_type, actor_id, details)
  values (p_booking_id, 'distance_not_driver_confirmed_override', 'staff', p_staff_id, jsonb_build_object('booked_km', b.booked_distance_km));
  perform public.write_audit('otp.manager_override', 'bookings', p_booking_id::text, null,
    jsonb_build_object('otp_id', o.id, 'identity_confirmation', trim(p_identity_confirmation)), trim(p_reason), p_staff_id);
  perform public.notify_staff('security.view', 'security', 'high', 'OTP override used — ' || b.booking_code,
    v_staff.full_name || ' overrode OTP verification. Reason: ' || left(trim(p_reason), 120), jsonb_build_object('booking_id', p_booking_id, 'staff_id', p_staff_id));
  return jsonb_build_object('ok', true, 'code', 'OVERRIDDEN', 'ride_start_authorized', true);
end $$;

-- ---------------------------------------------------------------------
-- Authorised distance correction workflow (OTP.29)
-- ---------------------------------------------------------------------
create or replace function public.resolve_distance_discrepancy(p_discrepancy_id uuid, p_action text, p_corrected_km numeric, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x ride_discrepancies; b bookings; dr ride_distance_records; v_fare jsonb; v_staff uuid := public.current_staff_id(); v_discount bigint;
begin
  perform public.require_permission('otp.correct_distance');
  if p_action not in ('correct','dismiss') then raise exception 'INVALID_ACTION'; end if;
  if coalesce(length(trim(p_reason)), 0) < 10 then raise exception 'REASON_REQUIRED: give a reason (min 10 characters)'; end if;
  select * into x from ride_discrepancies where id = p_discrepancy_id for update;
  if not found then raise exception 'DISCREPANCY_NOT_FOUND'; end if;
  if x.status <> 'open' then raise exception 'ALREADY_RESOLVED'; end if;
  select * into b from bookings where id = x.booking_id for update;
  select * into dr from ride_distance_records where booking_id = x.booking_id for update;

  if p_action = 'dismiss' then
    update ride_discrepancies set status = 'dismissed', resolution_reason = trim(p_reason), resolved_by = v_staff, resolved_at = now() where id = p_discrepancy_id;
  else
    if p_corrected_km is null or p_corrected_km < 0.1 or p_corrected_km > 2000 then raise exception 'INVALID_DISTANCE'; end if;
    perform public.set_actor('distance corrected: ' || trim(p_reason));
    if x.discrepancy_type = 'distance_confirmation_mismatch' then
      if b.status not in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING') then
        raise exception 'INVALID_STATE: the booked distance can only be corrected before the ride starts';
      end if;
      v_fare := public.fare_from_rule(b.pricing_snapshot, p_corrected_km, ceil(p_corrected_km / 25.0 * 60)::integer, 0,
                 (b.pricing_snapshot->>'priced_at')::timestamptz, b.pricing_snapshot->>'timezone', (b.pricing_snapshot->>'zone_surge_bp')::integer, b.discount_paise);
      -- original_booked_distance_km is intentionally left untouched.
      update ride_distance_records set booked_distance_km = round(p_corrected_km, 2), corrected_by = v_staff, corrected_at = now(),
        correction_reason = trim(p_reason), updated_at = now() where booking_id = b.id;
      update bookings set booked_distance_km = round(p_corrected_km, 2), distance_source = 'manual',
        estimated_fare_paise = (v_fare->>'total_fare_paise')::bigint, total_fare_paise = (v_fare->>'total_fare_paise')::bigint,
        fare_breakdown = v_fare where id = b.id;
    else
      if b.status not in ('PAYMENT_PENDING','DISPUTED') or exists (select 1 from payments where booking_id = b.id and status in ('captured','refunded','partially_refunded')) then
        raise exception 'INVALID_STATE: the billable distance can only be corrected before payment is captured';
      end if;
      v_discount := b.discount_paise;
      v_fare := public.fare_from_rule(b.pricing_snapshot, p_corrected_km, b.actual_duration_min, b.waiting_minutes, coalesce(b.started_at, now()),
                 b.pricing_snapshot->>'timezone', (b.pricing_snapshot->>'zone_surge_bp')::integer, v_discount);
      update ride_distance_records set final_billable_distance_km = round(p_corrected_km, 2), corrected_by = v_staff, corrected_at = now(),
        correction_reason = trim(p_reason), updated_at = now() where booking_id = b.id;
      update bookings set final_billable_distance_km = round(p_corrected_km, 2),
        base_fare_paise = (v_fare->>'base_fare_paise')::bigint, distance_fare_paise = (v_fare->>'distance_fare_paise')::bigint,
        time_fare_paise = (v_fare->>'time_fare_paise')::bigint, surcharge_paise = (v_fare->>'surcharge_paise')::bigint,
        discount_paise = (v_fare->>'discount_paise')::bigint, tax_paise = (v_fare->>'tax_paise')::bigint,
        total_fare_paise = (v_fare->>'total_fare_paise')::bigint, commission_paise = (v_fare->>'commission_paise')::bigint,
        driver_earning_paise = (v_fare->>'driver_earning_paise')::bigint, fare_breakdown = v_fare where id = b.id;
      update payments set amount_paise = greatest((v_fare->>'total_fare_paise')::bigint, 1), updated_at = now()
      where booking_id = b.id and status in ('created','pending');
    end if;
    update ride_discrepancies set status = 'corrected', corrected_km = round(p_corrected_km, 2), resolution_reason = trim(p_reason),
      resolved_by = v_staff, resolved_at = now() where id = p_discrepancy_id;
  end if;
  insert into distance_audit_logs(booking_id, event, actor_type, actor_id, details)
  values (b.id, 'discrepancy_' || case when p_action = 'correct' then 'corrected' else 'dismissed' end, 'staff', v_staff,
    jsonb_build_object('discrepancy_id', p_discrepancy_id, 'type', x.discrepancy_type, 'original_booked_km', dr.original_booked_distance_km,
      'previous_km', case when x.discrepancy_type = 'distance_confirmation_mismatch' then dr.booked_distance_km else dr.final_billable_distance_km end,
      'corrected_km', p_corrected_km, 'reason', trim(p_reason)));
  perform public.write_audit('distance.' || p_action, 'bookings', b.id::text,
    jsonb_build_object('booked_km', dr.booked_distance_km, 'billable_km', dr.final_billable_distance_km),
    jsonb_build_object('corrected_km', p_corrected_km, 'discrepancy_id', p_discrepancy_id), trim(p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- Mark timed-out OTPs as expired (pg_cron, every minute).
create or replace function public.otp_expire_sweep() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_count integer := 0;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  for r in update ride_otps set status = 'expired' where status = 'active' and expires_at <= now() returning id, booking_id loop
    insert into otp_audit_logs(booking_id, otp_id, event, actor_type) values (r.booking_id, r.id, 'otp_expired', 'system');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Console read models (never include hash or salt)
-- ---------------------------------------------------------------------
create or replace view public.ride_otp_overview as
select o.id, o.booking_id, b.booking_code, b.status as booking_status, b.city_id, o.status, o.generation_type,
       o.expires_at, o.attempt_count, o.max_attempts, o.locked_until, o.verified_at, o.override_by_staff, o.override_reason,
       o.invalidated_reason, o.created_at, b.booked_distance_km, b.pickup_address, b.drop_address, b.estimated_fare_paise,
       d.full_name as driver_name, d.driver_code, c.full_name as customer_name,
       (select l.status from otp_delivery_logs l where l.otp_id = o.id order by l.created_at desc limit 1) as last_delivery_status,
       (select count(*) from otp_delivery_logs l where l.otp_id = o.id) as delivery_count
from public.ride_otps o
join public.bookings b on b.id = o.booking_id
left join public.drivers d on d.id = b.driver_id
left join public.customers c on c.id = b.customer_id
where public.has_permission('otp.view') and public.staff_city_ok(b.city_id);

create or replace function public.otp_dashboard(p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := coalesce(p_from, date_trunc('day', now())); v_to timestamptz := coalesce(p_to, now()); v jsonb;
begin
  perform public.require_permission('otp.view');
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'generated', (select count(*) from ride_otps where created_at between v_from and v_to),
    'verified', (select count(*) from ride_otps where status = 'verified' and verified_at between v_from and v_to),
    'active', (select count(*) from ride_otps where status = 'active' and expires_at > now()),
    'expired', (select count(*) from ride_otps where (status = 'expired' or (status = 'active' and expires_at <= now())) and created_at between v_from and v_to),
    'locked', (select count(*) from ride_otps where status = 'locked' and created_at between v_from and v_to),
    'overridden', (select count(*) from ride_otps where status = 'overridden' and created_at between v_from and v_to),
    'manual_generated', (select count(*) from ride_otps where generation_type = 'manual' and created_at between v_from and v_to),
    'resent', (select count(*) from ride_otps where generation_type = 'resend' and created_at between v_from and v_to),
    'incorrect_attempts', (select count(*) from otp_verification_attempts where result = 'incorrect_otp' and created_at between v_from and v_to),
    'suspicious_attempts', (select count(*) from otp_verification_attempts where is_suspicious and created_at between v_from and v_to),
    'distance_mismatches', (select count(*) from otp_verification_attempts where result = 'distance_mismatch' and created_at between v_from and v_to),
    'open_discrepancies', (select count(*) from ride_discrepancies where status = 'open'),
    'deliveries', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from otp_delivery_logs where created_at between v_from and v_to group by status) s),
    'avg_seconds_to_verify', (select round(avg(extract(epoch from (verified_at - created_at)))) from ride_otps where status = 'verified' and verified_at between v_from and v_to),
    -- Rides whose driver accepted but for which NO OTP exists: the automatic pipeline is not working for these.
    'accepted_without_otp', (select count(*) from bookings b where b.status in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING')
        and not exists (select 1 from ride_otps o where o.booking_id = b.id)),
    'waiting_for_otp', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', b.id, 'booking_code', b.booking_code, 'status', b.status,
          'driver_name', d.full_name, 'customer_name', c.full_name, 'booked_distance_km', b.booked_distance_km,
          'pickup_address', b.pickup_address, 'drop_address', b.drop_address, 'estimated_fare_paise', b.estimated_fare_paise, 'accepted_at', b.accepted_at,
          'otp_status', (select o.status from ride_otps o where o.booking_id = b.id order by o.created_at desc limit 1),
          'otp_expires_at', (select o.expires_at from ride_otps o where o.booking_id = b.id order by o.created_at desc limit 1),
          'attempts', (select o.attempt_count from ride_otps o where o.booking_id = b.id order by o.created_at desc limit 1),
          'delivery_status', (select l.status from otp_delivery_logs l where l.booking_id = b.id order by l.created_at desc limit 1)
        ) order by b.accepted_at), '[]'::jsonb)
      from bookings b left join drivers d on d.id = b.driver_id left join customers c on c.id = b.customer_id
      where b.status in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING') and public.staff_city_ok(b.city_id))
  ) into v;
  return v;
end $$;
