-- =====================================================================
-- 0010_analytics_functions.sql — dashboard, analytics, statistical
-- forecasting and rule-based signals.
-- Everything here is deterministic SQL over real records. Forecasts are
-- labelled as estimates; nothing is fabricated when data is missing.
-- =====================================================================

create or replace function public.dashboard_stats(p_from timestamptz, p_to timestamptz, p_city_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('dashboard.view');
  with bk as (
    select * from bookings b where b.created_at >= p_from and b.created_at < p_to
      and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)
  ), paid as (
    select * from bookings b where b.paid_at >= p_from and b.paid_at < p_to and b.payment_status in ('paid','partially_refunded','refunded')
      and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)
  ), drv as (
    select * from drivers d where (p_city_id is null or d.city_id = p_city_id) and public.staff_city_ok(d.city_id)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'total_customers', (select count(*) from customers c where c.status <> 'deleted' and (p_city_id is null or c.city_id = p_city_id)),
    'total_drivers', (select count(*) from drv where status not in ('rejected','blacklisted')),
    'approved_drivers', (select count(*) from drv where status = 'approved'),
    'pending_driver_applications', (select count(*) from drv where status in ('pending','under_review')),
    'total_vehicles', (select count(*) from vehicles v where v.status <> 'retired' and (p_city_id is null or v.city_id = p_city_id)),
    'online_drivers', (select count(*) from drv where availability = 'online'),
    'offline_drivers', (select count(*) from drv where availability = 'offline' and status = 'approved'),
    'drivers_on_ride', (select count(*) from drv where availability = 'on_ride'),
    'bookings', (select count(*) from bk),
    'completed_rides', (select count(*) from bookings b where b.completed_at >= p_from and b.completed_at < p_to
        and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)),
    'cancelled_rides', (select count(*) from bookings b where b.cancelled_at >= p_from and b.cancelled_at < p_to
        and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)),
    'ongoing_rides', (select count(*) from bookings b where b.status in
        ('DRIVER_ASSIGNED','DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING','OTP_VERIFIED','RIDE_STARTED')
        and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)),
    'searching_rides', (select count(*) from bookings b where b.status in ('BOOKING_CREATED','DRIVER_SEARCHING')
        and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)),
    'revenue_paise', (select coalesce(sum(total_fare_paise), 0) from paid),
    'commission_paise', (select coalesce(sum(commission_paise), 0) from paid),
    'driver_earnings_paise', (select coalesce(sum(driver_earning_paise), 0) from paid),
    'discounts_paise', (select coalesce(sum(discount_paise), 0) from paid),
    -- Company profit for the period = commission minus company-funded discounts.
    'company_profit_paise', (select coalesce(sum(commission_paise - discount_paise), 0) from paid),
    'driver_payouts_paise', (select coalesce(sum(amount_paise), 0) from driver_payouts where status = 'paid' and paid_at >= p_from and paid_at < p_to),
    'payouts_awaiting_paise', (select coalesce(sum(amount_paise), 0) from driver_payouts where status in ('pending','approved')),
    'pending_payments_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bookings b on b.id = p.booking_id
        where p.status in ('created','pending') and (p_city_id is null or b.city_id = p_city_id)),
    'pending_payments_count', (select count(*) from payments p join bookings b on b.id = p.booking_id
        where p.status in ('created','pending') and (p_city_id is null or b.city_id = p_city_id)),
    'open_emergencies', (select count(*) from safety_incidents where status in ('open','acknowledged','investigating')),
    'open_tickets', (select count(*) from support_tickets where status in ('open','in_progress','waiting')),
    'open_tracking_alerts', (select count(*) from tracking_alerts where acknowledged_at is null),
    'documents_expiring_30d', (select count(*) from driver_documents where status = 'approved' and expiry_date between current_date and current_date + 30)
        + (select count(*) from vehicle_documents where status = 'approved' and expiry_date between current_date and current_date + 30),
    'open_distance_discrepancies', (select count(*) from ride_discrepancies where status = 'open')
  ) into v;
  return v;
end $$;

-- Time series for charts. Buckets are computed in the city's local time.
create or replace function public.analytics_timeseries(p_from timestamptz, p_to timestamptz, p_bucket text default 'day', p_city_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_step interval; v_tz text := 'Asia/Kolkata';
begin
  perform public.require_permission('analytics.view');
  if p_bucket not in ('hour','day','week','month') then raise exception 'INVALID_BUCKET'; end if;
  if p_to <= p_from then raise exception 'INVALID_RANGE'; end if;
  v_step := ('1 ' || p_bucket)::interval;
  if extract(epoch from (p_to - p_from)) / extract(epoch from v_step) > 800 then raise exception 'RANGE_TOO_LARGE: choose a coarser bucket'; end if;
  if p_city_id is not null then select timezone into v_tz from cities where id = p_city_id; end if;
  with buckets as (
    select generate_series(date_trunc(p_bucket, p_from at time zone v_tz), date_trunc(p_bucket, (p_to - interval '1 second') at time zone v_tz), v_step) as b
  ), bk as (
    select date_trunc(p_bucket, created_at at time zone v_tz) b, count(*) n from bookings
    where created_at >= p_from and created_at < p_to and (p_city_id is null or city_id = p_city_id) and public.staff_city_ok(city_id) group by 1
  ), done as (
    select date_trunc(p_bucket, completed_at at time zone v_tz) b, count(*) n, count(distinct driver_id) drivers from bookings
    where completed_at >= p_from and completed_at < p_to and (p_city_id is null or city_id = p_city_id) and public.staff_city_ok(city_id) group by 1
  ), canc as (
    select date_trunc(p_bucket, cancelled_at at time zone v_tz) b, count(*) n from bookings
    where cancelled_at >= p_from and cancelled_at < p_to and (p_city_id is null or city_id = p_city_id) and public.staff_city_ok(city_id) group by 1
  ), rev as (
    select date_trunc(p_bucket, paid_at at time zone v_tz) b, sum(total_fare_paise) revenue, sum(commission_paise) commission from bookings
    where paid_at >= p_from and paid_at < p_to and payment_status in ('paid','partially_refunded','refunded')
      and (p_city_id is null or city_id = p_city_id) and public.staff_city_ok(city_id) group by 1
  ), cust as (
    select date_trunc(p_bucket, created_at at time zone v_tz) b, count(*) n from customers
    where created_at >= p_from and created_at < p_to and (p_city_id is null or city_id = p_city_id) group by 1
  ), drv as (
    select date_trunc(p_bucket, created_at at time zone v_tz) b, count(*) n from drivers
    where created_at >= p_from and created_at < p_to and (p_city_id is null or city_id = p_city_id) group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('bucket', buckets.b, 'bookings', coalesce(bk.n, 0), 'completed', coalesce(done.n, 0),
      'cancelled', coalesce(canc.n, 0), 'revenue_paise', coalesce(rev.revenue, 0), 'commission_paise', coalesce(rev.commission, 0),
      'new_customers', coalesce(cust.n, 0), 'new_drivers', coalesce(drv.n, 0), 'active_drivers', coalesce(done.drivers, 0)) order by buckets.b), '[]'::jsonb)
  into v
  from buckets left join bk on bk.b = buckets.b left join done on done.b = buckets.b left join canc on canc.b = buckets.b
    left join rev on rev.b = buckets.b left join cust on cust.b = buckets.b left join drv on drv.b = buckets.b;
  return v;
end $$;

create or replace function public.analytics_breakdowns(p_from timestamptz, p_to timestamptz, p_city_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_tz text := 'Asia/Kolkata';
begin
  perform public.require_permission('analytics.view');
  if p_city_id is not null then select timezone into v_tz from cities where id = p_city_id; end if;
  with bk as (
    select b.* from bookings b where b.created_at >= p_from and b.created_at < p_to
      and (p_city_id is null or b.city_id = p_city_id) and public.staff_city_ok(b.city_id)
  ), paid as (select * from bk where payment_status in ('paid','partially_refunded'))
  select jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(x order by x.rides desc), '[]'::jsonb) from
        (select vc.name, count(*) rides, coalesce(sum(bk.total_fare_paise) filter (where bk.payment_status in ('paid','partially_refunded')), 0) revenue_paise
         from bk join vehicle_categories vc on vc.id = bk.category_id group by vc.name) x),
    'cancellation_reasons', (select coalesce(jsonb_agg(x order by x.n desc), '[]'::jsonb) from
        (select coalesce(nullif(left(cancellation_reason, 60), ''), 'Not given') reason, count(*) n from bk where status = 'CANCELLED' group by 1 order by 2 desc limit 10) x),
    'cancelled_by', (select coalesce(jsonb_object_agg(coalesce(cancelled_by, 'unknown'), n), '{}'::jsonb) from
        (select cancelled_by, count(*) n from bk where status = 'CANCELLED' group by 1) x),
    'cancellation_stage', (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb) from
        (select case when accepted_at is null then 'before_driver_accepted' when arrived_at is null then 'after_accept_before_arrival' else 'after_driver_arrived' end stage, count(*) n
         from bk where status = 'CANCELLED' group by 1) x),
    'cancellation_rate_pct', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'CANCELLED') / count(*), 1) end from bk),
    'peak_hours', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'bookings', n) order by h), '[]'::jsonb) from
        (select extract(hour from created_at at time zone v_tz)::integer h, count(*) n from bk group by 1) x),
    'weekdays', (select coalesce(jsonb_agg(jsonb_build_object('dow', d, 'bookings', n) order by d), '[]'::jsonb) from
        (select extract(isodow from created_at at time zone v_tz)::integer d, count(*) n from bk group by 1) x),
    'zones', (select coalesce(jsonb_agg(x order by x.revenue_paise desc), '[]'::jsonb) from
        (select coalesce(z.name, 'Outside defined zones') as name, count(*) rides,
                coalesce(sum(bk.total_fare_paise) filter (where bk.payment_status in ('paid','partially_refunded')), 0) revenue_paise
         from bk left join lateral (select sz.name from service_zones sz where sz.city_id = bk.city_id and sz.is_active
              and sz.zone_type in ('operating','airport','railway') and public.point_in_polygon(bk.pickup_lat, bk.pickup_lng, sz.polygon) limit 1) z on true
         group by 1 order by 3 desc limit 12) x),
    'average_ride_value_paise', (select round(avg(total_fare_paise)) from paid),
    'average_distance_km', (select round(avg(coalesce(final_billable_distance_km, booked_distance_km)), 2) from paid),
    'average_customer_spend_paise', (select round(avg(s)) from (select sum(total_fare_paise) s from paid group by customer_id) x),
    'paying_customers', (select count(distinct customer_id) from paid),
    -- Retention: of customers who rode in this period, how many had also ridden before it.
    'returning_customers', (select count(*) from (select distinct customer_id from paid) c
        where exists (select 1 from bookings o where o.customer_id = c.customer_id and o.completed_at < p_from)),
    'repeat_customers_in_period', (select count(*) from (select customer_id from paid group by customer_id having count(*) > 1) x),
    'top_drivers', (select coalesce(jsonb_agg(x order by x.rides desc), '[]'::jsonb) from
        (select d.full_name, d.driver_code, d.rating_avg, count(*) rides, sum(paid.driver_earning_paise) earnings_paise
         from paid join drivers d on d.id = paid.driver_id group by d.id order by count(*) desc limit 10) x),
    'payment_methods', (select coalesce(jsonb_object_agg(payment_method, n), '{}'::jsonb) from (select payment_method, count(*) n from paid group by 1) x)
  ) into v;
  return v;
end $$;

create or replace function public.city_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('locations.view');
  select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) into v from (
    select c.id, c.name, c.state, c.is_active,
      (select count(*) from drivers d where d.city_id = c.id and d.status = 'approved') as approved_drivers,
      (select count(*) from drivers d where d.city_id = c.id and d.availability <> 'offline') as on_duty_drivers,
      (select count(*) from vehicles v where v.city_id = c.id and v.status = 'active') as active_vehicles,
      (select count(*) from service_zones z where z.city_id = c.id and z.is_active) as zones,
      (select count(*) from bookings b where b.city_id = c.id and b.created_at > now() - interval '30 days') as bookings_30d,
      (select coalesce(sum(b.total_fare_paise), 0) from bookings b where b.city_id = c.id and b.paid_at > now() - interval '30 days'
         and b.payment_status in ('paid','partially_refunded')) as revenue_30d_paise
    from cities c where public.staff_city_ok(c.id)
  ) x;
  return v;
end $$;

-- Demand grid for the heat overlay: bookings bucketed into lat/lng cells.
create or replace function public.demand_heatmap(p_city_id uuid, p_from timestamptz, p_to timestamptz, p_cell_deg numeric default 0.005) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('locations.view');
  if p_cell_deg < 0.001 or p_cell_deg > 0.1 then raise exception 'INVALID_CELL'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v from (
    select (floor(pickup_lat / p_cell_deg) * p_cell_deg + p_cell_deg / 2)::numeric(9,6) as lat,
           (floor(pickup_lng / p_cell_deg) * p_cell_deg + p_cell_deg / 2)::numeric(9,6) as lng, count(*) as bookings
    from bookings where city_id = p_city_id and created_at >= p_from and created_at < p_to and public.staff_city_ok(city_id)
    group by 1, 2 order by 3 desc limit 1500
  ) x;
  return v;
end $$;

-- Driver performance score (0-100). Transparent weighted formula.
create or replace function public.driver_performance(p_from timestamptz, p_to timestamptz, p_city_id uuid default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('analytics.view');
  select coalesce(jsonb_agg(x order by x.score desc), '[]'::jsonb) into v from (
    select d.id as driver_id, d.driver_code, d.full_name, d.rating_avg, s.completed, s.offered, s.accepted, s.dropped, s.earnings_paise,
      s.overspeed_alerts, s.complaints,
      case when s.offered = 0 then null else round(100.0 * s.accepted / s.offered, 1) end as acceptance_pct,
      round(least(100, greatest(0,
          40 * (case when d.rating_count = 0 then 0.8 else d.rating_avg / 5.0 end)
        + 30 * (case when s.offered = 0 then 0.8 else s.accepted::numeric / s.offered end)
        + 20 * (case when s.accepted = 0 then 0.8 else greatest(0, 1 - s.dropped::numeric / s.accepted) end)
        + 10 - least(10, 2 * s.overspeed_alerts + 3 * s.complaints))), 1) as score
    from drivers d
    cross join lateral (
      select
        (select count(*) from bookings b where b.driver_id = d.id and b.completed_at >= p_from and b.completed_at < p_to) as completed,
        (select count(*) from driver_assignments a where a.driver_id = d.id and a.created_at >= p_from and a.created_at < p_to) as offered,
        (select count(*) from driver_assignments a where a.driver_id = d.id and a.created_at >= p_from and a.created_at < p_to and a.status = 'accepted') as accepted,
        (select count(*) from driver_assignments a where a.driver_id = d.id and a.created_at >= p_from and a.created_at < p_to and a.status = 'rejected' and a.responded_at is not null) as dropped,
        (select coalesce(sum(b.driver_earning_paise), 0) from bookings b where b.driver_id = d.id and b.paid_at >= p_from and b.paid_at < p_to) as earnings_paise,
        (select count(*) from tracking_alerts t where t.driver_id = d.id and t.alert_type = 'overspeed' and t.created_at >= p_from and t.created_at < p_to) as overspeed_alerts,
        (select count(*) from support_tickets t where t.driver_id = d.id and t.ticket_type = 'customer_complaint' and t.created_at >= p_from and t.created_at < p_to) as complaints
    ) s
    where d.status = 'approved' and (p_city_id is null or d.city_id = p_city_id) and public.staff_city_ok(d.city_id)
    order by score desc limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) x;
  return jsonb_build_object('formula', '40% rating + 30% acceptance + 20% reliability + 10 points minus overspeed/complaint penalties', 'drivers', v);
end $$;

-- Demand forecast: average bookings for the same weekday + hour over the past
-- N weeks. A simple, explainable statistical estimate — not a guarantee.
create or replace function public.forecast_demand(p_city_id uuid default null, p_weeks integer default 6) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_tz text := 'Asia/Kolkata'; v_hist integer; v_weeks integer := greatest(2, least(coalesce(p_weeks, 6), 26));
begin
  perform public.require_permission('ai.view');
  if p_city_id is not null then select timezone into v_tz from cities where id = p_city_id; end if;
  select count(*) into v_hist from bookings where created_at > now() - make_interval(weeks => v_weeks) and (p_city_id is null or city_id = p_city_id);
  if v_hist < 50 then
    return jsonb_build_object('available', false, 'history_bookings', v_hist,
      'message', 'Not enough booking history yet for a meaningful forecast (at least 50 bookings in the look-back window are needed).');
  end if;
  with hist as (
    select extract(isodow from created_at at time zone v_tz)::integer dow, extract(hour from created_at at time zone v_tz)::integer hr,
           (created_at at time zone v_tz)::date d, count(*) n
    from bookings where created_at > now() - make_interval(weeks => v_weeks) and (p_city_id is null or city_id = p_city_id) and public.staff_city_ok(city_id)
    group by 1, 2, 3
  ), agg as (select dow, hr, round(sum(n)::numeric / v_weeks, 1) expected, max(n) peak from hist group by 1, 2),
  nxt as (
    select g as ts, extract(isodow from g)::integer dow, extract(hour from g)::integer hr
    from generate_series(date_trunc('hour', now() at time zone v_tz) + interval '1 hour', date_trunc('hour', now() at time zone v_tz) + interval '24 hours', interval '1 hour') g
  )
  select jsonb_build_object('available', true, 'method', 'Mean bookings for the same weekday and hour over the last ' || v_weeks || ' weeks',
    'disclaimer', 'Statistical estimate from past bookings. Actual demand can differ.', 'history_bookings', v_hist,
    'next_24h', (select jsonb_agg(jsonb_build_object('time', nxt.ts, 'expected_bookings', coalesce(agg.expected, 0), 'historical_peak', coalesce(agg.peak, 0)) order by nxt.ts)
                 from nxt left join agg on agg.dow = nxt.dow and agg.hr = nxt.hr),
    'busiest_slots', (select jsonb_agg(x) from (select dow, hr as hour, expected from agg order by expected desc limit 8) x))
  into v;
  return v;
end $$;

-- Revenue forecast: ordinary least-squares trend over daily revenue.
create or replace function public.forecast_revenue(p_history_days integer default 30, p_forecast_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_days integer := greatest(14, least(coalesce(p_history_days, 30), 180)); v_fc integer := greatest(1, least(coalesce(p_forecast_days, 7), 30));
  v_slope numeric; v_icpt numeric; v_n integer; v_nonzero integer; v_hist jsonb; v_out jsonb;
begin
  perform public.require_permission('ai.view');
  with days as (select generate_series((current_date - v_days)::timestamp, (current_date - 1)::timestamp, interval '1 day')::date d),
  rev as (
    select days.d, (days.d - (current_date - v_days))::integer x,
      coalesce((select sum(total_fare_paise) from bookings b where (b.paid_at at time zone 'Asia/Kolkata')::date = days.d
                and b.payment_status in ('paid','partially_refunded')), 0)::numeric y
    from days
  )
  select regr_slope(y, x), regr_intercept(y, x), count(*), count(*) filter (where y > 0),
         jsonb_agg(jsonb_build_object('date', d, 'revenue_paise', y) order by d)
  into v_slope, v_icpt, v_n, v_nonzero, v_hist from rev;
  if v_nonzero < 7 then
    return jsonb_build_object('available', false, 'days_with_revenue', v_nonzero,
      'message', 'Not enough revenue history yet (at least 7 days with paid rides are needed).');
  end if;
  select jsonb_agg(jsonb_build_object('date', current_date + i, 'expected_revenue_paise', greatest(0, round(v_icpt + v_slope * (v_n + i)))) order by i)
  into v_out from generate_series(0, v_fc - 1) i;
  return jsonb_build_object('available', true, 'method', 'Linear trend (least squares) over the last ' || v_days || ' days of paid revenue',
    'disclaimer', 'Statistical estimate. Not a guarantee of future revenue.', 'daily_trend_paise', round(v_slope), 'history', v_hist, 'forecast', v_out);
end $$;

-- Rule-based fraud / anomaly signals. Each row explains exactly why it fired.
create or replace function public.fraud_signals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('ai.view');
  select coalesce(jsonb_agg(x order by x.severity desc, x.detected_at desc), '[]'::jsonb) into v from (
    select 'driver_customer_pair'::text as signal, 3 as severity, max(b.completed_at) as detected_at,
           d.full_name || ' and ' || c.full_name || ' completed ' || count(*) || ' rides together in 7 days' as explanation,
           jsonb_build_object('driver_id', d.id, 'customer_id', c.id) as refs
    from bookings b join drivers d on d.id = b.driver_id join customers c on c.id = b.customer_id
    where b.completed_at > now() - interval '7 days' group by d.id, c.id having count(*) >= 6
    union all
    select 'very_short_rides', 2, max(b.completed_at), d.full_name || ' completed ' || count(*) || ' rides under 0.5 km in 7 days', jsonb_build_object('driver_id', d.id)
    from bookings b join drivers d on d.id = b.driver_id
    where b.completed_at > now() - interval '7 days' and coalesce(b.final_billable_distance_km, 0) < 0.5 group by d.id having count(*) >= 5
    union all
    select 'distance_inflation', 3, max(x.created_at), d.full_name || ' has ' || count(*) || ' rides in 30 days where travelled distance exceeded booked distance by the alert threshold',
           jsonb_build_object('driver_id', d.id)
    from ride_discrepancies x join drivers d on d.id = x.reported_by_driver
    where x.discrepancy_type = 'actual_vs_booked_distance' and x.reported_km > x.expected_km and x.created_at > now() - interval '30 days' group by d.id having count(*) >= 3
    union all
    select 'coupon_abuse', 2, max(r.created_at), c.full_name || ' redeemed ' || count(*) || ' coupons in 7 days', jsonb_build_object('customer_id', c.id)
    from coupon_redemptions r join customers c on c.id = r.customer_id where r.created_at > now() - interval '7 days' and r.status = 'applied' group by c.id having count(*) >= 5
    union all
    select 'repeated_refunds', 3, max(r.created_at), c.full_name || ' received ' || count(*) || ' refunds in 30 days', jsonb_build_object('customer_id', c.id)
    from refunds r join bookings b on b.id = r.booking_id join customers c on c.id = b.customer_id
    where r.status = 'completed' and r.created_at > now() - interval '30 days' group by c.id having count(*) >= 3
    union all
    select 'otp_abuse', 4, max(a.created_at), coalesce(d.full_name, 'Unknown driver') || ' made ' || count(*) || ' suspicious OTP attempts in 7 days', jsonb_build_object('driver_id', d.id)
    from otp_verification_attempts a left join drivers d on d.id = a.driver_id
    where a.is_suspicious and a.created_at > now() - interval '7 days' group by d.id, d.full_name having count(*) >= 3
    union all
    select 'large_cash_dues', 2, now(), d.full_name || ' owes ₹' || round(-w.balance_paise / 100.0) || ' in cash-ride commission', jsonb_build_object('driver_id', d.id)
    from driver_wallets w join drivers d on d.id = w.driver_id where w.balance_paise < -public.setting_int('fraud.driver_cash_dues_alert_paise', 500000)
  ) x;
  return jsonb_build_object('generated_at', now(), 'note', 'Rule-based signals for human review. A signal is not proof of fraud.', 'signals', v);
end $$;

-- Maintenance prediction from service intervals and odometer readings.
create or replace function public.maintenance_predictions() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('ai.view');
  select coalesce(jsonb_agg(x order by x.urgency desc), '[]'::jsonb) into v from (
    select v.id as vehicle_id, v.registration_number, v.manufacturer || ' ' || v.model as vehicle, v.odometer_km,
      m.performed_on as last_service_on, m.next_due_on, m.next_due_odometer_km,
      case when m.id is null then 'No service record on file'
           when m.next_due_on is not null and m.next_due_on < current_date then 'Service overdue since ' || to_char(m.next_due_on, 'DD Mon YYYY')
           when m.next_due_odometer_km is not null and v.odometer_km >= m.next_due_odometer_km then 'Service odometer limit reached'
           when m.next_due_on is not null and m.next_due_on <= current_date + 14 then 'Service due within 14 days'
           when m.next_due_odometer_km is not null and v.odometer_km >= m.next_due_odometer_km - 500 then 'Within 500 km of the next service'
           when m.performed_on < current_date - 180 then 'More than 180 days since the last service'
           else null end as reason,
      case when m.id is null then 1
           when (m.next_due_on is not null and m.next_due_on < current_date) or (m.next_due_odometer_km is not null and v.odometer_km >= m.next_due_odometer_km) then 3
           else 2 end as urgency
    from vehicles v
    left join lateral (select * from vehicle_maintenance vm where vm.vehicle_id = v.id and vm.record_type in ('service','inspection') order by vm.performed_on desc limit 1) m on true
    where v.status in ('active','maintenance') and public.staff_city_ok(v.city_id)
  ) x where x.reason is not null;
  return jsonb_build_object('method', 'Based on recorded service due dates, odometer limits and time since last service', 'vehicles', v);
end $$;

-- Live operational alerts derived from current state.
create or replace function public.operational_alerts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; n integer;
begin
  perform public.require_permission('dashboard.view');
  select count(*) into n from bookings where status in ('BOOKING_CREATED','DRIVER_SEARCHING') and created_at < now() - interval '5 minutes';
  if n > 0 then v := v || jsonb_build_object('level', 'high', 'code', 'UNASSIGNED_BOOKINGS', 'count', n, 'message', n || ' booking(s) have waited more than 5 minutes for a driver', 'page', 'rides'); end if;
  select count(*) into n from safety_incidents where status in ('open','acknowledged') and severity = 'critical';
  if n > 0 then v := v || jsonb_build_object('level', 'emergency', 'code', 'OPEN_SOS', 'count', n, 'message', n || ' emergency incident(s) need attention', 'page', 'support'); end if;
  select count(*) into n from bookings b where b.status in ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_AT_PICKUP','OTP_PENDING') and not exists (select 1 from ride_otps o where o.booking_id = b.id);
  if n > 0 then v := v || jsonb_build_object('level', 'high', 'code', 'OTP_NOT_GENERATED', 'count', n, 'message', n || ' accepted ride(s) have no OTP — check the OTP Edge Function and webhook', 'page', 'otp-verification'); end if;
  select count(*) into n from otp_delivery_logs where status in ('failed','not_configured') and created_at > now() - interval '1 hour';
  if n > 0 then v := v || jsonb_build_object('level', 'high', 'code', 'OTP_DELIVERY_FAILING', 'count', n, 'message', n || ' OTP SMS failed in the last hour', 'page', 'otp-verification'); end if;
  select count(*) into n from ride_discrepancies where status = 'open';
  if n > 0 then v := v || jsonb_build_object('level', 'normal', 'code', 'DISTANCE_DISCREPANCIES', 'count', n, 'message', n || ' distance discrepancy(ies) await review', 'page', 'otp-verification'); end if;
  select count(*) into n from drivers d join driver_locations l on l.driver_id = d.id where d.availability = 'on_ride' and l.received_at < now() - make_interval(secs => public.setting_int('tracking.stale_seconds', 180));
  if n > 0 then v := v || jsonb_build_object('level', 'high', 'code', 'RIDE_LOCATION_LOST', 'count', n, 'message', n || ' driver(s) on a ride are not sending location', 'page', 'live-tracking'); end if;
  select count(*) into n from drivers where status in ('pending','under_review');
  if n > 0 then v := v || jsonb_build_object('level', 'normal', 'code', 'PENDING_VERIFICATION', 'count', n, 'message', n || ' driver application(s) await verification', 'page', 'drivers'); end if;
  select count(*) into n from driver_payouts where status in ('pending','approved');
  if n > 0 then v := v || jsonb_build_object('level', 'normal', 'code', 'PAYOUTS_WAITING', 'count', n, 'message', n || ' payout(s) await processing', 'page', 'finance'); end if;
  select count(*) into n from refunds where status in ('pending','processing') and created_at < now() - interval '1 day';
  if n > 0 then v := v || jsonb_build_object('level', 'normal', 'code', 'REFUNDS_STUCK', 'count', n, 'message', n || ' refund(s) have been pending for over a day', 'page', 'finance'); end if;
  select count(*) into n from integration_settings where is_enabled and status in ('error','not_configured');
  if n > 0 then v := v || jsonb_build_object('level', 'high', 'code', 'INTEGRATION_PROBLEM', 'count', n, 'message', n || ' enabled integration(s) are not working', 'page', 'settings'); end if;
  return v;
end $$;

create or replace function public.campaign_analytics() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('marketing.view');
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v from (
    select c.id, c.code, c.is_active, c.used_count, c.total_usage_limit, c.created_at, cp.name as campaign,
      (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'applied') as redemptions,
      (select coalesce(sum(r.discount_paise), 0) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'applied') as discount_given_paise,
      (select coalesce(sum(b.total_fare_paise), 0) from coupon_redemptions r join bookings b on b.id = r.booking_id
        where r.coupon_id = c.id and r.status = 'applied' and b.payment_status = 'paid') as revenue_paise,
      (select count(distinct r.customer_id) from coupon_redemptions r where r.coupon_id = c.id and r.status = 'applied') as unique_customers
    from coupons c left join campaigns cp on cp.id = c.campaign_id
  ) x;
  return v;
end $$;

create or replace function public.recent_activity(p_limit integer default 25) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_permission('dashboard.view');
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v from (
    select a.id, a.action, a.entity_type, a.entity_id, a.actor_type, a.reason, a.created_at, s.full_name as staff_name
    from audit_logs a left join staff_accounts s on s.id = a.actor_staff_id
    order by a.created_at desc limit greatest(1, least(coalesce(p_limit, 25), 100))
  ) x;
  return v;
end $$;

-- Daily report snapshot (pg_cron runs this shortly after midnight IST).
create or replace function public.generate_daily_report(p_date date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_date date := coalesce(p_date, ((now() at time zone 'Asia/Kolkata')::date - 1)); v_from timestamptz; v_to timestamptz; v jsonb;
begin
  if not (public.is_privileged() or public.has_permission('analytics.export')) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  v_from := v_date::timestamp at time zone 'Asia/Kolkata'; v_to := (v_date + 1)::timestamp at time zone 'Asia/Kolkata';
  select jsonb_build_object(
    'date', v_date,
    'bookings', (select count(*) from bookings where created_at >= v_from and created_at < v_to),
    'completed', (select count(*) from bookings where completed_at >= v_from and completed_at < v_to),
    'cancelled', (select count(*) from bookings where cancelled_at >= v_from and cancelled_at < v_to),
    'revenue_paise', (select coalesce(sum(total_fare_paise), 0) from bookings where paid_at >= v_from and paid_at < v_to and payment_status in ('paid','partially_refunded')),
    'commission_paise', (select coalesce(sum(commission_paise), 0) from bookings where paid_at >= v_from and paid_at < v_to and payment_status in ('paid','partially_refunded')),
    'discounts_paise', (select coalesce(sum(discount_paise), 0) from bookings where paid_at >= v_from and paid_at < v_to and payment_status in ('paid','partially_refunded')),
    'refunds_paise', (select coalesce(sum(amount_paise), 0) from refunds where status = 'completed' and completed_at >= v_from and completed_at < v_to),
    'new_customers', (select count(*) from customers where created_at >= v_from and created_at < v_to),
    'new_drivers', (select count(*) from drivers where created_at >= v_from and created_at < v_to),
    'active_drivers', (select count(distinct driver_id) from bookings where completed_at >= v_from and completed_at < v_to),
    'otp_generated', (select count(*) from ride_otps where created_at >= v_from and created_at < v_to),
    'otp_overrides', (select count(*) from ride_otps where status = 'overridden' and created_at >= v_from and created_at < v_to),
    'safety_incidents', (select count(*) from safety_incidents where created_at >= v_from and created_at < v_to),
    'tickets_opened', (select count(*) from support_tickets where created_at >= v_from and created_at < v_to)
  ) into v;
  delete from daily_reports where report_date = v_date and city_id is null;
  insert into daily_reports(report_date, city_id, payload) values (v_date, null, v);
  if public.is_privileged() then
    perform public.notify_staff('analytics.view', 'system', 'normal', 'Daily report for ' || to_char(v_date, 'DD Mon YYYY'),
      (v->>'completed') || ' rides completed, revenue ₹' || round((v->>'revenue_paise')::numeric / 100) || '.', jsonb_build_object('report_date', v_date));
  end if;
  return v;
end $$;

-- Aggregated, non-personal context for the optional AI assistant.
create or replace function public.ai_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  perform public.require_permission('ai.view');
  return jsonb_build_object(
    'today', public.dashboard_stats(v_today, now(), null),
    'last_7_days', public.dashboard_stats(v_today - interval '7 days', now(), null),
    'last_30_days', public.dashboard_stats(v_today - interval '30 days', now(), null),
    'breakdowns_30_days', case when public.has_permission('analytics.view') then public.analytics_breakdowns(v_today - interval '30 days', now(), null) end,
    'alerts', public.operational_alerts());
end $$;
