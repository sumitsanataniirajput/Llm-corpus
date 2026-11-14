-- =====================================================================
-- DEMO / TEST DATA ONLY.  NEVER run this on your live (production) project.
-- Every name, phone number and amount below is invented. It exists so that
-- (a) the automated web test can open every screen with rows in it and
-- (b) you can explore the console on a separate practice project.
-- To remove it, delete the practice project; do not try to clean it by hand.
-- =====================================================================
do $seed$
declare
  v_city uuid; v_zone uuid; v_branch uuid; v_cat uuid; v_staff uuid;
  d1 uuid; d2 uuid; d3 uuid; v1 uuid; v2 uuid; c1 uuid; c2 uuid; c3 uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; p1 uuid; v_camp uuid; v_ticket uuid; v_otp uuid;
begin
  select id into v_staff from staff_accounts order by created_at limit 1;
  select id into v_cat from vehicle_categories where code = 'sedan';

  insert into cities(name, state, center_lat, center_lng, is_active, launched_at) values ('Demo City', 'Demo State', 26.8467, 80.9462, true, current_date - 200) returning id into v_city;
  insert into service_zones(city_id, name, zone_type, polygon, created_by) values
    (v_city, 'Demo service area', 'service_boundary', '[{"lat":26.70,"lng":80.80},{"lat":26.70,"lng":81.10},{"lat":27.00,"lng":81.10},{"lat":27.00,"lng":80.80}]', v_staff) returning id into v_zone;
  insert into service_zones(city_id, name, zone_type, polygon, surge_multiplier_bp) values
    (v_city, 'Demo station surge', 'surge', '[{"lat":26.83,"lng":80.91},{"lat":26.83,"lng":80.93},{"lat":26.84,"lng":80.93},{"lat":26.84,"lng":80.91}]', 15000);
  insert into branches(city_id, name, code, address, phone, manager_staff_id) values (v_city, 'Demo Head Office', 'DEMO-01', '1 Demo Road', '9000000001', v_staff) returning id into v_branch;
  insert into category_city_availability(category_id, city_id, is_enabled) values (v_cat, v_city, true) on conflict do nothing;
  insert into pricing_rules(category_id, city_id, base_fare_paise, per_km_paise, per_minute_paise, minimum_fare_paise, effective_from, created_by)
    values (v_cat, v_city, 5000, 1400, 150, 8000, now() - interval '100 days', v_staff);

  insert into drivers(full_name, phone, email, city_id, branch_id, status, availability, aadhaar_last4, licence_expiry) values
    ('Demo Driver One', '9000000011', 'driver1@example.test', v_city, v_branch, 'approved', 'on_ride', '1234', current_date + 20) returning id into d1;
  insert into drivers(full_name, phone, city_id, status, availability) values ('Demo Driver Two', '9000000012', v_city, 'approved', 'online') returning id into d2;
  insert into drivers(full_name, phone, city_id, status) values ('Demo Driver Three', '9000000013', v_city, 'pending') returning id into d3;
  insert into vehicles(registration_number, category_id, ownership_type, owner_name, manufacturer, model, manufacture_year, color, fuel_type, seating_capacity, city_id, status, odometer_km)
    values ('UP32DM0001', v_cat, 'company', 'Demo Fleet', 'Maruti', 'Dzire', 2022, 'White', 'cng', 4, v_city, 'active', 41000) returning id into v1;
  insert into vehicles(registration_number, category_id, ownership_type, owner_name, owner_driver_id, manufacturer, model, city_id, status)
    values ('UP32DM0002', v_cat, 'driver_owned', 'Demo Driver Two', d2, 'Hyundai', 'Aura', v_city, 'pending') returning id into v2;
  insert into vehicle_assignments(vehicle_id, driver_id, assigned_by) values (v1, d1, v_staff);
  insert into driver_documents(driver_id, doc_type, storage_path, status, expiry_date) values (d1, 'driving_licence', d1 || '/demo-licence.pdf', 'approved', current_date + 20), (d3, 'aadhaar', d3 || '/demo-aadhaar.pdf', 'pending', null);
  insert into vehicle_documents(vehicle_id, doc_type, storage_path, status, expiry_date) values (v1, 'insurance', v1 || '/demo-insurance.pdf', 'approved', current_date + 10);
  insert into vehicle_maintenance(vehicle_id, record_type, description, cost_paise) values (v1, 'service', 'Demo periodic service', 350000);
  insert into driver_notes(driver_id, body, staff_id) values (d1, 'Demo note: polite and punctual.', v_staff);
  insert into driver_incentives(driver_id, incentive_type, amount_paise, reason, created_by) values (d1, 'bonus', 50000, 'Demo festival bonus', v_staff);
  insert into driver_locations(driver_id, lat, lng, heading, speed_kmh, accuracy_m, recorded_at) values (d1, 26.85, 80.95, 90, 32, 8, now()), (d2, 26.86, 80.94, 10, 0, 12, now() - interval '10 minutes');
  insert into tracking_alerts(driver_id, alert_type, message, lat, lng) values (d2, 'stale_location', 'Demo: no position for 10 minutes', 26.86, 80.94);

  insert into customers(full_name, phone, email, city_id) values ('Demo Customer One', '9000000021', 'customer1@example.test', v_city) returning id into c1;
  insert into customers(full_name, phone, city_id, loyalty_tier) values ('Demo Customer Two', '9000000022', v_city, 'gold') returning id into c2;
  insert into customers(full_name, phone, city_id, status) values ('Demo Customer Three', '9000000023', v_city, 'blocked') returning id into c3;
  insert into customer_notes(customer_id, body, staff_id) values (c1, 'Demo note: prefers calls over SMS.', v_staff);

  -- Demo rides are written directly in their final state, so the state-machine trigger is paused for these four rows only.
  alter table bookings disable trigger user;
  insert into bookings(customer_id, category_id, city_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng, booked_distance_km, status, driver_id, vehicle_id, payment_method, payment_status, created_at)
    values (c1, v_cat, v_city, 'Demo Station', 26.832, 80.92, 'Demo Airport', 26.76, 80.88, 12.4, 'PAYMENT_COMPLETED', d1, v1, 'upi', 'paid', now() - interval '2 days') returning id into b1;
  insert into bookings(customer_id, category_id, city_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng, booked_distance_km, status, driver_id, vehicle_id, payment_method)
    values (c2, v_cat, v_city, 'Demo Mall', 26.85, 80.95, 'Demo Park', 26.87, 80.99, 6.1, 'RIDE_STARTED', d1, v1, 'cash') returning id into b2;
  insert into bookings(customer_id, category_id, city_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng, booked_distance_km, status, cancelled_by, cancellation_reason, created_at)
    values (c1, v_cat, v_city, 'Demo Hospital', 26.84, 80.93, 'Demo College', 26.88, 80.96, 5.0, 'CANCELLED', 'customer', 'Demo: changed plans', now() - interval '1 day') returning id into b3;
  insert into bookings(customer_id, category_id, city_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng, booked_distance_km, status, driver_id, payment_method)
    values (c2, v_cat, v_city, 'Demo Market', 26.86, 80.94, 'Demo Colony', 26.90, 80.97, 7.3, 'DRIVER_ACCEPTED', d2, 'cash') returning id into b4;

  alter table bookings enable trigger user;

  insert into ride_otps(booking_id, otp_hash, salt, generation_type, expires_at) values (b4, 'demo-not-a-real-hash', 'demo', 'auto', now() + interval '5 minutes') returning id into v_otp;
  insert into otp_delivery_logs(otp_id, booking_id, channel, provider, status, error) values (v_otp, b4, 'sms', 'none', 'not_configured', 'Demo: no SMS provider configured');
  insert into ride_discrepancies(booking_id, discrepancy_type, expected_km, reported_km) values (b1, 'actual_vs_booked_distance', 12.4, 16.9);
  insert into payments(booking_id, customer_id, amount_paise, method, status, idempotency_key) values (b1, c1, 26500, 'upi', 'captured', 'demo-pay-1') returning id into p1;
  insert into refunds(payment_id, booking_id, amount_paise, reason, idempotency_key, requested_by) values (p1, b1, 5000, 'Demo goodwill refund', 'demo-refund-1', v_staff);
  insert into driver_payouts(driver_id, amount_paise, idempotency_key, requested_by) values (d1, 120000, 'demo-payout-1', v_staff);
  insert into expenses(category, description, amount_paise, created_by) values ('fuel', 'Demo fuel bill', 250000, v_staff);
  insert into payment_webhook_events(provider, event_id, event_type, signature_valid, payload) values ('razorpay', 'demo-evt-1', 'payment.captured', true, '{"demo":true}');
  insert into reviews(booking_id, reviewer_type, driver_id, customer_id, rating, comment) values (b1, 'customer', d1, c1, 5, 'Demo: smooth ride');
  insert into daily_reports(report_date, payload) values (current_date - 1, '{"date":"demo","bookings":3,"completed":1,"cancelled":1,"revenue_paise":26500,"commission_paise":5300,"discounts_paise":0,"refunds_paise":5000}');

  insert into campaigns(name, campaign_type, audience, city_id, budget_paise, status, created_by) values ('Demo launch offer', 'coupon', 'customers', v_city, 5000000, 'active', v_staff) returning id into v_camp;
  insert into coupons(code, discount_type, percent_bp, max_discount_paise, campaign_id, created_by) values ('DEMO10', 'percent', 1000, 10000, v_camp, v_staff);
  insert into referrals(referral_kind, code_used, referrer_customer_id, referee_customer_id) values ('customer', 'DEMOREF', c1, c2);
  insert into announcements(title, body, audience, city_id, is_published, created_by) values ('Demo announcement', 'This is demo text.', 'drivers', v_city, true, v_staff);
  insert into support_tickets(ticket_type, raised_by_type, subject, description, customer_id, booking_id, priority) values ('customer_complaint', 'customer', 'Demo: driver arrived late', 'Demo description of the complaint.', c1, b1, 'high') returning id into v_ticket;
  insert into support_messages(ticket_id, sender_type, body) values (v_ticket, 'customer', 'Demo message from the customer.');
  insert into support_tickets(ticket_type, raised_by_type, subject, description, customer_id, item_description, item_status) values ('lost_and_found', 'customer', 'Demo: left a bag', 'Demo lost item.', c2, 'Blue bag', 'reported');
  insert into support_tickets(ticket_type, raised_by_type, subject, description, driver_id) values ('fraud_report', 'staff', 'Demo: suspicious trips', 'Demo fraud report.', d2);
  insert into safety_incidents(incident_type, reported_by_type, severity, description, booking_id, driver_id, customer_id, lat, lng) values ('sos', 'customer', 'critical', 'Demo SOS pressed', b2, d1, c2, 26.855, 80.96);
  insert into notifications(audience, title, body, category, priority, channels, created_by) values ('all_drivers', 'Demo notification', 'Demo body', 'announcement', 'normal', array['in_app','push'], v_staff);
end $seed$;
