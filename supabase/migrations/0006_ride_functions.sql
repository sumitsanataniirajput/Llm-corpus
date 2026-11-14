-- =====================================================================
-- 0006_ride_functions.sql — geo helpers, pricing, booking state machine,
-- assignment, ride lifecycle, GPS ingestion
-- =====================================================================

create or replace function public.haversine_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) returns numeric
language sql immutable as $$
  select round((2 * 6371.0088 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::float8) / 2), 2) +
    cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lng2 - lng1)::float8) / 2), 2)
  )))::numeric, 3);
$$;

-- Ray-casting point-in-polygon over a JSON array of {lat,lng} vertices.
create or replace function public.point_in_polygon(p_lat numeric, p_lng numeric, p_polygon jsonb) returns boolean
language plpgsql immutable as $$
declare
  n integer := coalesce(jsonb_array_length(p_polygon), 0);
  i integer; j integer; inside boolean := false;
  xi numeric; yi numeric; xj numeric; yj numeric;
begin
  if n < 3 then return false; end if;
  j := n - 1;
  for i in 0 .. n - 1 loop
    xi := (p_polygon->i->>'lng')::numeric; yi := (p_polygon->i->>'lat')::numeric;
    xj := (p_polygon->j->>'lng')::numeric; yj := (p_polygon->j->>'lat')::numeric;
    if ((yi > p_lat) <> (yj > p_lat)) and (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

create or replace function public.zone_at(p_city_id uuid, p_lat numeric, p_lng numeric, p_types text[]) returns uuid
language sql stable security definer set search_path = public as $$
  select z.id from service_zones z
  where z.city_id = p_city_id and z.is_active and z.zone_type = any (p_types)
    and public.point_in_polygon(p_lat, p_lng, z.polygon)
  order by z.surge_multiplier_bp desc, z.created_at limit 1;
$$;

-- ---------------------------------------------------------------------
-- Pricing (integer paise; all arithmetic is exact numeric, never float)
-- ---------------------------------------------------------------------
create or replace function public.find_pricing_rule(p_category_id uuid, p_city_id uuid, p_at timestamptz, p_lat numeric, p_lng numeric)
returns public.pricing_rules
language sql stable security definer set search_path = public as $$
  select r.* from pricing_rules r
  left join service_zones z on z.id = r.zone_id
  where r.category_id = p_category_id and r.city_id = p_city_id and r.is_active
    and r.effective_from <= p_at and (r.effective_to is null or r.effective_to > p_at)
    and (r.zone_id is null or (p_lat is not null and z.is_active and public.point_in_polygon(p_lat, p_lng, z.polygon)))
  order by (r.zone_id is not null) desc, r.effective_from desc
  limit 1;
$$;

create or replace function public.fare_from_rule(
  p_rule jsonb, p_distance_km numeric, p_duration_min integer, p_waiting_min integer,
  p_at timestamptz, p_timezone text, p_zone_surge_bp integer, p_discount_paise bigint
) returns jsonb
language plpgsql immutable as $$
declare
  v_local timestamp := p_at at time zone coalesce(p_timezone, 'Asia/Kolkata');
  v_time time := v_local::time;
  v_dow integer := extract(isodow from v_local)::integer;
  v_base bigint := (p_rule->>'base_fare_paise')::bigint;
  v_dist bigint := round(greatest(p_distance_km, 0) * (p_rule->>'per_km_paise')::bigint)::bigint;
  v_time_fare bigint := greatest(coalesce(p_duration_min, 0), 0)::bigint * (p_rule->>'per_minute_paise')::bigint;
  v_wait bigint := greatest(coalesce(p_waiting_min, 0) - (p_rule->>'free_waiting_minutes')::integer, 0)::bigint
                   * (p_rule->>'waiting_per_minute_paise')::bigint;
  v_subtotal bigint;
  v_night_bp integer := 10000; v_peak_bp integer := 10000;
  v_surge_bp integer := greatest((p_rule->>'surge_multiplier_bp')::integer, coalesce(p_zone_surge_bp, 10000));
  v_ns time := (p_rule->>'night_start')::time; v_ne time := (p_rule->>'night_end')::time;
  w jsonb;
  v_time_surcharge bigint; v_surge_surcharge bigint; v_gross bigint; v_min_applied boolean := false;
  v_discount bigint; v_taxable bigint; v_tax bigint; v_commission bigint;
begin
  v_subtotal := v_base + v_dist + v_time_fare + v_wait;
  if (v_ns <= v_ne and v_time >= v_ns and v_time < v_ne) or (v_ns > v_ne and (v_time >= v_ns or v_time < v_ne)) then
    v_night_bp := (p_rule->>'night_multiplier_bp')::integer;
  end if;
  for w in select * from jsonb_array_elements(coalesce(p_rule->'peak_windows', '[]'::jsonb)) loop
    if (w->'days' is null or w->'days' @> to_jsonb(v_dow))
       and v_time >= (w->>'start')::time and v_time < (w->>'end')::time then
      v_peak_bp := greatest(v_peak_bp, (w->>'multiplier_bp')::integer);
    end if;
  end loop;
  v_time_surcharge := round(v_subtotal::numeric * (greatest(v_night_bp, v_peak_bp) - 10000) / 10000)::bigint;
  v_surge_surcharge := round(v_subtotal::numeric * (v_surge_bp - 10000) / 10000)::bigint;
  v_gross := v_subtotal + v_time_surcharge + v_surge_surcharge;
  if v_gross < (p_rule->>'minimum_fare_paise')::bigint then
    v_gross := (p_rule->>'minimum_fare_paise')::bigint; v_min_applied := true;
  end if;
  v_discount := least(greatest(coalesce(p_discount_paise, 0), 0), v_gross);
  v_taxable := v_gross - v_discount;
  v_tax := round(v_taxable::numeric * (p_rule->>'gst_bp')::integer / 10000)::bigint;
  -- Commission is charged on the pre-discount fare: discounts are funded by the company.
  v_commission := round(v_gross::numeric * (p_rule->>'commission_bp')::integer / 10000)::bigint;
  return jsonb_build_object(
    'currency', 'INR',
    'distance_km', p_distance_km, 'duration_min', coalesce(p_duration_min, 0), 'waiting_min', coalesce(p_waiting_min, 0),
    'base_fare_paise', v_base, 'distance_fare_paise', v_dist, 'time_fare_paise', v_time_fare, 'waiting_fare_paise', v_wait,
    'night_multiplier_bp', v_night_bp, 'peak_multiplier_bp', v_peak_bp, 'surge_multiplier_bp', v_surge_bp,
    'time_surcharge_paise', v_time_surcharge, 'surge_surcharge_paise', v_surge_surcharge,
    'surcharge_paise', v_time_surcharge + v_surge_surcharge,
    'minimum_fare_applied', v_min_applied, 'gross_fare_paise', v_gross,
    'discount_paise', v_discount, 'taxable_paise', v_taxable, 'tax_paise', v_tax,
    'total_fare_paise', v_taxable + v_tax,
    'commission_paise', v_commission, 'driver_earning_paise', v_gross - v_commission,
    'cancellation_fee_paise', (p_rule->>'cancellation_fee_paise')::bigint);
end $$;

-- Fare preview / estimate. Available to any signed-in user of the platform.
create or replace function public.calculate_fare(
  p_category_id uuid, p_city_id uuid, p_distance_km numeric, p_duration_min integer default null,
  p_at timestamptz default now(), p_waiting_min integer default 0,
  p_pickup_lat numeric default null, p_pickup_lng numeric default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_rule pricing_rules; v_tz text; v_zone_surge integer := 10000; v_duration integer; v_out jsonb;
begin
  if auth.uid() is null and not public.is_privileged() then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  if p_distance_km is null or p_distance_km < 0 or p_distance_km > 2000 then raise exception 'INVALID_DISTANCE'; end if;
  v_rule := public.find_pricing_rule(p_category_id, p_city_id, coalesce(p_at, now()), p_pickup_lat, p_pickup_lng);
  if v_rule.id is null then raise exception 'NO_PRICING_RULE: no active pricing for this category and city'; end if;
  select timezone into v_tz from cities where id = p_city_id;
  if p_pickup_lat is not null then
    select coalesce(max(z.surge_multiplier_bp), 10000) into v_zone_surge from service_zones z
    where z.city_id = p_city_id and z.is_active and z.zone_type = 'surge' and public.point_in_polygon(p_pickup_lat, p_pickup_lng, z.polygon);
  end if;
  v_duration := coalesce(p_duration_min, ceil(p_distance_km / 25.0 * 60)::integer);
  v_out := public.fare_from_rule(to_jsonb(v_rule), p_distance_km, v_duration, p_waiting_min, coalesce(p_at, now()), v_tz, v_zone_surge, 0);
  return v_out || jsonb_build_object('pricing_rule_id', v_rule.id, 'zone_surge_bp', v_zone_surge);
end $$;

-- Coupon validation: returns the discount in paise or raises a descriptive error.
create or replace function public.coupon_discount(
  p_code text, p_customer_id uuid, p_city_id uuid, p_category_id uuid, p_gross_paise bigint, p_lock boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c coupons; v_used integer; v_discount bigint;
begin
  if p_lock then
    select * into c from coupons where code = upper(trim(p_code)) for update;
  else
    select * into c from coupons where code = upper(trim(p_code));
  end if;
  if not found or not c.is_active then raise exception 'COUPON_INVALID: coupon not found or inactive'; end if;
  if c.valid_from > now() then raise exception 'COUPON_NOT_STARTED: coupon is not valid yet'; end if;
  if c.valid_until is not null and c.valid_until <= now() then raise exception 'COUPON_EXPIRED: coupon has expired'; end if;
  if c.city_id is not null and c.city_id <> p_city_id then raise exception 'COUPON_CITY: coupon is not valid in this city'; end if;
  if c.category_id is not null and c.category_id <> p_category_id then raise exception 'COUPON_CATEGORY: coupon is not valid for this vehicle type'; end if;
  if p_gross_paise < c.min_fare_paise then raise exception 'COUPON_MIN_FARE: fare is below the coupon minimum'; end if;
  if c.total_usage_limit is not null and c.used_count >= c.total_usage_limit then raise exception 'COUPON_EXHAUSTED: usage limit reached'; end if;
  select count(*) into v_used from coupon_redemptions where coupon_id = c.id and customer_id = p_customer_id and status = 'applied';
  if v_used >= c.per_customer_limit then raise exception 'COUPON_ALREADY_USED: customer has already used this coupon'; end if;
  if c.first_ride_only and exists (select 1 from bookings where customer_id = p_customer_id and status <> 'CANCELLED') then
    raise exception 'COUPON_FIRST_RIDE_ONLY: valid on the first ride only';
  end if;
  if c.discount_type = 'percent' then
    v_discount := round(p_gross_paise::numeric * c.percent_bp / 10000)::bigint;
    if c.max_discount_paise is not null then v_discount := least(v_discount, c.max_discount_paise); end if;
  else
    v_discount := c.fixed_paise;
  end if;
  return jsonb_build_object('coupon_id', c.id, 'code', c.code, 'discount_paise', least(v_discount, p_gross_paise));
end $$;

create or replace function public.validate_coupon(p_code text, p_customer_id uuid, p_city_id uuid, p_category_id uuid, p_gross_paise bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_privileged() or public.has_permission('rides.create') or public.current_customer_id() = p_customer_id) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return public.coupon_discount(p_code, p_customer_id, p_city_id, p_category_id, p_gross_paise, false);
end $$;

-- ---------------------------------------------------------------------
-- Strict, server-controlled booking state machine
-- ---------------------------------------------------------------------
create or replace function public.booking_transition_allowed(p_from public.booking_status, p_to public.booking_status) returns boolean
language sql immutable as $$
  select case p_from
    when 'BOOKING_CREATED'   then p_to in ('DRIVER_SEARCHING','DRIVER_ASSIGNED','CANCELLED')
    when 'DRIVER_SEARCHING'  then p_to in ('DRIVER_ASSIGNED','CANCELLED')
    when 'DRIVER_ASSIGNED'   then p_to in ('DRIVER_ACCEPTED','DRIVER_SEARCHING','CANCELLED')
    when 'DRIVER_ACCEPTED'   then p_to in ('DRIVER_ARRIVING','DRIVER_SEARCHING','CANCELLED')
    when 'DRIVER_ARRIVING'   then p_to in ('DRIVER_AT_PICKUP','DRIVER_SEARCHING','CANCELLED')
    when 'DRIVER_AT_PICKUP'  then p_to in ('OTP_PENDING','DRIVER_SEARCHING','CANCELLED')
    when 'OTP_PENDING'       then p_to in ('OTP_VERIFIED','DRIVER_SEARCHING','CANCELLED')
    when 'OTP_VERIFIED'      then p_to in ('RIDE_STARTED','CANCELLED')
    when 'RIDE_STARTED'      then p_to in ('RIDE_COMPLETED')
    when 'RIDE_COMPLETED'    then p_to in ('PAYMENT_PENDING')
    when 'PAYMENT_PENDING'   then p_to in ('PAYMENT_COMPLETED','DISPUTED')
    when 'PAYMENT_COMPLETED' then p_to in ('DISPUTED')
    when 'DISPUTED'          then p_to in ('PAYMENT_PENDING','PAYMENT_COMPLETED')
    else false end;
$$;

create or replace function public.tg_booking_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'BOOKING_CREATED' then raise exception 'INVALID_STATE: bookings must start as BOOKING_CREATED'; end if;
    return new;
  end if;
  -- Bookings may only be changed by the audited server functions.
  if coalesce(current_setting('app.booking_write', true), '') <> '1' then
    raise exception 'BOOKING_WRITE_FORBIDDEN: bookings can only be changed through server functions' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not public.booking_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_TRANSITION: % -> %', old.status, new.status;
    end if;
    case new.status
      when 'DRIVER_ASSIGNED'   then new.assigned_at := now();
      when 'DRIVER_ACCEPTED'   then new.accepted_at := now();
      when 'DRIVER_AT_PICKUP'  then new.arrived_at := now();
      when 'OTP_VERIFIED'      then new.otp_verified_at := now();
      when 'RIDE_STARTED'      then new.started_at := now();
      when 'RIDE_COMPLETED'    then new.completed_at := now();
      when 'PAYMENT_COMPLETED' then new.paid_at := coalesce(new.paid_at, now());
      when 'CANCELLED'         then new.cancelled_at := now();
      else null;
    end case;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger bookings_guard before insert or update on public.bookings
for each row execute function public.tg_booking_guard();

create or replace function public.tg_booking_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into booking_status_history(booking_id, from_status, to_status, actor_type, actor_id, reason)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
            coalesce(nullif(current_setting('app.actor_type', true), ''), 'system'),
            nullif(current_setting('app.actor_id', true), '')::uuid,
            nullif(current_setting('app.reason', true), ''));
  end if;
  return new;
end $$;

create trigger bookings_history after insert or update on public.bookings
for each row execute function public.tg_booking_history();

-- Resolve the calling actor and stash it for the history trigger.
create or replace function public.set_actor(p_reason text default null, p_staff_override uuid default null) returns text
language plpgsql security definer set search_path = public as $$
declare v_type text; v_id uuid;
begin
  v_id := coalesce(p_staff_override, public.current_staff_id());
  if v_id is not null then v_type := 'staff';
  else
    v_id := public.current_driver_id();
    if v_id is not null then v_type := 'driver';
    else
      v_id := public.current_customer_id();
      if v_id is not null then v_type := 'customer';
      elsif public.jwt_claims()->>'role' = 'service_role' then v_type := 'service';
      else v_type := 'system'; end if;
    end if;
  end if;
  perform set_config('app.actor_type', v_type, true);
  perform set_config('app.actor_id', coalesce(v_id::text, ''), true);
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  perform set_config('app.booking_write', '1', true);
  return v_type;
end $$;

-- ---------------------------------------------------------------------
-- Booking creation (server calculates distance + fare)
-- ---------------------------------------------------------------------
create or replace function public.create_booking(
  p_customer_id uuid, p_category_id uuid, p_city_id uuid,
  p_pickup_address text, p_pickup_lat numeric, p_pickup_lng numeric,
  p_drop_address text, p_drop_lat numeric, p_drop_lng numeric,
  p_payment_method text default 'cash', p_coupon_code text default null, p_scheduled_for timestamptz default null,
  -- The next four are honoured ONLY for the service role (Edge Function with Google Routes).
  p_route_distance_km numeric default null, p_route_duration_min integer default null,
  p_encoded_polyline text default null, p_actor_staff_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_priv boolean := public.is_privileged();
  v_staff uuid; v_actor text; v_cust customers; v_city cities; v_cat vehicle_categories;
  v_distance numeric; v_duration integer; v_source text; v_factor numeric;
  v_rule pricing_rules; v_zone_surge integer := 10000; v_fare jsonb; v_coupon jsonb; v_coupon_id uuid;
  v_at timestamptz := coalesce(p_scheduled_for, now()); v_id uuid; v_row bookings;
begin
  if v_priv then v_staff := p_actor_staff_id;
  elsif public.has_permission('rides.create') then v_staff := public.current_staff_id();
  elsif public.current_customer_id() is not null and public.current_customer_id() = p_customer_id then v_staff := null;
  else raise exception 'PERMISSION_DENIED: rides.create' using errcode = '42501';
  end if;

  select * into v_cust from customers where id = p_customer_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND'; end if;
  if v_cust.status <> 'active' then raise exception 'CUSTOMER_NOT_ACTIVE: customer account is %', v_cust.status; end if;
  select * into v_city from cities where id = p_city_id;
  if not found or not v_city.is_active then raise exception 'CITY_NOT_ACTIVE: service is not available in this city'; end if;
  if not public.staff_city_ok(p_city_id) and v_staff is not null and not v_priv then raise exception 'PERMISSION_DENIED: city scope' using errcode = '42501'; end if;
  select * into v_cat from vehicle_categories where id = p_category_id;
  if not found or not v_cat.is_active then raise exception 'CATEGORY_NOT_ACTIVE: vehicle category is disabled'; end if;
  if exists (select 1 from category_city_availability where category_id = p_category_id and city_id = p_city_id and not is_enabled) then
    raise exception 'CATEGORY_NOT_AVAILABLE: this vehicle category is not offered in this city';
  end if;
  if p_payment_method not in ('cash','upi','card','netbanking','wallet') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if coalesce(trim(p_pickup_address), '') = '' or coalesce(trim(p_drop_address), '') = '' then raise exception 'ADDRESS_REQUIRED'; end if;
  if p_pickup_lat is null or p_pickup_lng is null or p_drop_lat is null or p_drop_lng is null then raise exception 'COORDINATES_REQUIRED'; end if;

  if exists (select 1 from service_zones where city_id = p_city_id and is_active and zone_type = 'service_boundary')
     and public.zone_at(p_city_id, p_pickup_lat, p_pickup_lng, array['service_boundary']) is null then
    raise exception 'OUTSIDE_SERVICE_AREA: pickup is outside the service boundary';
  end if;
  if public.zone_at(p_city_id, p_pickup_lat, p_pickup_lng, array['restricted']) is not null then
    raise exception 'RESTRICTED_ZONE: pickup is inside a restricted zone';
  end if;

  if v_priv and p_route_distance_km is not null then
    v_distance := round(p_route_distance_km, 2); v_duration := p_route_duration_min; v_source := 'google_routes';
  else
    v_factor := coalesce((public.get_setting('rides.road_distance_factor', '1.3'::jsonb) #>> '{}')::numeric, 1.3);
    v_distance := round(public.haversine_km(p_pickup_lat, p_pickup_lng, p_drop_lat, p_drop_lng) * v_factor, 2);
    v_source := 'haversine_estimate';
  end if;
  if v_distance < 0.1 then raise exception 'DISTANCE_TOO_SHORT: pickup and destination are the same place'; end if;
  if v_distance > public.setting_int('rides.max_distance_km', 300) then raise exception 'DISTANCE_TOO_LONG'; end if;
  v_duration := coalesce(v_duration, ceil(v_distance / 25.0 * 60)::integer);

  v_rule := public.find_pricing_rule(p_category_id, p_city_id, v_at, p_pickup_lat, p_pickup_lng);
  if v_rule.id is null then raise exception 'NO_PRICING_RULE: no active pricing for this category and city'; end if;
  select coalesce(max(z.surge_multiplier_bp), 10000) into v_zone_surge from service_zones z
  where z.city_id = p_city_id and z.is_active and z.zone_type = 'surge' and public.point_in_polygon(p_pickup_lat, p_pickup_lng, z.polygon);

  v_fare := public.fare_from_rule(to_jsonb(v_rule), v_distance, v_duration, 0, v_at, v_city.timezone, v_zone_surge, 0);
  if coalesce(trim(p_coupon_code), '') <> '' then
    v_coupon := public.coupon_discount(p_coupon_code, p_customer_id, p_city_id, p_category_id, (v_fare->>'gross_fare_paise')::bigint, true);
    v_coupon_id := (v_coupon->>'coupon_id')::uuid;
    v_fare := public.fare_from_rule(to_jsonb(v_rule), v_distance, v_duration, 0, v_at, v_city.timezone, v_zone_surge, (v_coupon->>'discount_paise')::bigint);
  end if;

  v_actor := public.set_actor('booking created', v_staff);
  insert into bookings(customer_id, category_id, city_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng,
    scheduled_for, booked_distance_km, estimated_route_distance_km, distance_source, estimated_duration_min,
    estimated_fare_paise, base_fare_paise, distance_fare_paise, time_fare_paise, surcharge_paise, discount_paise, tax_paise,
    total_fare_paise, commission_paise, driver_earning_paise, pricing_snapshot, fare_breakdown, coupon_id, payment_method,
    created_via, created_by_staff)
  values (p_customer_id, p_category_id, p_city_id, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, trim(p_drop_address), p_drop_lat, p_drop_lng,
    p_scheduled_for, v_distance, v_distance, v_source, v_duration,
    (v_fare->>'total_fare_paise')::bigint, (v_fare->>'base_fare_paise')::bigint, (v_fare->>'distance_fare_paise')::bigint,
    (v_fare->>'time_fare_paise')::bigint, (v_fare->>'surcharge_paise')::bigint, (v_fare->>'discount_paise')::bigint,
    (v_fare->>'tax_paise')::bigint, (v_fare->>'total_fare_paise')::bigint, (v_fare->>'commission_paise')::bigint,
    (v_fare->>'driver_earning_paise')::bigint,
    to_jsonb(v_rule) || jsonb_build_object('zone_surge_bp', v_zone_surge, 'timezone', v_city.timezone, 'priced_at', v_at),
    v_fare, v_coupon_id, p_payment_method,
    case when v_staff is not null then 'manager_console' when v_actor = 'customer' then 'customer_app' else 'api' end, v_staff)
  returning id into v_id;

  insert into ride_distance_records(booking_id, original_booked_distance_km, booked_distance_km, estimated_route_distance_km)
  values (v_id, v_distance, v_distance, v_distance);
  insert into distance_audit_logs(booking_id, event, actor_type, details)
  values (v_id, 'booked_distance_recorded', 'system', jsonb_build_object('booked_distance_km', v_distance, 'source', v_source));
  if p_encoded_polyline is not null and v_priv then
    insert into ride_routes(booking_id, route_kind, encoded_polyline, distance_km, duration_min, provider)
    values (v_id, 'planned', p_encoded_polyline, v_distance, v_duration, 'google_routes');
  end if;
  if v_coupon_id is not null then
    insert into coupon_redemptions(coupon_id, customer_id, booking_id, discount_paise)
    values (v_coupon_id, p_customer_id, v_id, (v_fare->>'discount_paise')::bigint);
    update coupons set used_count = used_count + 1 where id = v_coupon_id;
  end if;
  update bookings set status = 'DRIVER_SEARCHING' where id = v_id returning * into v_row;
  perform public.write_audit('booking.create', 'bookings', v_id::text, null,
    jsonb_build_object('booking_code', v_row.booking_code, 'booked_distance_km', v_distance, 'total_fare_paise', v_row.total_fare_paise), null, v_staff);
  return to_jsonb(v_row);
end $$;

-- ---------------------------------------------------------------------
-- Driver allocation
-- ---------------------------------------------------------------------
create or replace function public.allocation_candidates(p_booking_id uuid, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b bookings; v_out jsonb; v_live integer := public.setting_int('tracking.live_seconds', 45);
begin
  if not (public.is_privileged() or public.has_permission('rides.assign')) then raise exception 'PERMISSION_DENIED: rides.assign' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking_id;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(x order by x.score desc), '[]'::jsonb) into v_out from (
    select d.id as driver_id, d.driver_code, d.full_name, d.rating_avg, v.id as vehicle_id, v.registration_number,
           l.received_at as location_at,
           (l.received_at is not null and l.received_at > now() - make_interval(secs => v_live)) as location_live,
           case when l.driver_id is not null then public.haversine_km(l.lat, l.lng, b.pickup_lat, b.pickup_lng) end as distance_km,
           -- Deterministic score: proximity (60) + rating (30) + location freshness (10).
           round(
             coalesce(60 * greatest(0, 1 - public.haversine_km(l.lat, l.lng, b.pickup_lat, b.pickup_lng) / 10.0), 0)
             + 30 * (case when d.rating_count = 0 then 0.8 else d.rating_avg / 5.0 end)
             + case when l.received_at > now() - make_interval(secs => v_live) then 10 else 0 end, 1) as score
    from drivers d
    join vehicle_assignments va on va.driver_id = d.id and va.is_active
    join vehicles v on v.id = va.vehicle_id and v.status = 'active' and v.category_id = b.category_id
    left join driver_locations l on l.driver_id = d.id
    where d.status = 'approved' and d.availability = 'online' and d.city_id = b.city_id
      and not exists (select 1 from bookings ab where ab.driver_id = d.id and ab.status in
        ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED'))
    order by score desc
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) x;
  return v_out;
end $$;

-- Invalidate any live OTP for a booking (cancellation, reassignment ...).
create or replace function public.invalidate_ride_otp(p_booking_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in update ride_otps set status = 'invalidated', invalidated_reason = p_reason
           where booking_id = p_booking_id and status in ('active','locked') returning id loop
    insert into otp_audit_logs(booking_id, otp_id, event, actor_type, details)
    values (p_booking_id, r.id, 'otp_invalidated', 'system', jsonb_build_object('reason', p_reason));
  end loop;
end $$;

create or replace function public.assign_driver(
  p_booking_id uuid, p_driver_id uuid, p_reason text default null, p_actor_staff_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_priv boolean := public.is_privileged(); v_staff uuid; b bookings; d drivers; v_vehicle vehicles;
  v_reassign boolean; v_type text; v_row bookings;
begin
  if v_priv then v_staff := p_actor_staff_id;
  else perform public.require_permission('rides.assign'); v_staff := public.current_staff_id(); end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if not v_priv and not public.staff_city_ok(b.city_id) then raise exception 'PERMISSION_DENIED: city scope' using errcode = '42501'; end if;
  if b.status not in ('BOOKING_CREATED','DRIVER_SEARCHING','DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING') then
    raise exception 'INVALID_STATE: a driver cannot be (re)assigned while the booking is %', b.status;
  end if;
  v_reassign := b.driver_id is not null;
  if v_reassign and b.driver_id = p_driver_id then raise exception 'ALREADY_ASSIGNED: this driver is already assigned'; end if;
  if v_reassign and coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED: a reason is required to reassign a driver'; end if;

  select * into d from drivers where id = p_driver_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;
  if d.status <> 'approved' then raise exception 'DRIVER_NOT_APPROVED: driver status is %', d.status; end if;
  if d.availability <> 'online' then raise exception 'DRIVER_NOT_AVAILABLE: driver is %', d.availability; end if;
  select v.* into v_vehicle from vehicle_assignments va join vehicles v on v.id = va.vehicle_id
  where va.driver_id = p_driver_id and va.is_active;
  if not found then raise exception 'NO_VEHICLE: driver has no active vehicle assignment'; end if;
  if v_vehicle.status <> 'active' then raise exception 'VEHICLE_NOT_ACTIVE: vehicle status is %', v_vehicle.status; end if;
  if v_vehicle.category_id <> b.category_id then raise exception 'CATEGORY_MISMATCH: vehicle category does not match the booking'; end if;

  perform public.set_actor(coalesce(p_reason, case when v_reassign then 'driver reassigned' else 'driver assigned' end), v_staff);
  if v_reassign then
    update driver_assignments set status = 'superseded', responded_at = now()
    where booking_id = p_booking_id and status in ('offered','accepted');
    perform public.invalidate_ride_otp(p_booking_id, 'driver_reassigned');
    update drivers set availability = 'online', availability_changed_at = now() where id = b.driver_id and availability = 'on_ride';
    if b.status <> 'DRIVER_SEARCHING' then
      update bookings set status = 'DRIVER_SEARCHING', driver_id = null, vehicle_id = null where id = p_booking_id;
    end if;
    v_type := 'reassign';
  else
    v_type := case when v_staff is null then 'auto' else 'manual' end;
  end if;
  begin
    update bookings set status = 'DRIVER_ASSIGNED', driver_id = p_driver_id, vehicle_id = v_vehicle.id
    where id = p_booking_id returning * into v_row;
  exception when unique_violation then
    raise exception 'DRIVER_BUSY: the driver or vehicle is already on another active ride';
  end;
  insert into driver_assignments(booking_id, driver_id, vehicle_id, assignment_type, reason, assigned_by)
  values (p_booking_id, p_driver_id, v_vehicle.id, v_type, p_reason, v_staff);
  insert into notifications(audience, recipient_driver_id, category, priority, title, body, data, channels)
  values ('driver', p_driver_id, 'booking', 'high', 'New ride request', 'Pickup: ' || b.pickup_address,
          jsonb_build_object('booking_id', p_booking_id, 'booking_code', b.booking_code), array['in_app','push']);
  perform public.write_audit(case when v_reassign then 'booking.reassign_driver' else 'booking.assign_driver' end, 'bookings',
    p_booking_id::text, jsonb_build_object('driver_id', b.driver_id), jsonb_build_object('driver_id', p_driver_id, 'vehicle_id', v_vehicle.id), p_reason, v_staff);
  return to_jsonb(v_row);
end $$;

create or replace function public.auto_assign_driver(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_candidates jsonb; v_pick jsonb;
begin
  if not (public.is_privileged() or public.has_permission('rides.assign')) then raise exception 'PERMISSION_DENIED: rides.assign' using errcode = '42501'; end if;
  v_candidates := public.allocation_candidates(p_booking_id, 5);
  select c into v_pick from jsonb_array_elements(v_candidates) c where (c->>'location_live')::boolean limit 1;
  if v_pick is null then
    return jsonb_build_object('assigned', false, 'reason', 'NO_DRIVER_WITH_LIVE_LOCATION', 'candidates', jsonb_array_length(v_candidates));
  end if;
  return jsonb_build_object('assigned', true, 'candidate', v_pick,
    'booking', public.assign_driver(p_booking_id, (v_pick->>'driver_id')::uuid, 'automatic allocation (nearest suitable driver)',
       case when public.is_privileged() then null else public.current_staff_id() end));
end $$;

-- ---------------------------------------------------------------------
-- Driver-side ride actions (used by the future Driver App)
-- ---------------------------------------------------------------------
create or replace function public.driver_respond_assignment(p_booking_id uuid, p_accept boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id(); b bookings; v_row bookings;
begin
  if v_driver is null then raise exception 'NOT_A_DRIVER' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found or b.driver_id is distinct from v_driver then raise exception 'NOT_ASSIGNED_DRIVER' using errcode = '42501'; end if;
  perform public.set_actor(p_reason);
  if p_accept then
    if b.status <> 'DRIVER_ASSIGNED' then raise exception 'INVALID_STATE: booking is %', b.status; end if;
    update bookings set status = 'DRIVER_ACCEPTED' where id = p_booking_id returning * into v_row;
    update driver_assignments set status = 'accepted', responded_at = now() where booking_id = p_booking_id and driver_id = v_driver and status = 'offered';
    update drivers set availability = 'on_ride', availability_changed_at = now() where id = v_driver;
  else
    if b.status not in ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING') then
      raise exception 'INVALID_STATE: booking is %', b.status;
    end if;
    perform public.invalidate_ride_otp(p_booking_id, 'driver_rejected');
    update bookings set status = 'DRIVER_SEARCHING', driver_id = null, vehicle_id = null where id = p_booking_id returning * into v_row;
    update driver_assignments set status = 'rejected', responded_at = now(), reason = coalesce(p_reason, reason)
    where booking_id = p_booking_id and driver_id = v_driver and status in ('offered','accepted');
    update drivers set availability = 'online', availability_changed_at = now() where id = v_driver and availability = 'on_ride';
    perform public.notify_staff('rides.assign', 'booking', 'high', 'Driver declined ' || b.booking_code,
      'The assigned driver declined or dropped the ride. Reassignment is needed.', jsonb_build_object('booking_id', p_booking_id));
  end if;
  -- otp_required tells the caller (Edge Function "otp") to issue + SMS the ride OTP now.
  return jsonb_build_object('booking', to_jsonb(v_row), 'otp_required', p_accept);
end $$;

create or replace function public.driver_update_ride(p_booking_id uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_driver uuid := public.current_driver_id(); b bookings; v_row bookings;
begin
  if v_driver is null then raise exception 'NOT_A_DRIVER' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found or b.driver_id is distinct from v_driver then raise exception 'NOT_ASSIGNED_DRIVER' using errcode = '42501'; end if;
  perform public.set_actor('driver action: ' || p_action);
  if p_action = 'arriving' then
    if b.status <> 'DRIVER_ACCEPTED' then raise exception 'INVALID_STATE: booking is %', b.status; end if;
    update bookings set status = 'DRIVER_ARRIVING' where id = p_booking_id returning * into v_row;
  elsif p_action = 'arrived' then
    if b.status = 'DRIVER_ACCEPTED' then update bookings set status = 'DRIVER_ARRIVING' where id = p_booking_id; b.status := 'DRIVER_ARRIVING'; end if;
    if b.status <> 'DRIVER_ARRIVING' then raise exception 'INVALID_STATE: booking is %', b.status; end if;
    update bookings set status = 'DRIVER_AT_PICKUP' where id = p_booking_id;
    update bookings set status = 'OTP_PENDING' where id = p_booking_id returning * into v_row;
  elsif p_action = 'start' then
    -- The ONLY path into RIDE_STARTED: server-side OTP authorisation must exist.
    if b.status = 'RIDE_STARTED' then raise exception 'ALREADY_STARTED: this ride has already been started'; end if;
    if b.status <> 'OTP_VERIFIED' or b.ride_start_authorized_at is null then
      raise exception 'RIDE_START_NOT_AUTHORIZED: OTP verification has not been completed';
    end if;
    update bookings set status = 'RIDE_STARTED' where id = p_booking_id returning * into v_row;
    update driver_locations set booking_id = p_booking_id where driver_id = v_driver;
  else
    raise exception 'INVALID_ACTION: %', p_action;
  end if;
  return to_jsonb(v_row);
end $$;

-- Completion: computes actual / billable distance and the final fare.
create or replace function public.complete_ride(p_booking_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_driver uuid := public.current_driver_id(); v_is_staff boolean := false;
  b bookings; dr ride_distance_records; v_row bookings;
  v_actual numeric; v_billable numeric; v_duration integer; v_policy text; v_tol integer;
  v_fare jsonb; v_gross jsonb; v_discount bigint := 0; v_rule jsonb; c coupons;
begin
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_driver is not null and b.driver_id = v_driver then null;
  elsif public.has_permission('rides.manage') then
    v_is_staff := true;
    if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED: staff must give a reason to complete a ride'; end if;
  else raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if b.status <> 'RIDE_STARTED' then raise exception 'INVALID_STATE: booking is %', b.status; end if;

  select * into dr from ride_distance_records where booking_id = p_booking_id for update;
  v_actual := round(coalesce(dr.actual_distance_km, 0), 2);
  v_policy := coalesce(public.get_setting('rides.billing_distance_policy', '"actual"'::jsonb) #>> '{}', 'actual');
  v_tol := public.setting_int('rides.distance_discrepancy_pct', 20);
  -- No usable GPS trail: bill the booked distance and say so honestly.
  if v_actual < 0.1 then v_billable := dr.booked_distance_km;
  elsif v_policy = 'booked' then v_billable := dr.booked_distance_km;
  elsif v_policy = 'max' then v_billable := greatest(v_actual, dr.booked_distance_km);
  else v_billable := v_actual; end if;
  v_duration := greatest(1, ceil(extract(epoch from (now() - b.started_at)) / 60.0)::integer);

  v_rule := b.pricing_snapshot;
  v_gross := public.fare_from_rule(v_rule, v_billable, v_duration, b.waiting_minutes, coalesce(b.started_at, now()),
              v_rule->>'timezone', (v_rule->>'zone_surge_bp')::integer, 0);
  if b.coupon_id is not null then
    select * into c from coupons where id = b.coupon_id;
    if c.discount_type = 'percent' then
      v_discount := round((v_gross->>'gross_fare_paise')::numeric * c.percent_bp / 10000)::bigint;
      if c.max_discount_paise is not null then v_discount := least(v_discount, c.max_discount_paise); end if;
    else v_discount := c.fixed_paise; end if;
  end if;
  v_fare := public.fare_from_rule(v_rule, v_billable, v_duration, b.waiting_minutes, coalesce(b.started_at, now()),
              v_rule->>'timezone', (v_rule->>'zone_surge_bp')::integer, v_discount);

  perform public.set_actor(coalesce(p_reason, 'ride completed'));
  update ride_distance_records set actual_distance_km = v_actual, final_billable_distance_km = v_billable, updated_at = now()
  where booking_id = p_booking_id;
  insert into distance_audit_logs(booking_id, event, actor_type, actor_id, details)
  values (p_booking_id, 'final_distance_recorded', case when v_is_staff then 'staff' else 'driver' end,
          coalesce(public.current_staff_id(), v_driver),
          jsonb_build_object('booked_km', dr.booked_distance_km, 'actual_km', v_actual, 'billable_km', v_billable,
                             'policy', v_policy, 'gps_available', v_actual >= 0.1));
  if v_actual >= 0.1 and dr.booked_distance_km > 0
     and abs(v_actual - dr.booked_distance_km) * 100 > v_tol * dr.booked_distance_km then
    insert into ride_discrepancies(booking_id, discrepancy_type, expected_km, reported_km, reported_by_driver)
    values (p_booking_id, 'actual_vs_booked_distance', dr.booked_distance_km, v_actual, b.driver_id);
    perform public.notify_staff('otp.view', 'tracking', 'high', 'Distance discrepancy on ' || b.booking_code,
      'Booked ' || dr.booked_distance_km || ' km, travelled ' || v_actual || ' km.', jsonb_build_object('booking_id', p_booking_id));
  end if;

  update bookings set status = 'RIDE_COMPLETED', actual_distance_km = v_actual, final_billable_distance_km = v_billable,
    actual_duration_min = v_duration,
    base_fare_paise = (v_fare->>'base_fare_paise')::bigint, distance_fare_paise = (v_fare->>'distance_fare_paise')::bigint,
    time_fare_paise = (v_fare->>'time_fare_paise')::bigint, waiting_fare_paise = (v_fare->>'waiting_fare_paise')::bigint,
    surcharge_paise = (v_fare->>'surcharge_paise')::bigint, discount_paise = (v_fare->>'discount_paise')::bigint,
    tax_paise = (v_fare->>'tax_paise')::bigint, total_fare_paise = (v_fare->>'total_fare_paise')::bigint,
    commission_paise = (v_fare->>'commission_paise')::bigint, driver_earning_paise = (v_fare->>'driver_earning_paise')::bigint,
    fare_breakdown = v_fare
  where id = p_booking_id;
  update bookings set status = 'PAYMENT_PENDING', payment_status = 'pending' where id = p_booking_id returning * into v_row;

  insert into payments(booking_id, customer_id, amount_paise, method, status, provider, idempotency_key)
  values (p_booking_id, b.customer_id, greatest(v_row.total_fare_paise, 1), b.payment_method, 'pending',
          case when b.payment_method = 'cash' then 'cash' else 'razorpay' end, 'booking:' || p_booking_id || ':fare')
  on conflict (idempotency_key) do nothing;

  update drivers set availability = 'online', availability_changed_at = now() where id = b.driver_id and availability = 'on_ride';
  update driver_locations set booking_id = null where driver_id = b.driver_id;
  insert into driver_attendance(driver_id, work_date, rides_completed) values (b.driver_id, current_date, 1)
  on conflict (driver_id, work_date) do update set rides_completed = driver_attendance.rides_completed + 1;
  perform public.write_audit('booking.complete', 'bookings', p_booking_id::text, null,
    jsonb_build_object('total_fare_paise', v_row.total_fare_paise, 'billable_km', v_billable), p_reason);
  return to_jsonb(v_row);
end $$;

create or replace function public.cancel_booking(p_booking_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bookings; v_by text; v_fee bigint := 0; v_row bookings; v_customer uuid := public.current_customer_id();
begin
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'REASON_REQUIRED: a cancellation reason is required'; end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if public.has_permission('rides.cancel') and public.staff_city_ok(b.city_id) then v_by := 'staff';
  elsif v_customer is not null and b.customer_id = v_customer then v_by := 'customer';
  elsif public.is_privileged() then v_by := 'system';
  else raise exception 'PERMISSION_DENIED: rides.cancel' using errcode = '42501';
  end if;
  if b.status = 'CANCELLED' then raise exception 'ALREADY_CANCELLED'; end if;
  if not public.booking_transition_allowed(b.status, 'CANCELLED') then
    raise exception 'INVALID_STATE: a booking in state % cannot be cancelled', b.status;
  end if;
  -- Customer cancels after the driver has committed: apply the configured fee.
  if v_by = 'customer' and b.status in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED') then
    v_fee := coalesce((b.pricing_snapshot->>'cancellation_fee_paise')::bigint, 0);
  end if;
  perform public.set_actor(p_reason);
  perform public.invalidate_ride_otp(p_booking_id, 'booking_cancelled');
  update bookings set status = 'CANCELLED', cancelled_by = v_by, cancellation_reason = trim(p_reason),
    cancellation_fee_paise = v_fee, ride_start_authorized_at = null
  where id = p_booking_id returning * into v_row;
  update driver_assignments set status = 'cancelled', responded_at = now() where booking_id = p_booking_id and status in ('offered','accepted');
  if b.driver_id is not null then
    update drivers set availability = 'online', availability_changed_at = now() where id = b.driver_id and availability = 'on_ride';
    update driver_locations set booking_id = null where driver_id = b.driver_id and booking_id = p_booking_id;
    insert into notifications(audience, recipient_driver_id, category, priority, title, body, data, channels)
    values ('driver', b.driver_id, 'booking', 'high', 'Ride cancelled', b.booking_code || ' was cancelled.',
            jsonb_build_object('booking_id', p_booking_id), array['in_app','push']);
  end if;
  if b.coupon_id is not null then
    update coupon_redemptions set status = 'released' where booking_id = p_booking_id and status = 'applied';
    if found then update coupons set used_count = greatest(used_count - 1, 0) where id = b.coupon_id; end if;
  end if;
  perform public.write_audit('booking.cancel', 'bookings', p_booking_id::text, jsonb_build_object('status', b.status),
    jsonb_build_object('cancelled_by', v_by, 'fee_paise', v_fee), p_reason);
  return to_jsonb(v_row);
end $$;

create or replace function public.open_dispute(p_booking_id uuid, p_category text, p_description text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b bookings; v_by text; v_id uuid;
begin
  if coalesce(length(trim(p_description)), 0) < 10 then raise exception 'DESCRIPTION_REQUIRED'; end if;
  select * into b from bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if public.has_permission('rides.disputes') then v_by := 'staff';
  elsif b.customer_id = public.current_customer_id() then v_by := 'customer';
  elsif b.driver_id = public.current_driver_id() then v_by := 'driver';
  else raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  if b.status not in ('PAYMENT_PENDING','PAYMENT_COMPLETED') then
    raise exception 'INVALID_STATE: disputes can be opened only after the ride is completed';
  end if;
  perform public.set_actor('dispute opened: ' || p_category);
  update bookings set status = 'DISPUTED', status_before_dispute = b.status where id = p_booking_id;
  insert into ride_disputes(booking_id, raised_by_type, category, description, opened_by)
  values (p_booking_id, v_by, p_category, trim(p_description), auth.uid()) returning id into v_id;
  perform public.notify_staff('rides.disputes', 'support', 'high', 'Dispute on ' || b.booking_code, left(p_description, 140),
    jsonb_build_object('booking_id', p_booking_id, 'dispute_id', v_id));
  perform public.write_audit('booking.dispute_open', 'bookings', p_booking_id::text, null, jsonb_build_object('dispute_id', v_id), p_description);
  return v_id;
end $$;

create or replace function public.resolve_dispute(p_dispute_id uuid, p_outcome text, p_resolution text) returns void
language plpgsql security definer set search_path = public as $$
declare d ride_disputes; b bookings;
begin
  perform public.require_permission('rides.disputes');
  if p_outcome not in ('resolved','rejected') then raise exception 'INVALID_OUTCOME'; end if;
  if coalesce(length(trim(p_resolution)), 0) < 10 then raise exception 'RESOLUTION_REQUIRED: describe the resolution (min 10 characters)'; end if;
  select * into d from ride_disputes where id = p_dispute_id for update;
  if not found then raise exception 'DISPUTE_NOT_FOUND'; end if;
  if d.status in ('resolved','rejected') then raise exception 'ALREADY_RESOLVED'; end if;
  select * into b from bookings where id = d.booking_id for update;
  update ride_disputes set status = p_outcome, resolution = trim(p_resolution), resolved_by = public.current_staff_id(),
    resolved_at = now(), updated_at = now() where id = p_dispute_id;
  if b.status = 'DISPUTED' and not exists (select 1 from ride_disputes where booking_id = b.id and status in ('open','investigating')) then
    perform public.set_actor('dispute ' || p_outcome);
    update bookings set status = coalesce(b.status_before_dispute, 'PAYMENT_PENDING'), status_before_dispute = null where id = b.id;
  end if;
  perform public.write_audit('booking.dispute_' || p_outcome, 'bookings', b.id::text, null, jsonb_build_object('dispute_id', p_dispute_id), p_resolution);
end $$;

-- Emergency / SOS. Creates a safety incident and alerts safety staff.
create or replace function public.raise_sos(p_booking_id uuid, p_lat numeric default null, p_lng numeric default null,
  p_description text default null, p_incident_type text default 'sos') returns uuid
language plpgsql security definer set search_path = public as $$
declare b bookings; v_by text; v_id uuid; v_driver uuid := public.current_driver_id(); v_customer uuid := public.current_customer_id();
begin
  if p_booking_id is not null then
    select * into b from bookings where id = p_booking_id for update;
    if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  end if;
  if public.has_permission('safety.manage') then v_by := 'staff';
  elsif v_driver is not null and (p_booking_id is null or b.driver_id = v_driver) then v_by := 'driver';
  elsif v_customer is not null and p_booking_id is not null and b.customer_id = v_customer then v_by := 'customer';
  else raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  insert into safety_incidents(incident_type, severity, booking_id, driver_id, customer_id, vehicle_id, reported_by_type, lat, lng, description, created_by)
  values (coalesce(p_incident_type, 'sos'), 'critical', p_booking_id, coalesce(b.driver_id, v_driver), coalesce(b.customer_id, v_customer),
          b.vehicle_id, v_by, p_lat, p_lng, p_description, auth.uid())
  returning id into v_id;
  if p_booking_id is not null then
    perform public.set_actor('emergency raised');
    update bookings set is_emergency = true where id = p_booking_id;
  end if;
  perform public.notify_staff('safety.view', 'emergency', 'emergency', 'EMERGENCY SOS' || coalesce(' — ' || b.booking_code, ''),
    coalesce(p_description, 'An SOS alert was raised by the ' || v_by || '.'),
    jsonb_build_object('incident_id', v_id, 'booking_id', p_booking_id, 'lat', p_lat, 'lng', p_lng));
  perform public.write_audit('safety.sos', 'safety_incidents', v_id::text, null, jsonb_build_object('booking_id', p_booking_id, 'by', v_by), null);
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Driver availability + GPS ingestion
-- ---------------------------------------------------------------------
create or replace function public.set_driver_availability(p_online boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d drivers; v_secs integer;
begin
  select * into d from drivers where user_id = auth.uid() for update;
  if not found then raise exception 'NOT_A_DRIVER' using errcode = '42501'; end if;
  if p_online then
    if d.status <> 'approved' then raise exception 'DRIVER_NOT_APPROVED: account status is %', d.status; end if;
    if d.location_consent_at is null then raise exception 'LOCATION_CONSENT_REQUIRED: location consent has not been recorded'; end if;
    if not exists (select 1 from vehicle_assignments va join vehicles v on v.id = va.vehicle_id where va.driver_id = d.id and va.is_active and v.status = 'active') then
      raise exception 'NO_VEHICLE: no active vehicle is assigned';
    end if;
    if d.availability = 'offline' then
      update drivers set availability = 'online', availability_changed_at = now() where id = d.id;
      insert into driver_attendance(driver_id, work_date, first_online_at) values (d.id, current_date, now())
      on conflict (driver_id, work_date) do update set first_online_at = coalesce(driver_attendance.first_online_at, now());
    end if;
  else
    if d.availability = 'on_ride' then raise exception 'RIDE_IN_PROGRESS: cannot go offline during a ride'; end if;
    if d.availability = 'online' then
      v_secs := greatest(0, extract(epoch from (now() - coalesce(d.availability_changed_at, now())))::integer);
      update drivers set availability = 'offline', availability_changed_at = now() where id = d.id;
      insert into driver_attendance(driver_id, work_date, last_offline_at, online_seconds) values (d.id, current_date, now(), v_secs)
      on conflict (driver_id, work_date) do update set last_offline_at = now(), online_seconds = driver_attendance.online_seconds + v_secs;
      update driver_locations set is_sharing = false where driver_id = d.id;
    end if;
  end if;
  return jsonb_build_object('availability', case when p_online then (case when d.availability = 'on_ride' then 'on_ride' else 'online' end) else 'offline' end);
end $$;

-- One GPS fix from the Driver App. Location is accepted ONLY while the driver
-- is on duty and has given consent. Duplicates, out-of-order and too-frequent
-- fixes are dropped; history is thinned to control storage cost.
create or replace function public.ingest_driver_location(
  p_lat numeric, p_lng numeric, p_recorded_at timestamptz,
  p_speed_kmh numeric default null, p_heading numeric default null, p_accuracy_m numeric default null,
  p_battery_pct integer default null, p_gps_status text default 'ok'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d drivers; prev driver_locations; v_booking bookings; v_delta numeric; v_secs numeric; v_last_hist timestamptz;
  v_zone uuid; v_hint integer; v_speed_limit integer;
begin
  select * into d from drivers where user_id = auth.uid();
  if not found then raise exception 'NOT_A_DRIVER' using errcode = '42501'; end if;
  if d.status <> 'approved' then return jsonb_build_object('accepted', false, 'reason', 'DRIVER_NOT_APPROVED'); end if;
  if d.location_consent_at is null then return jsonb_build_object('accepted', false, 'reason', 'NO_CONSENT'); end if;
  if d.availability = 'offline' then return jsonb_build_object('accepted', false, 'reason', 'OFF_DUTY'); end if;
  v_hint := case when d.availability = 'on_ride' then public.setting_int('tracking.interval_on_ride_seconds', 5)
                 else public.setting_int('tracking.interval_idle_seconds', 15) end;

  if p_gps_status in ('disabled','permission_denied') then
    update driver_locations set gps_status = p_gps_status, is_sharing = false, received_at = now() where driver_id = d.id;
    if not exists (select 1 from tracking_alerts where driver_id = d.id and alert_type = 'gps_disabled' and created_at > now() - interval '10 minutes') then
      insert into tracking_alerts(driver_id, alert_type, message) values (d.id, 'gps_disabled', d.full_name || ' has GPS turned off or location permission denied.');
    end if;
    return jsonb_build_object('accepted', false, 'reason', 'GPS_UNAVAILABLE', 'next_interval_seconds', v_hint);
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or p_recorded_at is null then
    return jsonb_build_object('accepted', false, 'reason', 'INVALID_FIX');
  end if;
  if p_recorded_at > now() + interval '60 seconds' then return jsonb_build_object('accepted', false, 'reason', 'FUTURE_TIMESTAMP'); end if;

  select * into prev from driver_locations where driver_id = d.id for update;
  if found then
    if p_recorded_at = prev.recorded_at then return jsonb_build_object('accepted', false, 'reason', 'DUPLICATE', 'next_interval_seconds', v_hint); end if;
    if p_recorded_at < prev.recorded_at then
      -- Late fix after reconnection: keep it for the trail but never move the live marker backwards.
      insert into driver_location_history(driver_id, booking_id, lat, lng, speed_kmh, heading, accuracy_m, recorded_at)
      values (d.id, prev.booking_id, p_lat, p_lng, p_speed_kmh, p_heading, p_accuracy_m, p_recorded_at) on conflict do nothing;
      return jsonb_build_object('accepted', false, 'reason', 'OUT_OF_ORDER_STORED_IN_HISTORY', 'next_interval_seconds', v_hint);
    end if;
    v_secs := extract(epoch from (p_recorded_at - prev.recorded_at));
    if v_secs < 2 then return jsonb_build_object('accepted', false, 'reason', 'TOO_FREQUENT', 'next_interval_seconds', v_hint); end if;
    v_delta := public.haversine_km(prev.lat, prev.lng, p_lat, p_lng);
  end if;

  select * into v_booking from bookings where driver_id = d.id and status in
    ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED') limit 1;

  insert into driver_locations(driver_id, lat, lng, speed_kmh, heading, accuracy_m, battery_pct, booking_id, is_sharing, gps_status, recorded_at, received_at)
  values (d.id, p_lat, p_lng, p_speed_kmh, p_heading, p_accuracy_m, p_battery_pct, v_booking.id, true,
          case when p_gps_status = 'weak' or coalesce(p_accuracy_m, 0) > 100 then 'weak' else 'ok' end, p_recorded_at, now())
  on conflict (driver_id) do update set lat = excluded.lat, lng = excluded.lng, speed_kmh = excluded.speed_kmh,
    heading = excluded.heading, accuracy_m = excluded.accuracy_m, battery_pct = excluded.battery_pct, booking_id = excluded.booking_id,
    is_sharing = true, gps_status = excluded.gps_status, recorded_at = excluded.recorded_at, received_at = now();

  -- Thinned history: every fix on a ride, otherwise only after 20 s or 25 m.
  select max(recorded_at) into v_last_hist from driver_location_history where driver_id = d.id and recorded_at > p_recorded_at - interval '1 hour';
  if v_booking.id is not null or v_last_hist is null or p_recorded_at - v_last_hist >= interval '20 seconds' or coalesce(v_delta, 1) >= 0.025 then
    insert into driver_location_history(driver_id, booking_id, lat, lng, speed_kmh, heading, accuracy_m, recorded_at)
    values (d.id, v_booking.id, p_lat, p_lng, p_speed_kmh, p_heading, p_accuracy_m, p_recorded_at) on conflict do nothing;
  end if;

  -- Actual travelled distance: only during the ride, only plausible, accurate movements.
  if v_booking.status = 'RIDE_STARTED' and v_delta is not null and v_delta >= 0.005
     and coalesce(p_accuracy_m, 0) <= 60 and v_secs > 0 and (v_delta / v_secs * 3600) <= 160 then
    update ride_distance_records set actual_distance_km = actual_distance_km + v_delta, updated_at = now()
    where booking_id = v_booking.id;
  end if;

  -- Geofence + overspeed alerts (at most one per driver / type every 10 minutes).
  v_zone := public.zone_at(d.city_id, p_lat, p_lng, array['restricted']);
  if v_zone is not null and not exists (select 1 from tracking_alerts where driver_id = d.id and alert_type = 'restricted_zone_entry' and created_at > now() - interval '10 minutes') then
    insert into tracking_alerts(driver_id, booking_id, zone_id, alert_type, message, lat, lng)
    values (d.id, v_booking.id, v_zone, 'restricted_zone_entry', d.full_name || ' entered a restricted zone.', p_lat, p_lng);
    perform public.notify_staff('tracking.view', 'tracking', 'high', 'Restricted zone entry', d.full_name || ' (' || d.driver_code || ') entered a restricted zone.',
      jsonb_build_object('driver_id', d.id, 'zone_id', v_zone));
  end if;
  v_speed_limit := public.setting_int('tracking.overspeed_kmh', 90);
  if coalesce(p_speed_kmh, 0) > v_speed_limit and not exists (select 1 from tracking_alerts where driver_id = d.id and alert_type = 'overspeed' and created_at > now() - interval '10 minutes') then
    insert into tracking_alerts(driver_id, booking_id, alert_type, message, lat, lng)
    values (d.id, v_booking.id, 'overspeed', d.full_name || ' is travelling at ' || round(p_speed_kmh) || ' km/h.', p_lat, p_lng);
  end if;
  return jsonb_build_object('accepted', true, 'next_interval_seconds', v_hint);
end $$;

-- Batch upload after an offline period (oldest first).
create or replace function public.ingest_driver_locations_batch(p_points jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p jsonb; v_ok integer := 0; v_total integer := 0; r jsonb;
begin
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) > 500 then raise exception 'INVALID_BATCH: send at most 500 points'; end if;
  for p in select e from jsonb_array_elements(p_points) e order by (e->>'recorded_at')::timestamptz loop
    v_total := v_total + 1;
    r := public.ingest_driver_location((p->>'lat')::numeric, (p->>'lng')::numeric, (p->>'recorded_at')::timestamptz,
      (p->>'speed_kmh')::numeric, (p->>'heading')::numeric, (p->>'accuracy_m')::numeric, (p->>'battery_pct')::integer, coalesce(p->>'gps_status', 'ok'));
    if (r->>'accepted')::boolean then v_ok := v_ok + 1; end if;
  end loop;
  return jsonb_build_object('received', v_total, 'accepted', v_ok);
end $$;

-- Console live map. Freshness is computed on the SERVER clock so stale data is
-- never presented as live.
create or replace function public.tracking_snapshot(p_city_id uuid default null, p_search text default null, p_include_offline boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_live integer := public.setting_int('tracking.live_seconds', 45); v_stale integer := public.setting_int('tracking.stale_seconds', 180); v_out jsonb;
begin
  perform public.require_permission('tracking.view');
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_out from (
    select d.id as driver_id, d.driver_code, d.full_name, d.availability, d.city_id, d.rating_avg,
      v.registration_number, vc.name as category, vc.icon as category_icon,
      l.lat, l.lng, l.speed_kmh, l.heading, l.accuracy_m, l.battery_pct, l.is_sharing, l.gps_status,
      l.recorded_at, l.received_at,
      case when l.received_at is null then null else greatest(0, extract(epoch from (now() - l.received_at))::integer) end as age_seconds,
      case when l.driver_id is null then 'no_data'
           when d.availability = 'offline' then 'offline'
           when not l.is_sharing then 'not_sharing'
           when l.received_at > now() - make_interval(secs => v_live) then 'live'
           when l.received_at > now() - make_interval(secs => v_stale) then 'delayed'
           else 'stale' end as freshness,
      (d.availability = 'online' and coalesce(l.speed_kmh, 0) < 3) as is_idle,
      b.id as booking_id, b.booking_code, b.status as booking_status,
      b.pickup_address, b.pickup_lat, b.pickup_lng, b.drop_address, b.drop_lat, b.drop_lng,
      rd.actual_distance_km as travelled_km, rd.booked_distance_km
    from drivers d
    left join driver_locations l on l.driver_id = d.id
    left join vehicle_assignments va on va.driver_id = d.id and va.is_active
    left join vehicles v on v.id = va.vehicle_id
    left join vehicle_categories vc on vc.id = v.category_id
    left join bookings b on b.driver_id = d.id and b.status in
      ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED')
    left join ride_distance_records rd on rd.booking_id = b.id
    where d.status = 'approved'
      and (p_include_offline or d.availability <> 'offline')
      and (p_city_id is null or d.city_id = p_city_id)
      and public.staff_city_ok(d.city_id)
      and (coalesce(trim(p_search), '') = '' or d.full_name ilike '%' || trim(p_search) || '%'
           or d.driver_code ilike '%' || trim(p_search) || '%' or v.registration_number ilike '%' || trim(p_search) || '%')
    order by d.full_name
    limit 3000
  ) x;
  return jsonb_build_object('server_time', now(), 'live_seconds', v_live, 'stale_seconds', v_stale, 'drivers', v_out);
end $$;

create or replace function public.driver_location_trail(p_driver_id uuid default null, p_booking_id uuid default null,
  p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  perform public.require_permission('tracking.history');
  if p_driver_id is null and p_booking_id is null then raise exception 'DRIVER_OR_BOOKING_REQUIRED'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('lat', lat, 'lng', lng, 'speed_kmh', speed_kmh, 'heading', heading, 't', recorded_at) order by recorded_at), '[]'::jsonb)
  into v_out from (
    select lat, lng, speed_kmh, heading, recorded_at from driver_location_history h
    where (p_driver_id is null or h.driver_id = p_driver_id)
      and (p_booking_id is null or h.booking_id = p_booking_id)
      and h.recorded_at >= coalesce(p_from, now() - interval '24 hours')
      and h.recorded_at <= coalesce(p_to, now())
    order by recorded_at limit 5000
  ) t;
  return v_out;
end $$;

-- Periodic health scan (pg_cron): raise alerts for on-duty drivers gone silent.
create or replace function public.scan_tracking_health() returns integer
language plpgsql security definer set search_path = public as $$
declare v_stale integer := public.setting_int('tracking.stale_seconds', 180); v_count integer := 0; r record;
begin
  if not public.is_privileged() then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  for r in
    select d.id, d.full_name, d.driver_code, d.availability, l.booking_id, l.received_at
    from drivers d join driver_locations l on l.driver_id = d.id
    where d.availability in ('online','on_ride') and l.received_at < now() - make_interval(secs => v_stale)
      and not exists (select 1 from tracking_alerts a where a.driver_id = d.id and a.alert_type = 'stale_location' and a.created_at > now() - interval '15 minutes')
  loop
    insert into tracking_alerts(driver_id, booking_id, alert_type, message)
    values (r.id, r.booking_id, 'stale_location', r.full_name || ' (' || r.driver_code || ') has sent no location since ' || to_char(r.received_at, 'HH24:MI') || ' UTC.');
    if r.availability = 'on_ride' then
      perform public.notify_staff('tracking.view', 'tracking', 'high', 'Location lost during ride',
        r.full_name || ' is on a ride but has stopped sending location.', jsonb_build_object('driver_id', r.id, 'booking_id', r.booking_id));
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.acknowledge_tracking_alert(p_alert_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_permission('tracking.view');
  update tracking_alerts set acknowledged_at = now(), acknowledged_by = public.current_staff_id() where id = p_alert_id and acknowledged_at is null;
end $$;
