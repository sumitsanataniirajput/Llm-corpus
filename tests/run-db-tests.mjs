// Automated backend tests. Runs every migration on a real PostgreSQL engine
// (PGlite) and exercises the business logic end to end.
//   cd tests && npm install && npm run test:db
// Uses synthetic data only — never production customer or identity data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, asUser, asService, asAnon, rpc, one, all } from './lib/db.mjs';

const db = await createDb();
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, process.env.VERBOSE ? 12 : 1).join('\n      ')}`); if (process.env.VERBOSE) console.log(String(e.stack).split('\n').filter((l) => l.includes('run-db-tests')).slice(0, 2).join('\n')); await db.exec('reset role').catch(() => {}); }
}
const section = (s) => console.log(`\n${s}`);
async function rejects(fn, pattern, label) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `${label || 'call'} should have been rejected`);
  if (pattern) assert.match(err.message, pattern);
}

// ---------- fixtures ----------
const mkUser = async (email) => ({ id: (await one(db, 'insert into auth.users(email) values ($1) returning id', [email])).id, session: randomUUID(), email });
const owner = await mkUser('owner@example.test');
const city = (await one(db, `insert into cities(name, state, center_lat, center_lng, is_active) values ('Testpur','Test State',26.85,80.95,true) returning id`)).id;
const city2 = (await one(db, `insert into cities(name, state, is_active) values ('Othertown','Test State',true) returning id`)).id;
const cat = async (code) => (await one(db, 'select id from vehicle_categories where code = $1', [code])).id;
const sedan = await cat('sedan'), bike = await cat('bike');
const staff = {};          // role code -> user
const login = (u) => asUser(db, u, () => rpc(db, 'begin_session', { p_device: 'test' }));

section('Bootstrap, authentication and sessions');
await test('bootstrap_super_admin creates the first owner (SQL editor only)', async () => {
  assert.match(await rpc(db, 'bootstrap_super_admin', { p_email: owner.email, p_full_name: 'Owner One' }), /Super Admin created/);
  await rejects(() => rpc(db, 'bootstrap_super_admin', { p_email: owner.email }), /already exists/);
});
await test('bootstrap cannot be called through the API', async () => {
  await rejects(() => asUser(db, owner, () => rpc(db, 'bootstrap_super_admin', { p_email: owner.email })), /permission denied|SQL editor/);
});
await test('no permission without a registered session', async () => {
  const before = await asUser(db, owner, () => one(db, `select public.has_permission('drivers.view') as ok`));
  assert.equal(before.ok, false);
  const s = await login(owner);
  assert.equal(s.ok, true);
  const after = await asUser(db, owner, () => one(db, `select public.has_permission('drivers.view') as ok`));
  assert.equal(after.ok, true);
});
await test('staff creation is service-role only and respects role rank', async () => {
  const ownerStaff = (await one(db, 'select id from staff_accounts where user_id = $1', [owner.id])).id;
  for (const role of ['administrator', 'operations_manager', 'city_manager', 'finance_manager', 'customer_support_agent', 'driver_verification_officer', 'readonly_analyst', 'safety_officer']) {
    const u = await mkUser(`${role}@example.test`);
    u.staffId = await asService(db, () => rpc(db, 'create_staff_record', {
      p_actor_staff_id: ownerStaff, p_user_id: u.id, p_full_name: role.replace(/_/g, ' '), p_email: u.email, p_phone: null, p_role_code: role,
      p_city_scope: role === 'city_manager' ? [city] : null }));
    staff[role] = u; await login(u);
  }
  owner.staffId = ownerStaff;
  await rejects(() => asUser(db, owner, () => rpc(db, 'create_staff_record', { p_actor_staff_id: ownerStaff, p_user_id: owner.id, p_full_name: 'x', p_email: 'x@x', p_phone: null, p_role_code: 'administrator' })), /permission denied/);
  const u = await mkUser('escalate@example.test');
  await rejects(() => asService(db, () => rpc(db, 'create_staff_record', { p_actor_staff_id: staff.operations_manager.staffId, p_user_id: u.id, p_full_name: 'x', p_email: u.email, p_phone: null, p_role_code: 'administrator' })), /staff\.manage|ROLE_ABOVE/);
});
await test('my_access returns role and permissions', async () => {
  const a = await asUser(db, staff.finance_manager, () => rpc(db, 'my_access'));
  assert.equal(a.ok, true); assert.equal(a.role.code, 'finance_manager');
  assert.ok(a.permissions.includes('finance.refund')); assert.ok(!a.permissions.includes('otp.override'));
});
await test('revoking a session removes access immediately', async () => {
  const u = staff.readonly_analyst;
  await asUser(db, owner, () => rpc(db, 'revoke_session', { p_session_id: u.session, p_reason: 'test revoke' }));
  assert.equal((await asUser(db, u, () => one(db, `select public.has_permission('dashboard.view') as ok`))).ok, false);
  assert.equal((await login(u)).code, 'SESSION_REVOKED');
  u.session = randomUUID(); assert.equal((await login(u)).ok, true);
});
await test('repeated failed logins lock the account; unlock restores it', async () => {
  const u = staff.customer_support_agent;
  for (let i = 0; i < 5; i++) await asAnon(db, () => rpc(db, 'record_login_failure', { p_email: u.email }));
  assert.equal((await asAnon(db, () => rpc(db, 'login_precheck', { p_email: u.email }))).code, 'LOCKED');
  const fresh = { ...u, session: randomUUID() };
  assert.equal((await login(fresh)).code, 'LOCKED');
  await asUser(db, owner, () => rpc(db, 'update_staff', { p_staff_id: u.staffId, p_unlock: true }));
  assert.equal((await asAnon(db, () => rpc(db, 'login_precheck', { p_email: u.email }))).allowed, true);
});
await test('MFA-required staff have no access at aal1', async () => {
  const u = staff.safety_officer;
  await asUser(db, owner, () => rpc(db, 'update_staff', { p_staff_id: u.staffId, p_mfa_required: true }));
  assert.equal((await asUser(db, u, () => one(db, `select public.has_permission('safety.view') as ok`))).ok, false);
  assert.equal((await asUser(db, u, () => rpc(db, 'my_access'))).code, 'MFA_REQUIRED');
  assert.equal((await asUser(db, { ...u, aal: 'aal2' }, () => one(db, `select public.has_permission('safety.view') as ok`))).ok, true);
  await asUser(db, owner, () => rpc(db, 'update_staff', { p_staff_id: u.staffId, p_mfa_required: false }));
});
await test('IP allow-list blocks requests from other addresses', async () => {
  const id = (await one(db, `insert into ip_rules(cidr, action) values ('203.0.113.0/24','allow') returning id`)).id;
  const inside = { ...owner, headers: { 'x-forwarded-for': '203.0.113.9' } }, outside = { ...owner, headers: { 'x-forwarded-for': '198.51.100.7' } };
  assert.equal((await asUser(db, inside, () => one(db, `select public.has_permission('drivers.view') as ok`))).ok, true);
  assert.equal((await asUser(db, outside, () => one(db, `select public.has_permission('drivers.view') as ok`))).ok, false);
  await db.query('delete from ip_rules where id = $1', [id]);
});
await test('suspending staff revokes their sessions; last super admin is protected', async () => {
  const u = staff.driver_verification_officer;
  await asUser(db, owner, () => rpc(db, 'update_staff', { p_staff_id: u.staffId, p_status: 'suspended', p_reason: 'test suspension' }));
  assert.equal((await asUser(db, u, () => one(db, `select public.has_permission('drivers.verify') as ok`))).ok, false);
  await asUser(db, owner, () => rpc(db, 'update_staff', { p_staff_id: u.staffId, p_status: 'active' }));
  u.session = randomUUID(); await login(u);
  await rejects(() => asUser(db, owner, () => rpc(db, 'update_staff', { p_staff_id: owner.staffId, p_status: 'suspended', p_reason: 'self lock' })), /SELF_CHANGE/);
  await rejects(() => asUser(db, staff.administrator, () => rpc(db, 'update_staff', { p_staff_id: owner.staffId, p_status: 'suspended', p_reason: 'take over' })), /ROLE_ABOVE/);
});
await test('role permission matrix can be edited, but not above your level', async () => {
  await asUser(db, owner, () => rpc(db, 'set_role_permission', { p_role_code: 'readonly_analyst', p_permission: 'rides.export', p_grant: true }));
  assert.equal((await asUser(db, staff.readonly_analyst, () => one(db, `select public.has_permission('rides.export') as ok`))).ok, true);
  await asUser(db, owner, () => rpc(db, 'set_role_permission', { p_role_code: 'readonly_analyst', p_permission: 'rides.export', p_grant: false }));
  await rejects(() => asUser(db, owner, () => rpc(db, 'set_role_permission', { p_role_code: 'super_admin', p_permission: 'rides.export', p_grant: false })), /SUPER_ADMIN_FIXED/);
  await rejects(() => asUser(db, staff.operations_manager, () => rpc(db, 'set_role_permission', { p_role_code: 'readonly_analyst', p_permission: 'otp.override', p_grant: true })), /PERMISSION_DENIED/);
});

// ---------- people & fleet ----------
section('Drivers, vehicles, customers and RLS');
const drivers = [], customers = [];
const mkDriver = async (name, phone, cityId = city) => {
  const u = await mkUser(`${phone}@driver.test`);
  const d = await asUser(db, staff.driver_verification_officer, () => one(db,
    `insert into drivers(full_name, phone, city_id, aadhaar_last4) values ($1,$2,$3,'1234') returning id, driver_code, status`, [name, phone, cityId]));
  await db.query('update drivers set user_id = $1, location_consent_at = now() where id = $2', [u.id, d.id]);
  return { ...u, driverId: d.id, code: d.driver_code };
};
await test('verification officer registers a driver; codes are unique', async () => {
  drivers.push(await mkDriver('Asha Verma', '9000000001'), await mkDriver('Bala Singh', '9000000002'), await mkDriver('Chand Rao', '9000000003'));
  assert.match(drivers[0].code, /^DRV-\d{6}$/);
  assert.notEqual(drivers[0].code, drivers[1].code);
});
await test('a driver cannot be approved until required documents are approved', async () => {
  const d = drivers[0];
  await rejects(() => asUser(db, staff.driver_verification_officer, () => rpc(db, 'set_driver_status', { p_driver_id: d.driverId, p_status: 'approved' })), /DOCUMENTS_INCOMPLETE/);
});
await test('document rejection requires a reason; approval + history recorded', async () => {
  for (const d of drivers) {
    for (const t of ['aadhaar', 'pan', 'driving_licence', 'photo']) {
      const doc = await asUser(db, staff.driver_verification_officer, () => one(db,
        `insert into driver_documents(driver_id, doc_type, storage_path, expiry_date) values ($1,$2,$3,$4) returning id`,
        [d.driverId, t, `${d.driverId}/${t}.jpg`, t === 'driving_licence' ? '2030-01-01' : null]));
      if (d === drivers[0] && t === 'pan') {
        await rejects(() => asUser(db, staff.driver_verification_officer, () => rpc(db, 'review_driver_document', { p_document_id: doc.id, p_approve: false })), /REASON_REQUIRED/);
        await asUser(db, staff.driver_verification_officer, () => rpc(db, 'review_driver_document', { p_document_id: doc.id, p_approve: false, p_reason: 'Image is blurred' }));
      }
      await asUser(db, staff.driver_verification_officer, () => rpc(db, 'review_driver_document', { p_document_id: doc.id, p_approve: true, p_notes: 'checked against original' }));
    }
    await asUser(db, staff.driver_verification_officer, () => rpc(db, 'set_driver_status', { p_driver_id: d.driverId, p_status: 'approved' }));
  }
  const h = await all(db, 'select action from driver_verifications where driver_id = $1', [drivers[0].driverId]);
  assert.ok(h.some((x) => x.action === 'document_pan_rejected') && h.some((x) => x.action === 'status_change'));
});
await test('driver status cannot be changed by a direct table update', async () => {
  await rejects(() => asUser(db, staff.administrator, () => db.query(`update drivers set status = 'blacklisted' where id = $1`, [drivers[2].driverId])), /permission denied/);
  await rejects(() => asUser(db, staff.city_manager, () => rpc(db, 'set_driver_status', { p_driver_id: drivers[2].driverId, p_status: 'blacklisted', p_reason: 'not allowed' })), /PERMISSION_DENIED/);
});
const vehicles = [];
await test('vehicle registration, document approval, activation and assignment', async () => {
  for (const [i, reg] of ['UP32AB1001', 'UP32AB1002', 'UP32AB1003'].entries()) {
    const v = await asUser(db, staff.operations_manager, () => one(db,
      `insert into vehicles(registration_number, category_id, ownership_type, owner_name, owner_driver_id, manufacturer, model, city_id)
       values ($1,$2,$3,$4,$5,'Maruti','Dzire',$6) returning id, vehicle_code`, [reg, sedan, i === 0 ? 'driver_owned' : 'company', i === 0 ? 'Asha Verma' : 'Company', i === 0 ? drivers[0].driverId : null, city]));
    if (i === 0) await rejects(() => asUser(db, staff.operations_manager, () => rpc(db, 'set_vehicle_status', { p_vehicle_id: v.id, p_status: 'active' })), /DOCUMENTS_INCOMPLETE/);
    for (const t of ['rc', 'insurance']) {
      const doc = await asUser(db, staff.operations_manager, () => one(db, `insert into vehicle_documents(vehicle_id, doc_type, storage_path, expiry_date) values ($1,$2,$3,'2030-01-01') returning id`, [v.id, t, `${v.id}/${t}.pdf`]));
      await asUser(db, staff.operations_manager, () => rpc(db, 'review_vehicle_document', { p_document_id: doc.id, p_approve: true }));
    }
    await asUser(db, staff.operations_manager, () => rpc(db, 'set_vehicle_status', { p_vehicle_id: v.id, p_status: 'active' }));
    await asUser(db, staff.operations_manager, () => rpc(db, 'assign_vehicle', { p_vehicle_id: v.id, p_driver_id: drivers[i].driverId }));
    vehicles.push(v);
  }
  // Re-assigning a vehicle moves it; a vehicle never has two active drivers.
  await asUser(db, staff.operations_manager, () => rpc(db, 'assign_vehicle', { p_vehicle_id: vehicles[2].id, p_driver_id: drivers[2].driverId }));
  assert.equal((await one(db, 'select count(*)::int n from vehicle_assignments where vehicle_id = $1 and is_active', [vehicles[2].id])).n, 1);
});
await test('customers: PII is masked without customers.view_pii', async () => {
  for (const [n, p] of [['Deepa Nair', '9811111111'], ['Eshan Gupta', '9822222222']]) {
    const u = await mkUser(`${p}@customer.test`);
    const c = await asUser(db, staff.operations_manager, () => one(db, `insert into customers(full_name, phone, email, city_id) values ($1,$2,$3,$4) returning id, customer_code`, [n, p, `${p}@mail.test`, city]));
    await db.query('update customers set user_id = $1 where id = $2', [u.id, c.id]);
    customers.push({ ...u, customerId: c.id });
  }
  const masked = await asUser(db, staff.readonly_analyst, () => one(db, 'select phone, email from customer_directory where id = $1', [customers[0].customerId]));
  assert.equal(masked.phone, '******1111'); assert.match(masked.email, /\*\*\*@/);
  const full = await asUser(db, staff.operations_manager, () => one(db, 'select phone from customer_directory where id = $1', [customers[0].customerId]));
  assert.equal(full.phone, '9811111111');
  assert.equal((await asUser(db, staff.readonly_analyst, () => all(db, 'select id from customers'))).length, 0, 'base table hidden without view_pii');
});
await test('RLS: roles only see what their permissions allow', async () => {
  assert.equal((await asUser(db, staff.customer_support_agent, () => all(db, 'select id from payments'))).length, 0);
  assert.equal((await asUser(db, staff.finance_manager, () => all(db, 'select id from driver_documents'))).length, 0);
  assert.ok((await asUser(db, staff.driver_verification_officer, () => all(db, 'select id from driver_documents'))).length > 0);
  await rejects(() => asUser(db, staff.readonly_analyst, () => db.query(`insert into drivers(full_name, phone) values ('X','9000000099')`)), /row-level security/);
  await rejects(() => asUser(db, owner, () => db.query('select * from ride_otps')), /permission denied/);
  await rejects(() => asAnon(db, () => db.query('select * from drivers')), /permission denied/);
});
await test('RLS: city scope limits a city manager', async () => {
  const other = await mkDriver('Other City', '9000000050', city2);
  const seen = await asUser(db, staff.city_manager, () => all(db, 'select id from drivers'));
  assert.ok(seen.length >= 3 && !seen.some((d) => d.id === other.driverId));
});
await test('drivers and customers only see their own rows', async () => {
  assert.equal((await asUser(db, drivers[0], () => all(db, 'select id from drivers'))).length, 1);
  assert.equal((await asUser(db, customers[0], () => all(db, 'select id from customers'))).length, 1);
  assert.equal((await asUser(db, customers[0], () => all(db, 'select id from drivers'))).length, 0);
});

// ---------- pricing & booking ----------
section('Pricing, coupons and booking creation');
await test('fare is calculated server-side in integer paise', async () => {
  await asUser(db, staff.administrator, () => db.query(
    `insert into pricing_rules(category_id, city_id, base_fare_paise, per_km_paise, per_minute_paise, minimum_fare_paise, cancellation_fee_paise,
       night_multiplier_bp, commission_bp, gst_bp, effective_from, peak_windows)
     values ($1,$2,5000,1200,100,8000,3000,12500,2000,500, '2026-01-01', '[]')`, [sedan, city]));
  const f = await asUser(db, staff.readonly_analyst, () => rpc(db, 'calculate_fare', { p_category_id: sedan, p_city_id: city, p_distance_km: 10, p_duration_min: 20, p_at: '2026-06-01T06:30:00Z' }));  // 12:00 IST
  assert.equal(f.base_fare_paise, 5000); assert.equal(f.distance_fare_paise, 12000); assert.equal(f.time_fare_paise, 2000);
  assert.equal(f.gross_fare_paise, 19000); assert.equal(f.tax_paise, 950); assert.equal(f.total_fare_paise, 19950);
  assert.equal(f.commission_paise, 3800); assert.equal(f.driver_earning_paise, 15200);
  const night = await asUser(db, staff.readonly_analyst, () => rpc(db, 'calculate_fare', { p_category_id: sedan, p_city_id: city, p_distance_km: 10, p_duration_min: 20, p_at: '2026-06-01T18:30:00Z' })); // 00:00 IST
  assert.equal(night.gross_fare_paise, 23750);
  const min = await asUser(db, staff.readonly_analyst, () => rpc(db, 'calculate_fare', { p_category_id: sedan, p_city_id: city, p_distance_km: 0.5, p_duration_min: 2, p_at: '2026-06-01T06:30:00Z' }));
  assert.equal(min.gross_fare_paise, 8000); assert.equal(min.minimum_fare_applied, true);
  assert.equal((await all(db, 'select 1 from pricing_history')).length, 1, 'pricing history recorded');
  await rejects(() => asUser(db, staff.readonly_analyst, () => rpc(db, 'calculate_fare', { p_category_id: bike, p_city_id: city, p_distance_km: 5 })), /NO_PRICING_RULE/);
});
const bookingArgs = (cust, extra = {}) => ({ p_customer_id: cust.customerId, p_category_id: sedan, p_city_id: city,
  p_pickup_address: 'Hazratganj', p_pickup_lat: 26.8500, p_pickup_lng: 80.9500, p_drop_address: 'Gomti Nagar', p_drop_lat: 26.8600, p_drop_lng: 81.0100, ...extra });
const svcBooking = (cust, km = 8, extra = {}) => asService(db, () => rpc(db, 'create_booking', { ...bookingArgs(cust, extra), p_route_distance_km: km, p_route_duration_min: 20 }));
let coupon;
await test('booking: server computes distance; client-supplied distance is ignored for non-service callers', async () => {
  const b = await asUser(db, staff.operations_manager, () => rpc(db, 'create_booking', { ...bookingArgs(customers[0]), p_route_distance_km: 1 }));
  assert.equal(b.status, 'DRIVER_SEARCHING'); assert.equal(b.distance_source, 'haversine_estimate');
  assert.ok(Number(b.booked_distance_km) > 7 && Number(b.booked_distance_km) < 9, `haversine*1.3 expected ~7.9, got ${b.booked_distance_km}`);
  assert.equal(b.created_via, 'manager_console'); assert.match(b.booking_code, /^BKG-\d{6}$/);
  const s = await svcBooking(customers[0], 8.42);
  assert.equal(Number(s.booked_distance_km), 8.42); assert.equal(s.distance_source, 'google_routes');
  assert.equal(Number((await one(db, 'select original_booked_distance_km k from ride_distance_records where booking_id = $1', [s.id])).k), 8.42);
  await asUser(db, staff.operations_manager, () => rpc(db, 'cancel_booking', { p_booking_id: b.id, p_reason: 'test cleanup' }));
  await asUser(db, staff.operations_manager, () => rpc(db, 'cancel_booking', { p_booking_id: s.id, p_reason: 'test cleanup' }));
});
await test('booking is refused for blocked customers, other customers and unauthorised roles', async () => {
  await rejects(() => asUser(db, customers[1], () => rpc(db, 'create_booking', bookingArgs(customers[0]))), /PERMISSION_DENIED/);
  await rejects(() => asUser(db, staff.readonly_analyst, () => rpc(db, 'create_booking', bookingArgs(customers[0]))), /PERMISSION_DENIED/);
  await asUser(db, staff.operations_manager, () => rpc(db, 'set_customer_status', { p_customer_id: customers[1].customerId, p_status: 'blocked', p_reason: 'test block' }));
  await rejects(() => svcBooking(customers[1]), /CUSTOMER_NOT_ACTIVE/);
  await asUser(db, staff.operations_manager, () => rpc(db, 'set_customer_status', { p_customer_id: customers[1].customerId, p_status: 'active', p_reason: 'test unblock' }));
});
await test('coupons: server validation, single use, expiry, release on cancel', async () => {
  coupon = await asUser(db, staff.administrator, () => one(db, `insert into coupons(code, discount_type, percent_bp, max_discount_paise, per_customer_limit) values ('WELCOME20','percent',2000,3000,1) returning id`));
  const b = await svcBooking(customers[0], 10, { p_coupon_code: 'welcome20' });
  assert.equal(Number(b.discount_paise), 3000, 'capped at max discount');
  await rejects(() => svcBooking(customers[0], 10, { p_coupon_code: 'WELCOME20' }), /COUPON_ALREADY_USED/);
  await asUser(db, staff.operations_manager, () => rpc(db, 'cancel_booking', { p_booking_id: b.id, p_reason: 'customer changed plan' }));
  assert.equal((await one(db, 'select used_count from coupons where id = $1', [coupon.id])).used_count, 0, 'released on cancel');
  await db.query(`insert into coupons(code, discount_type, fixed_paise, valid_until) values ('OLD50','fixed',5000, now() - interval '1 day')`);
  await rejects(() => svcBooking(customers[0], 10, { p_coupon_code: 'OLD50' }), /COUPON_EXPIRED/);
  await rejects(() => svcBooking(customers[0], 10, { p_coupon_code: 'NOPE' }), /COUPON_INVALID/);
});
await test('zones: restricted pickup and service boundary are enforced', async () => {
  const sq = (a, b, c, d) => JSON.stringify([{ lat: a, lng: b }, { lat: a, lng: d }, { lat: c, lng: d }, { lat: c, lng: b }]);
  const z = await asUser(db, staff.administrator, () => one(db, `insert into service_zones(city_id, name, zone_type, polygon) values ($1,'Cantonment','restricted',$2) returning id`, [city, sq(26.90, 80.90, 26.92, 80.92)]));
  await rejects(() => svcBooking(customers[0], 5, { p_pickup_lat: 26.91, p_pickup_lng: 80.91 }), /RESTRICTED_ZONE/);
  const sb = await asUser(db, staff.administrator, () => one(db, `insert into service_zones(city_id, name, zone_type, polygon) values ($1,'City limit','service_boundary',$2) returning id`, [city, sq(26.70, 80.80, 27.00, 81.10)]));
  await rejects(() => svcBooking(customers[0], 5, { p_pickup_lat: 27.50, p_pickup_lng: 81.50 }), /OUTSIDE_SERVICE_AREA/);
  await db.query('delete from service_zones where id = $1', [sb.id]);
  globalThis.restrictedZone = z.id;
});

// ---------- lifecycle ----------
section('Ride state machine and driver assignment');
const goOnline = (d) => asUser(db, d, () => rpc(db, 'set_driver_availability', { p_online: true }));
for (const d of drivers) await goOnline(d);
const fix = (d, lat, lng, secondsAgo, extra = {}) => asUser(db, d, () => rpc(db, 'ingest_driver_location',
  { p_lat: lat, p_lng: lng, p_recorded_at: new Date(Date.now() - secondsAgo * 1000).toISOString(), p_speed_kmh: 30, p_accuracy_m: 8, ...extra }));
let B;   // main booking
await test('status cannot be changed by direct update, even by the table owner path', async () => {
  B = await svcBooking(customers[0], 8.4);
  await rejects(() => asUser(db, owner, () => db.query(`update bookings set status = 'RIDE_STARTED' where id = $1`, [B.id])), /permission denied|row-level/);
  await rejects(() => db.query(`update bookings set status = 'RIDE_STARTED' where id = $1`, [B.id]), /BOOKING_WRITE_FORBIDDEN/);
  await db.query(`select set_config('app.booking_write','1',false)`);
  await rejects(() => db.query(`update bookings set status = 'RIDE_STARTED' where id = $1`, [B.id]), /INVALID_TRANSITION/);
  await db.query(`select set_config('app.booking_write','',false)`);
});
await test('allocation candidates are ranked by proximity; assignment validates the driver', async () => {
  await fix(drivers[0], 26.8510, 80.9510, 5); await fix(drivers[1], 26.8900, 80.9900, 5);
  const c = await asUser(db, staff.operations_manager, () => rpc(db, 'allocation_candidates', { p_booking_id: B.id }));
  assert.equal(c[0].driver_id, drivers[0].driverId); assert.equal(c[0].location_live, true);
  await rejects(() => asUser(db, staff.readonly_analyst, () => rpc(db, 'assign_driver', { p_booking_id: B.id, p_driver_id: drivers[0].driverId })), /PERMISSION_DENIED/);
  const a = await asUser(db, staff.operations_manager, () => rpc(db, 'assign_driver', { p_booking_id: B.id, p_driver_id: drivers[0].driverId }));
  assert.equal(a.status, 'DRIVER_ASSIGNED'); assert.equal(a.vehicle_id, vehicles[0].id);
});
await test('a driver / vehicle cannot be on two active rides', async () => {
  const b2 = await svcBooking(customers[1], 5);
  await rejects(() => asUser(db, staff.operations_manager, () => rpc(db, 'assign_driver', { p_booking_id: b2.id, p_driver_id: drivers[0].driverId })), /DRIVER_BUSY/);
  globalThis.B2 = b2;
});
await test('only the assigned driver can accept; reassignment needs a reason', async () => {
  await rejects(() => asUser(db, drivers[1], () => rpc(db, 'driver_respond_assignment', { p_booking_id: B.id, p_accept: true })), /NOT_ASSIGNED_DRIVER/);
  await rejects(() => asUser(db, staff.operations_manager, () => rpc(db, 'assign_driver', { p_booking_id: B.id, p_driver_id: drivers[1].driverId })), /REASON_REQUIRED/);
  const r = await asUser(db, drivers[0], () => rpc(db, 'driver_respond_assignment', { p_booking_id: B.id, p_accept: true }));
  assert.equal(r.booking.status, 'DRIVER_ACCEPTED'); assert.equal(r.otp_required, true);
  assert.equal((await one(db, 'select availability a from drivers where id = $1', [drivers[0].driverId])).a, 'on_ride');
});
await test('ride cannot start without OTP verification', async () => {
  await rejects(() => asUser(db, drivers[0], () => rpc(db, 'driver_update_ride', { p_booking_id: B.id, p_action: 'start' })), /RIDE_START_NOT_AUTHORIZED/);
});

// ---------- OTP ----------
section('OTP verification centre');
const issue = (id, type = 'auto', staffId = null) => asService(db, () => rpc(db, 'otp_issue', { p_booking_id: id, p_generation_type: type, p_staff_id: staffId }));
const verify = (d, id, otp, km) => asUser(db, d, () => rpc(db, 'otp_verify', { p_booking_id: id, p_otp: otp, p_confirmed_distance_km: km }));
const wrong = (otp) => String((Number(otp) + 1) % 1000000).padStart(6, '0');
let O;
await test('OTP issue is service-role only; only a hash is stored', async () => {
  await rejects(() => asUser(db, owner, () => rpc(db, 'otp_issue', { p_booking_id: B.id })), /permission denied/);
  O = await issue(B.id);
  assert.equal(O.ok, true); assert.match(O.otp, /^\d{6}$/); assert.equal(O.phone, '9811111111');
  const row = await one(db, 'select * from ride_otps where id = $1', [O.otp_id]);
  assert.notEqual(row.otp_hash, O.otp); assert.equal(row.otp_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes(`"${O.otp}"`), 'plaintext OTP must not be stored');
  const logs = await all(db, 'select details::text d from otp_audit_logs where booking_id = $1', [B.id]);
  assert.ok(!logs.some((l) => l.d.includes(O.otp)), 'OTP must not appear in audit logs');
  assert.equal((await issue(B.id)).code, 'ALREADY_ACTIVE', 'webhook retry is idempotent');
});
await test('delivery outcome is logged honestly (not_configured raises an alert)', async () => {
  await asService(db, () => rpc(db, 'otp_record_delivery', { p_otp_id: O.otp_id, p_channel: 'sms', p_provider: 'none', p_status: 'not_configured' }));
  const n = await one(db, `select count(*)::int n from notifications where title like 'OTP delivery failed%'`);
  assert.ok(n.n > 0);
  await asService(db, () => rpc(db, 'otp_record_delivery', { p_otp_id: O.otp_id, p_channel: 'sms', p_provider: 'msg91', p_status: 'sent', p_provider_message_id: 'MSG-1' }));
  assert.equal(await asService(db, () => rpc(db, 'otp_update_delivery_status', { p_provider: 'msg91', p_provider_message_id: 'MSG-1', p_status: 'delivered' })), true);
  assert.equal((await one(db, `select phone_masked p from otp_delivery_logs where provider_message_id = 'MSG-1'`)).p, '******1111');
});
await test('OTP is rejected before the driver has arrived', async () => {
  assert.equal((await verify(drivers[0], B.id, O.otp, 8.4)).code, 'INVALID_STATE');
  const r = await asUser(db, drivers[0], () => rpc(db, 'driver_update_ride', { p_booking_id: B.id, p_action: 'arrived' }));
  assert.equal(r.status, 'OTP_PENDING');
});
await test('driver OTP screen shows booked distance, addresses and fare', async () => {
  const c = await asUser(db, drivers[0], () => rpc(db, 'driver_otp_context', { p_booking_id: B.id }));
  assert.equal(Number(c.booked_distance_km), 8.4); assert.equal(c.customer_first_name, 'Deepa'); assert.ok(c.estimated_fare_paise > 0);
  await rejects(() => asUser(db, drivers[1], () => rpc(db, 'driver_otp_context', { p_booking_id: B.id })), /NOT_ASSIGNED_DRIVER/);
});
await test('a driver who is not assigned is refused and flagged as suspicious', async () => {
  assert.equal((await verify(drivers[1], B.id, O.otp, 8.4)).code, 'NOT_ASSIGNED_DRIVER');
  assert.equal((await one(db, `select is_suspicious s from otp_verification_attempts where result = 'not_assigned_driver' and booking_id = $1`, [B.id])).s, true);
});
await test('distance mismatch blocks verification and raises a discrepancy', async () => {
  const r = await verify(drivers[0], B.id, O.otp, 12);
  assert.equal(r.code, 'DISTANCE_MISMATCH');
  const d = await one(db, `select * from ride_discrepancies where booking_id = $1 and status = 'open'`, [B.id]);
  assert.equal(Number(d.expected_km), 8.4); assert.equal(Number(d.reported_km), 12);
  assert.equal((await one(db, 'select attempt_count a from ride_otps where id = $1', [O.otp_id])).a, 0, 'mismatch does not burn an OTP attempt');
  await asUser(db, staff.operations_manager, () => rpc(db, 'resolve_distance_discrepancy', { p_discrepancy_id: d.id, p_action: 'dismiss', p_corrected_km: null, p_reason: 'Driver mistyped the distance' }));
});
await test('incorrect OTP counts attempts and reports the remainder', async () => {
  const r = await verify(drivers[0], B.id, wrong(O.otp), 8.4);
  assert.equal(r.code, 'INCORRECT_OTP'); assert.equal(r.attempts_remaining, 4);
  assert.equal((await verify(drivers[0], B.id, 'abc', 8.4)).attempts_remaining, 3);
});
await test('correct OTP + matching distance authorises the ride atomically', async () => {
  const r = await verify(drivers[0], B.id, O.otp, 8.4);
  assert.equal(r.ok, true); assert.equal(r.ride_start_authorized, true);
  const b = await one(db, 'select status, ride_start_authorized_at, otp_verified_at from bookings where id = $1', [B.id]);
  assert.equal(b.status, 'OTP_VERIFIED'); assert.ok(b.ride_start_authorized_at && b.otp_verified_at);
  const dr = await one(db, 'select driver_confirmed_distance_km k, driver_confirmed_at t from ride_distance_records where booking_id = $1', [B.id]);
  assert.equal(Number(dr.k), 8.4); assert.ok(dr.t);
});
await test('replay of a used OTP is refused', async () => {
  assert.equal((await verify(drivers[0], B.id, O.otp, 8.4)).code, 'ALREADY_VERIFIED');
});
await test('ride starts once; a duplicate start is refused', async () => {
  const r = await asUser(db, drivers[0], () => rpc(db, 'driver_update_ride', { p_booking_id: B.id, p_action: 'start' }));
  assert.equal(r.status, 'RIDE_STARTED');
  await rejects(() => asUser(db, drivers[0], () => rpc(db, 'driver_update_ride', { p_booking_id: B.id, p_action: 'start' })), /ALREADY_STARTED/);
});

// second booking: lockout, expiry, resend, override, cancel
const B2 = globalThis.B2;
const toOtpPending = async (b, d) => {
  await asUser(db, staff.operations_manager, () => rpc(db, 'assign_driver', { p_booking_id: b.id, p_driver_id: d.driverId }));
  await asUser(db, d, () => rpc(db, 'driver_respond_assignment', { p_booking_id: b.id, p_accept: true }));
  const o = await issue(b.id);
  await asUser(db, d, () => rpc(db, 'driver_update_ride', { p_booking_id: b.id, p_action: 'arrived' }));
  return o;
};
let O2;
await test('five incorrect attempts lock the OTP; the correct OTP is then refused', async () => {
  O2 = await toOtpPending(B2, drivers[1]);
  let r;
  for (let i = 0; i < 5; i++) r = await verify(drivers[1], B2.id, wrong(O2.otp), 5);
  assert.equal(r.code, 'LOCKED'); assert.ok(r.locked_until);
  assert.equal((await verify(drivers[1], B2.id, O2.otp, 5)).code, 'LOCKED');
  assert.equal((await issue(B2.id, 'resend')).code, 'LOCKED', 'resend is refused during lockout');
  assert.ok((await one(db, `select count(*)::int n from otp_verification_attempts where booking_id = $1 and is_suspicious`, [B2.id])).n >= 3);
});
await test('authorised manual generation works after lockout; unauthorised staff are refused', async () => {
  await rejects(() => issue(B2.id, 'manual', staff.customer_support_agent.staffId), /otp\.generate/);
  O2 = await issue(B2.id, 'manual', staff.operations_manager.staffId);
  assert.equal(O2.ok, true);
});
await test('expired OTP is refused; resend issues a new one; old OTP stops working', async () => {
  await db.query(`update ride_otps set expires_at = now() - interval '1 second' where id = $1`, [O2.otp_id]);
  assert.equal((await verify(drivers[1], B2.id, O2.otp, 5)).code, 'EXPIRED');
  await db.query(`update ride_otps set created_at = now() - interval '2 minutes' where booking_id = $1`, [B2.id]);
  const n = await issue(B2.id, 'resend');
  assert.equal(n.ok, true);
  assert.equal((await issue(B2.id, 'resend')).code, 'TOO_SOON');
  assert.equal((await verify(drivers[1], B2.id, O2.otp, 5)).code, 'INCORRECT_OTP');
  O2 = n;
});
await test('resend limit is enforced', async () => {
  let r;
  for (let i = 0; i < 4; i++) {
    await db.query(`update ride_otps set created_at = created_at - interval '2 minutes' where booking_id = $1`, [B2.id]);
    r = await issue(B2.id, 'resend'); if (r.ok) O2 = r;
  }
  assert.equal(r.code, 'RESEND_LIMIT');
});
await test('manager override: service-role only, needs permission, reason and identity confirmation; fully audited', async () => {
  const args = { p_booking_id: B2.id, p_staff_id: staff.operations_manager.staffId, p_reason: 'Customer phone is dead, cannot receive SMS', p_identity_confirmation: 'Matched name and last 4 digits of phone on a call' };
  await rejects(() => asUser(db, staff.operations_manager, () => rpc(db, 'otp_override', args)), /permission denied/);
  await rejects(() => asService(db, () => rpc(db, 'otp_override', { ...args, p_staff_id: staff.administrator.staffId })), /otp\.override/);
  await rejects(() => asService(db, () => rpc(db, 'otp_override', { ...args, p_reason: 'short' })), /REASON_REQUIRED/);
  await rejects(() => asService(db, () => rpc(db, 'otp_override', { ...args, p_identity_confirmation: '' })), /IDENTITY_CONFIRMATION/);
  const r = await asService(db, () => rpc(db, 'otp_override', args));
  assert.equal(r.ok, true);
  assert.equal((await one(db, 'select status s from bookings where id = $1', [B2.id])).s, 'OTP_VERIFIED');
  assert.ok(await one(db, `select 1 from audit_logs where action = 'otp.manager_override' and entity_id = $1 and actor_staff_id = $2`, [B2.id, staff.operations_manager.staffId]));
  assert.ok(await one(db, `select 1 from otp_audit_logs where event = 'manager_override' and booking_id = $1`, [B2.id]));
});
await test('cancelling a booking invalidates its OTP', async () => {
  const b3 = await svcBooking(customers[1], 6);
  // customers[1] already has an active booking B2 — different customers may hold several; use driver 3
  const o3 = await toOtpPending(b3, drivers[2]);
  await asUser(db, customers[1], () => rpc(db, 'cancel_booking', { p_booking_id: b3.id, p_reason: 'Changed my mind' }));
  const b = await one(db, 'select status, cancelled_by, cancellation_fee_paise fee from bookings where id = $1', [b3.id]);
  assert.equal(b.status, 'CANCELLED'); assert.equal(b.cancelled_by, 'customer'); assert.equal(Number(b.fee), 3000, 'late cancellation fee applied');
  assert.equal((await one(db, 'select status s from ride_otps where id = $1', [o3.otp_id])).s, 'invalidated');
  assert.equal((await verify(drivers[2], b3.id, o3.otp, 6)).code, 'BOOKING_CANCELLED');
  assert.equal((await one(db, 'select availability a from drivers where id = $1', [drivers[2].driverId])).a, 'online');
});
await test('distance correction workflow preserves the original value', async () => {
  const b4 = await svcBooking(customers[1], 6);
  const o4 = await toOtpPending(b4, drivers[2]);
  await verify(drivers[2], b4.id, o4.otp, 9);
  const d = await one(db, `select id from ride_discrepancies where booking_id = $1 and status = 'open'`, [b4.id]);
  await rejects(() => asUser(db, staff.customer_support_agent, () => rpc(db, 'resolve_distance_discrepancy', { p_discrepancy_id: d.id, p_action: 'correct', p_corrected_km: 9, p_reason: 'route changed by customer' })), /PERMISSION_DENIED/);
  await asUser(db, staff.operations_manager, () => rpc(db, 'resolve_distance_discrepancy', { p_discrepancy_id: d.id, p_action: 'correct', p_corrected_km: 9, p_reason: 'Customer added a stop before pickup' }));
  const dr = await one(db, 'select * from ride_distance_records where booking_id = $1', [b4.id]);
  assert.equal(Number(dr.original_booked_distance_km), 6); assert.equal(Number(dr.booked_distance_km), 9); assert.ok(dr.correction_reason);
  assert.equal((await verify(drivers[2], b4.id, o4.otp, 9)).ok, true, 'driver can now confirm the corrected distance');
  assert.ok((await all(db, 'select event from distance_audit_logs where booking_id = $1', [b4.id])).some((e) => e.event === 'discrepancy_corrected'));
  globalThis.B4 = b4;
});
await test('OTP audit logs are append-only', async () => {
  await rejects(() => db.query('delete from otp_audit_logs'), /append-only/);
  await rejects(() => db.query(`update audit_logs set action = 'x'`), /append-only/);
});
await test('OTP dashboard and overview never expose secrets', async () => {
  const dash = await asUser(db, staff.operations_manager, () => rpc(db, 'otp_dashboard'));
  assert.ok(dash.generated >= 5 && dash.overridden === 1 && dash.locked >= 0);
  const rows = await asUser(db, staff.operations_manager, () => all(db, 'select * from ride_otp_overview'));
  assert.ok(rows.length >= 5 && !('otp_hash' in rows[0]) && !('salt' in rows[0]));
  assert.equal((await asUser(db, staff.finance_manager, () => all(db, 'select * from ride_otp_overview'))).length, 0);
});

// ---------- GPS ----------
section('GPS tracking');
await test('GPS: duplicates, out-of-order and too-frequent fixes are handled', async () => {
  const d = drivers[0];
  assert.equal((await fix(d, 26.8520, 80.9520, 100)).reason, 'OUT_OF_ORDER_STORED_IN_HISTORY');
  const t = new Date(Date.now() - 2000).toISOString();
  const call = (ts, lat) => asUser(db, d, () => rpc(db, 'ingest_driver_location', { p_lat: lat, p_lng: 80.9530, p_recorded_at: ts, p_accuracy_m: 5 }));
  assert.equal((await call(t, 26.8530)).accepted, true);
  assert.equal((await call(t, 26.8530)).reason, 'DUPLICATE');
  assert.equal((await call(new Date(Date.parse(t) + 500).toISOString(), 26.8531)).reason, 'TOO_FREQUENT');
  assert.equal((await asUser(db, d, () => rpc(db, 'ingest_driver_location', { p_lat: 26.85, p_lng: 80.95, p_recorded_at: new Date(Date.now() + 3600e3).toISOString() }))).reason, 'FUTURE_TIMESTAMP');
});
await test('GPS: travelled distance accumulates only during the ride, ignoring implausible jumps', async () => {
  const d = drivers[0]; const base = Date.now() + 1000; let lat = 26.8530;
  const at = (i) => new Date(base + i * 10000).toISOString();
  const send = (i, la, extra = {}) => asUser(db, d, () => rpc(db, 'ingest_driver_location', { p_lat: la, p_lng: 80.9530, p_recorded_at: at(i), p_accuracy_m: 5, p_speed_kmh: 36, ...extra }));
  // The harness clock is "now"; device timestamps slightly ahead (<60 s) are accepted.
  for (let i = 0; i < 5; i++) { lat += 0.0009; assert.equal((await send(i, lat)).accepted, true); }   // ~100 m each
  const before = Number((await one(db, 'select actual_distance_km k from ride_distance_records where booking_id = $1', [B.id])).k);
  assert.ok(before > 0.35 && before < 0.65, `expected ~0.5 km, got ${before}`);
  await send(5, lat + 0.5, { p_accuracy_m: 5 });      // 55 km in 10 s = impossible
  const after = Number((await one(db, 'select actual_distance_km k from ride_distance_records where booking_id = $1', [B.id])).k);
  assert.equal(after, before, 'teleport jump must not add distance');
  await asUser(db, d, () => rpc(db, 'ingest_driver_location', { p_lat: lat, p_lng: 80.9530, p_recorded_at: new Date(base + 59000).toISOString(), p_accuracy_m: 5 }));
});
await test('GPS: off-duty drivers and drivers without consent are not tracked', async () => {
  const d = await mkDriver('No Consent', '9000000070');
  await db.query(`update drivers set status = 'approved', availability = 'online', location_consent_at = null where id = $1`, [d.driverId]);
  assert.equal((await fix(d, 26.85, 80.95, 1)).reason, 'NO_CONSENT');
  await db.query(`update drivers set location_consent_at = now(), availability = 'offline' where id = $1`, [d.driverId]);
  assert.equal((await fix(d, 26.85, 80.95, 1)).reason, 'OFF_DUTY');
  assert.equal((await all(db, 'select 1 from driver_locations where driver_id = $1', [d.driverId])).length, 0);
});
await test('GPS: restricted-zone entry raises a tracking alert', async () => {
  await asUser(db, drivers[1], () => rpc(db, 'ingest_driver_location', { p_lat: 26.91, p_lng: 80.91, p_recorded_at: new Date(Date.now() + 2000).toISOString(), p_accuracy_m: 5 }));
  assert.ok(await one(db, `select 1 from tracking_alerts where driver_id = $1 and alert_type = 'restricted_zone_entry'`, [drivers[1].driverId]));
});
await test('tracking snapshot reports freshness from the server clock; stale is never "live"', async () => {
  await db.query(`update driver_locations set received_at = now() - interval '10 minutes' where driver_id = $1`, [drivers[1].driverId]);
  const s = await asUser(db, staff.operations_manager, () => rpc(db, 'tracking_snapshot'));
  const d1 = s.drivers.find((x) => x.driver_id === drivers[1].driverId), d0 = s.drivers.find((x) => x.driver_id === drivers[0].driverId);
  assert.equal(d1.freshness, 'stale'); assert.ok(d1.age_seconds >= 600); assert.equal(d0.freshness, 'live'); assert.equal(d0.booking_code, B.booking_code);
  assert.equal(await asService(db, () => rpc(db, 'scan_tracking_health')) >= 1, true);
  assert.ok(await one(db, `select 1 from tracking_alerts where alert_type = 'stale_location' and driver_id = $1`, [drivers[1].driverId]));
  await rejects(() => asUser(db, staff.finance_manager, () => rpc(db, 'tracking_snapshot')), /PERMISSION_DENIED/);
  const trail = await asUser(db, staff.operations_manager, () => rpc(db, 'driver_location_trail', { p_booking_id: B.id, p_to: new Date(Date.now() + 120000).toISOString() }));
  assert.ok(trail.length >= 5);
});

// ---------- completion & payments ----------
section('Completion, payments, refunds and payouts');
let P;
await test('completion bills the actual distance and keeps booked / actual / billable separate', async () => {
  const r = await asUser(db, drivers[0], () => rpc(db, 'complete_ride', { p_booking_id: B.id }));
  assert.equal(r.status, 'PAYMENT_PENDING');
  assert.equal(Number(r.booked_distance_km), 8.4); assert.ok(Number(r.actual_distance_km) > 0.3 && Number(r.actual_distance_km) < 0.7);
  assert.equal(Number(r.final_billable_distance_km), Number(r.actual_distance_km));
  assert.equal(Number(r.total_fare_paise), 8400, 'minimum fare 8000 + 5% GST');
  assert.ok(await one(db, `select 1 from ride_discrepancies where booking_id = $1 and discrepancy_type = 'actual_vs_booked_distance'`, [B.id]), 'large gap raises a discrepancy');
  P = await one(db, 'select * from payments where booking_id = $1', [B.id]);
  assert.equal(P.status, 'pending'); assert.equal(Number(P.amount_paise), 8400); assert.match(P.txn_code, /^TXN-/);
  await rejects(() => asUser(db, drivers[0], () => rpc(db, 'complete_ride', { p_booking_id: B.id })), /INVALID_STATE/);
});
await test('cash payment is recorded once; the driver wallet is settled exactly once', async () => {
  const r1 = await asUser(db, drivers[0], () => rpc(db, 'record_cash_payment', { p_booking_id: B.id }));
  assert.equal(r1.duplicate, false);
  const r2 = await asUser(db, drivers[0], () => rpc(db, 'record_cash_payment', { p_booking_id: B.id }));
  assert.equal(r2.duplicate, true);
  const b = await one(db, 'select status, payment_status, driver_earning_paise e from bookings where id = $1', [B.id]);
  assert.equal(b.status, 'PAYMENT_COMPLETED'); assert.equal(b.payment_status, 'paid');
  const w = await one(db, 'select balance_paise b from driver_wallets where driver_id = $1', [drivers[0].driverId]);
  assert.equal(Number(w.b), Number(b.e) - 8400, 'driver holds the cash and owes commission + tax');
  assert.equal((await one(db, 'select count(*)::int n from wallet_transactions where booking_id = $1', [B.id])).n, 1);
});
let B5, P5;
await test('online payment: webhook must be signed, match the amount, and is replay-safe', async () => {
  // B2 (override) -> start -> complete, paid by UPI
  await asUser(db, drivers[1], () => rpc(db, 'driver_update_ride', { p_booking_id: B2.id, p_action: 'start' }));
  await db.query(`select set_config('app.booking_write','1',false)`); await db.query(`update bookings set payment_method = 'upi' where id = $1`, [B2.id]); await db.query(`select set_config('app.booking_write','',false)`);
  B5 = await asUser(db, drivers[1], () => rpc(db, 'complete_ride', { p_booking_id: B2.id }));
  assert.equal(Number(B5.final_billable_distance_km), 5, 'no GPS trail -> booked distance billed');
  const o = await asService(db, () => rpc(db, 'payment_attach_order', { p_booking_id: B2.id, p_provider: 'razorpay', p_order_id: 'order_T1' }));
  const hook = (id, extra) => asService(db, () => rpc(db, 'apply_payment_webhook', { p_provider: 'razorpay', p_event_id: id, p_event_type: 'payment.captured', p_signature_valid: true,
    p_payload: { test: true }, p_kind: 'payment_captured', p_order_id: 'order_T1', p_payment_id: 'pay_T1', p_amount_paise: o.amount_paise, p_method: 'upi', ...extra }));
  assert.equal((await hook('evt_bad_sig', { p_signature_valid: false })).code, 'INVALID_SIGNATURE');
  assert.equal((await one(db, 'select status s from payments where id = $1', [o.payment_id])).s, 'pending', 'unsigned webhook must not mark paid');
  assert.equal((await hook('evt_wrong_amt', { p_amount_paise: 100 })).ok, false);
  assert.equal((await one(db, 'select status s from payments where id = $1', [o.payment_id])).s, 'pending', 'amount mismatch must not mark paid');
  assert.equal((await hook('evt_ok')).status, 'processed');
  assert.equal((await hook('evt_ok')).duplicate, true, 'replayed event ignored');
  assert.equal((await hook('evt_ok_again')).status, 'ignored', 'second capture ignored');
  P5 = await one(db, 'select * from payments where id = $1', [o.payment_id]);
  assert.equal(P5.status, 'captured'); assert.equal(P5.method, 'upi');
  const w = await one(db, 'select balance_paise b from driver_wallets where driver_id = $1', [drivers[1].driverId]);
  assert.equal(Number(w.b), Number(B5.driver_earning_paise), 'online ride earning credited once');
  await rejects(() => asUser(db, owner, () => rpc(db, 'apply_payment_webhook', { p_provider: 'x', p_event_id: 'y', p_event_type: 'z', p_signature_valid: true, p_payload: {}, p_kind: 'payment_captured' })), /permission denied/);
});
await test('payments cannot be edited directly by anyone using the console', async () => {
  await rejects(() => asUser(db, staff.finance_manager, () => db.query(`update payments set status = 'captured'`)), /permission denied|row-level/).catch(async () => {
    const r = await asUser(db, staff.finance_manager, () => db.query(`update payments set amount_paise = 1 returning id`)); assert.equal(r.rows.length, 0);
  });
});
await test('refunds: permission, limits and idempotency', async () => {
  const key = 'refund-key-0001';
  await rejects(() => asUser(db, staff.customer_support_agent, () => rpc(db, 'request_refund', { p_payment_id: P5.id, p_amount_paise: 1000, p_reason: 'customer complaint', p_idempotency_key: key })), /PERMISSION_DENIED/);
  await rejects(() => asUser(db, staff.finance_manager, () => rpc(db, 'request_refund', { p_payment_id: P5.id, p_amount_paise: Number(P5.amount_paise) + 1, p_reason: 'too much refund', p_idempotency_key: 'refund-key-big' })), /REFUND_EXCEEDS_PAYMENT/);
  const r1 = await asUser(db, staff.finance_manager, () => rpc(db, 'request_refund', { p_payment_id: P5.id, p_amount_paise: 1000, p_reason: 'Driver took a longer route', p_idempotency_key: key }));
  assert.equal(r1.status, 'pending'); assert.equal(r1.needs_gateway, true);
  const r2 = await asUser(db, staff.finance_manager, () => rpc(db, 'request_refund', { p_payment_id: P5.id, p_amount_paise: 1000, p_reason: 'Driver took a longer route', p_idempotency_key: key }));
  assert.equal(r2.duplicate, true); assert.equal(r2.refund_id, r1.refund_id);
  assert.equal(Number((await one(db, 'select refunded_paise r from payments where id = $1', [P5.id])).r), 0, 'not refunded until the gateway confirms');
  await asService(db, () => rpc(db, 'refund_gateway_result', { p_refund_id: r1.refund_id, p_state: 'completed', p_provider_refund_id: 'rfnd_1' }));
  await asService(db, () => rpc(db, 'refund_gateway_result', { p_refund_id: r1.refund_id, p_state: 'completed', p_provider_refund_id: 'rfnd_1' }));
  const p = await one(db, 'select refunded_paise r, status s from payments where id = $1', [P5.id]);
  assert.equal(Number(p.r), 1000, 'applied exactly once'); assert.equal(p.s, 'partially_refunded');
});
await test('payouts: balance check, maker-checker and no double payment', async () => {
  const d = drivers[1].driverId, bal = Number(B5.driver_earning_paise);
  await rejects(() => asUser(db, staff.finance_manager, () => rpc(db, 'create_payout', { p_driver_id: d, p_amount_paise: bal + 1, p_method: 'upi', p_idempotency_key: 'payout-too-big' })), /INSUFFICIENT_BALANCE/);
  const p1 = await asUser(db, staff.finance_manager, () => rpc(db, 'create_payout', { p_driver_id: d, p_amount_paise: bal, p_method: 'upi', p_idempotency_key: 'payout-key-01' }));
  const dup = await asUser(db, staff.finance_manager, () => rpc(db, 'create_payout', { p_driver_id: d, p_amount_paise: bal, p_method: 'upi', p_idempotency_key: 'payout-key-01' }));
  assert.equal(dup.duplicate, true);
  await rejects(() => asUser(db, staff.finance_manager, () => rpc(db, 'create_payout', { p_driver_id: d, p_amount_paise: 100, p_method: 'upi', p_idempotency_key: 'payout-key-02' })), /INSUFFICIENT_BALANCE/);
  await rejects(() => asUser(db, staff.finance_manager, () => rpc(db, 'update_payout', { p_payout_id: p1.payout_id, p_action: 'approve' })), /SELF_APPROVAL_FORBIDDEN/);
  await asUser(db, staff.administrator, () => rpc(db, 'update_payout', { p_payout_id: p1.payout_id, p_action: 'approve' }));
  await asUser(db, staff.administrator, () => rpc(db, 'update_payout', { p_payout_id: p1.payout_id, p_action: 'paid', p_reference: 'UTR123456' }));
  const again = await asUser(db, staff.administrator, () => rpc(db, 'update_payout', { p_payout_id: p1.payout_id, p_action: 'paid', p_reference: 'UTR123456' }));
  assert.equal(again.duplicate, true);
  assert.equal(Number((await one(db, 'select balance_paise b from driver_wallets where driver_id = $1', [d])).b), 0);
});
await test('disputes move the booking to DISPUTED and back', async () => {
  const id = await asUser(db, customers[0], () => rpc(db, 'open_dispute', { p_booking_id: B.id, p_category: 'fare', p_description: 'I was charged more than shown' }));
  assert.equal((await one(db, 'select status s from bookings where id = $1', [B.id])).s, 'DISPUTED');
  await rejects(() => asUser(db, staff.customer_support_agent, () => rpc(db, 'resolve_dispute', { p_dispute_id: id, p_outcome: 'resolved', p_resolution: 'short' })), /RESOLUTION_REQUIRED/);
  await asUser(db, staff.customer_support_agent, () => rpc(db, 'resolve_dispute', { p_dispute_id: id, p_outcome: 'resolved', p_resolution: 'Explained minimum fare to the customer' }));
  assert.equal((await one(db, 'select status s from bookings where id = $1', [B.id])).s, 'PAYMENT_COMPLETED');
});
await test('SOS creates a critical incident and emergency notifications', async () => {
  const b4 = globalThis.B4;
  await asUser(db, drivers[2], () => rpc(db, 'driver_update_ride', { p_booking_id: b4.id, p_action: 'start' }));
  const id = await asUser(db, customers[1], () => rpc(db, 'raise_sos', { p_booking_id: b4.id, p_lat: 26.85, p_lng: 80.95, p_description: 'Driver is taking an unknown route' }));
  const inc = await one(db, 'select severity, status from safety_incidents where id = $1', [id]);
  assert.equal(inc.severity, 'critical');
  assert.ok((await one(db, `select count(*)::int n from notifications where priority = 'emergency'`)).n > 0);
  assert.equal((await one(db, 'select is_emergency e from bookings where id = $1', [b4.id])).e, true);
  await rejects(() => asUser(db, customers[0], () => rpc(db, 'raise_sos', { p_booking_id: b4.id })), /PERMISSION_DENIED/);
});

// ---------- reporting ----------
section('Dashboard, analytics, audit and system functions');
const range = { p_from: new Date(Date.now() - 86400e3).toISOString(), p_to: new Date(Date.now() + 3600e3).toISOString() };
await test('dashboard statistics are computed from real records', async () => {
  const s = await asUser(db, staff.operations_manager, () => rpc(db, 'dashboard_stats', range));
  assert.equal(s.total_customers, 2); assert.equal(s.completed_rides, 2); assert.equal(s.ongoing_rides, 1);
  assert.equal(Number(s.revenue_paise), 8400 + Number(P5.amount_paise));
  assert.ok(s.cancelled_rides >= 3 && s.open_emergencies === 1);
  await rejects(() => asUser(db, customers[0], () => rpc(db, 'dashboard_stats', range)), /PERMISSION_DENIED/);
});
await test('every analytics / AI function executes', async () => {
  const u = staff.administrator, call = (n, a = {}) => asUser(db, u, () => rpc(db, n, a));
  const ts = await call('analytics_timeseries', { ...range, p_bucket: 'hour' }); assert.ok(ts.length >= 24 && ts.reduce((a, x) => a + x.completed, 0) === 2);
  const bd = await call('analytics_breakdowns', range); assert.equal(bd.categories[0].name, 'Sedan'); assert.ok(bd.cancellation_reasons.length > 0);
  assert.equal((await call('city_stats')).length, 2);
  assert.ok((await call('demand_heatmap', { p_city_id: city, ...range })).length >= 1);
  assert.ok((await call('driver_performance', range)).drivers.length >= 3);
  assert.equal((await call('forecast_demand')).available, false, 'honest about insufficient history');
  assert.equal((await call('forecast_revenue')).available, false);
  assert.ok(Array.isArray((await call('fraud_signals')).signals));
  assert.ok((await call('maintenance_predictions')).vehicles.length === 3);
  assert.ok((await call('operational_alerts')).some((a) => a.code === 'OPEN_SOS'));
  assert.ok((await call('campaign_analytics')).length >= 1);
  assert.ok((await call('recent_activity')).length > 5);
  const fin = await call('finance_summary', range); assert.equal(Number(fin.refunds_paise), 1000); assert.equal(Number(fin.cash_paise), 8400);
  assert.ok((await call('gst_report', { p_month: new Date().toISOString().slice(0, 10) })).rows.length >= 1);
  assert.ok((await call('system_health')).bookings_total >= 5);
  assert.ok((await call('global_search', { p_query: 'asha' })).some((r) => r.type === 'driver'));
  assert.ok((await call('ai_context')).today);
  assert.ok((await call('generate_daily_report', { p_date: new Date().toISOString().slice(0, 10) })).completed >= 0);
});
await test('scheduled jobs run for the service role only', async () => {
  const r = await asService(db, () => rpc(db, 'run_scheduled_jobs')); assert.ok('otp_expired' in r);
  assert.ok(await asService(db, () => rpc(db, 'document_expiry_scan')) >= 0);
  assert.ok(typeof (await asService(db, () => rpc(db, 'apply_retention'))) === 'object');
  await rejects(() => asUser(db, owner, () => rpc(db, 'run_scheduled_jobs')), /permission denied/);
});
await test('settings changes are validated, permissioned and kept in history', async () => {
  await rejects(() => asUser(db, staff.operations_manager, () => rpc(db, 'update_setting', { p_key: 'otp.max_attempts', p_value: 3 })), /PERMISSION_DENIED/);
  await rejects(() => asUser(db, owner, () => rpc(db, 'update_setting', { p_key: 'otp.max_attempts', p_value: 'three' })), /INVALID_VALUE_TYPE|invalid input/);
  await asUser(db, owner, () => db.query(`select public.update_setting('otp.max_attempts', '4'::jsonb, 'tighten')`));
  assert.equal((await one(db, `select new_value v from settings_history where key = 'otp.max_attempts'`)).v, 4);
});
await test('notifications: permissions and read tracking', async () => {
  await rejects(() => asUser(db, staff.city_manager, () => rpc(db, 'send_notification', { p_audience: 'all_drivers', p_title: 'Alert', p_body: 'Flooding on ring road', p_priority: 'emergency' })), /notifications\.emergency/);
  const id = await asUser(db, staff.city_manager, () => rpc(db, 'send_notification', { p_audience: 'all_drivers', p_title: 'Notice', p_body: 'Fuel prices revised today' }));
  await asService(db, () => rpc(db, 'notification_dispatch_result', { p_notification_id: id, p_logs: [{ channel: 'push', provider: 'fcm', status: 'not_configured', error: 'FCM credentials missing' }] }));
  assert.equal((await one(db, 'select dispatch_status s from notifications where id = $1', [id])).s, 'failed', 'never reported as delivered when the provider did not send');
  const mine = await asUser(db, staff.operations_manager, () => all(db, 'select id from notifications where recipient_staff_id = public.current_staff_id() and read_at is null'));
  assert.ok(mine.length > 0);
  assert.equal(await asUser(db, staff.operations_manager, () => rpc(db, 'mark_notifications_read')), mine.length);
});
await test('API keys are shown once and stored hashed', async () => {
  const k = await asUser(db, owner, () => rpc(db, 'create_api_key', { p_name: 'partner', p_scopes: ['bookings.read'] }));
  assert.match(k.api_key, /^rms_[0-9a-f]{48}$/);
  const row = await one(db, 'select key_hash, key_prefix from api_keys where id = $1', [k.id]);
  assert.notEqual(row.key_hash, k.api_key); assert.equal(row.key_hash.length, 64);
});
await test('bulk import reports per-row errors', async () => {
  const r = await asUser(db, owner, () => rpc(db, 'import_rows', { p_entity: 'customers', p_rows: [{ full_name: 'Imp One', phone: '9700000001', city: 'Testpur' }, { full_name: 'Bad', phone: '123' }] }));
  assert.equal(r.imported, 1); assert.equal(r.failed, 1); assert.equal(r.errors[0].row, 2);
});
await test('account deletion anonymises personal data but keeps ride records', async () => {
  const u = await mkUser('del@customer.test');
  const c = (await one(db, `insert into customers(full_name, phone, user_id) values ('To Delete','9755555555',$1) returning id`, [u.id])).id;
  await asUser(db, u, () => rpc(db, 'request_account_deletion'));
  await asUser(db, owner, () => rpc(db, 'process_deletion_request', { p_customer_id: c, p_approve: true, p_reason: 'customer request' }));
  const row = await one(db, 'select full_name, phone, status, user_id from customers where id = $1', [c]);
  assert.equal(row.full_name, 'Deleted customer'); assert.equal(row.status, 'deleted'); assert.equal(row.user_id, null); assert.ok(!row.phone.includes('9755555555'));
});
await test('sensitive actions are present in the audit trail with the acting staff member', async () => {
  const acts = (await all(db, 'select distinct action from audit_logs')).map((r) => r.action);
  for (const a of ['booking.create', 'booking.assign_driver', 'booking.cancel', 'otp.manager_override', 'payment.cash_recorded', 'refund.request',
    'payout.paid', 'drivers.update', 'staff.create', 'system_settings.update', 'distance.correct', 'vehicle.assign', 'pricing_rules.insert', 'safety.sos'])
    assert.ok(acts.includes(a), `missing audit action ${a}`);
  assert.equal((await asUser(db, staff.city_manager, () => all(db, 'select id from audit_logs'))).length, 0, 'audit log needs audit.view');
});
await test('service-only functions are not executable by signed-in users', async () => {
  for (const f of ['wallet_post', 'settle_booking_payment', 'finish_refund', 'notify_staff', 'write_audit', 'set_actor', 'get_setting', 'check_rate_limit']) {
    const r = await one(db, `select has_function_privilege('authenticated', p.oid, 'execute') ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [f]);
    assert.equal(r.ok, false, `${f} must not be callable by authenticated`);
  }
  const anon = await all(db, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
  assert.deepEqual(anon.map((r) => r.proname), ['login_precheck', 'record_login_failure']);
});
await test('every public table has RLS enabled', async () => {
  const off = await all(db, `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(off, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
