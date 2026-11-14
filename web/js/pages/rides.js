// Module 5 — Ride and booking management.
import { sb, rpc, fn, toAppError, AppError } from '../supabase-client.js';
import { list, listAll, select, cities, categories, nameMap, asOptions, subscribe, getOne } from '../api.js';
import { dataTable, tabs, badge, openModal, formModal, promptReason, confirmDialog, toast, showError, dl, timeline, simpleTable, loadingState, errorState, emptyState, notice, withBusy, formHtml, readFields, showFieldErrors } from '../components.js';
import { esc, money, km, dateTime, ago, titleCase, idempotencyKey, debounce, decodePolyline, duration, rupeesToPaise } from '../utilities.js';
import { can, applyPermissions, setting } from '../permissions.js';
import { attach, personCell, ONGOING, ACTIVE_RIDE, ALL_STATUSES, pickCustomer } from './shared.js';
import { createMap, fitTo, pinIcon, attachAutocomplete, mapsConfigured } from '../maps.js';
import { validate, rules } from '../validation.js';

const COLS = 'id,booking_code,status,customer_id,driver_id,vehicle_id,category_id,city_id,pickup_address,drop_address,booked_distance_km,actual_distance_km,final_billable_distance_km,estimated_fare_paise,total_fare_paise,payment_method,payment_status,is_emergency,created_at,scheduled_for,cancellation_reason,cancelled_by,created_via';
const FINAL = ['PAYMENT_COMPLETED', 'CANCELLED'];
const fare = (b) => money(b.total_fare_paise ?? b.estimated_fare_paise) + (b.total_fare_paise === null ? ' <span class="cell-sub">est.</span>' : '');

async function searchApply(q, term) {
  // Search by booking id, address, driver or customer.
  const t = term.replace(/[,()%*\\"']/g, ' ').trim(); if (!t) return q;
  const [d, c] = await Promise.all([
    sb.from('drivers').select('id').or(`full_name.ilike.%${t}%,driver_code.ilike.%${t}%,phone.ilike.%${t}%`).limit(25),
    sb.from('customer_directory').select('id').or(`full_name.ilike.%${t}%,customer_code.ilike.%${t}%`).limit(25),
  ]);
  const parts = [`booking_code.ilike.%${t}%`, `pickup_address.ilike.%${t}%`, `drop_address.ilike.%${t}%`];
  if (d.data?.length) parts.push(`driver_id.in.(${d.data.map((x) => x.id).join(',')})`);
  if (c.data?.length) parts.push(`customer_id.in.(${c.data.map((x) => x.id).join(',')})`);
  return q.or(parts.join(','));
}

function ridesTable(pane, { statuses = null, emergency = false, cityOptions, catOptions, catNames }) {
  const build = async (state, page, pageSize) => {
    let extra = null;
    if (state.search) extra = await searchApply(sb.from('bookings').select(COLS, { count: 'exact' }), state.search);
    const apply = (q) => {
      if (statuses) q = q.in('status', statuses);
      if (emergency) q = q.eq('is_emergency', true);
      if (state.filters.from) q = q.gte('created_at', `${state.filters.from}T00:00:00`);
      if (state.filters.to) q = q.lte('created_at', `${state.filters.to}T23:59:59.999`);
      return q;
    };
    let rows, count;
    if (extra) {
      let q = apply(extra);
      for (const k of ['status', 'city_id', 'category_id', 'payment_method']) if (state.filters[k]) q = q.eq(k, state.filters[k]);
      const r = await q.order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
      if (r.error) throw toAppError(r.error); rows = r.data ?? []; count = r.count ?? rows.length;
    } else {
      const r = await list('bookings', { select: COLS, filters: { status: state.filters.status, city_id: state.filters.city_id, category_id: state.filters.category_id, payment_method: state.filters.payment_method }, apply, page, pageSize });
      rows = r.rows; count = r.count;
    }
    await Promise.all([attach(rows, 'customer_id', 'customer_directory', 'id,full_name,customer_code', 'customer'), attach(rows, 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver')]);
    return { rows, count };
  };
  const t = dataTable(pane, {
    search: { placeholder: 'Booking ID, driver, customer or address…' },
    filters: [
      ...(statuses && statuses.length === 1 ? [] : [{ name: 'status', label: 'All statuses', options: (statuses ?? ALL_STATUSES).map((s) => ({ value: s, label: titleCase(s) })) }]),
      { name: 'city_id', label: 'All cities', options: cityOptions }, { name: 'category_id', label: 'All categories', options: catOptions },
      { name: 'payment_method', label: 'Any payment', options: ['cash', 'upi', 'card', 'netbanking', 'wallet'] },
      { name: 'from', label: 'From date', type: 'date' }, { name: 'to', label: 'To date', type: 'date' },
    ],
    columns: [
      { label: 'Booking', render: (b) => `<div class="cell-main mono">${esc(b.booking_code)}${b.is_emergency ? ' <span class="badge solid-danger">SOS</span>' : ''}</div><div class="cell-sub">${esc(dateTime(b.created_at))}</div>` },
      { label: 'Customer', render: (b) => personCell(b.customer, 'customer_code') },
      { label: 'Driver', render: (b) => (b.driver ? personCell(b.driver, 'driver_code') : '<span class="muted">Not assigned</span>') },
      { label: 'Route', render: (b) => `<div style="max-width:300px"><div class="cell-sub"><i class="fa-solid fa-circle" style="color:var(--success);font-size:7px"></i> ${esc(b.pickup_address)}</div><div class="cell-sub"><i class="fa-solid fa-circle" style="color:var(--danger);font-size:7px"></i> ${esc(b.drop_address)}</div></div>` },
      { label: 'Distance', cls: 'num', render: (b) => km(b.final_billable_distance_km ?? b.booked_distance_km) },
      { label: 'Fare', cls: 'num', render: fare },
      { label: 'Status', render: (b) => badge(b.status) + (b.status === 'CANCELLED' && b.cancelled_by ? `<div class="cell-sub">by ${esc(b.cancelled_by)}</div>` : '') },
      { label: 'Payment', render: (b) => `${badge(b.payment_status)}<div class="cell-sub">${esc(titleCase(b.payment_method))}</div>` },
    ],
    rowClass: (b) => (b.is_emergency && !FINAL.includes(b.status) ? 'row-danger' : ''),
    load: (state) => build(state, state.page, state.pageSize),
    onRowClick: (b) => openBooking(b.id, () => t.reload({ silent: true })),
    export: { perm: 'rides.export', filename: 'rides', loadAll: async (state) => { const out = []; for (let p = 1; p <= 10; p++) { const r = await build(state, p, 1000); out.push(...r.rows); if (r.rows.length < 1000) break; } return out; },
      columns: [{ label: 'Booking ID', key: 'booking_code' }, { label: 'Created', value: (b) => b.created_at }, { label: 'Status', key: 'status' }, { label: 'Customer', value: (b) => b.customer?.full_name ?? '' }, { label: 'Driver', value: (b) => b.driver?.full_name ?? '' },
        { label: 'Category', value: (b) => catNames[b.category_id] ?? '' }, { label: 'Pickup', key: 'pickup_address' }, { label: 'Drop', key: 'drop_address' }, { label: 'Booked km', key: 'booked_distance_km' }, { label: 'Actual km', key: 'actual_distance_km' },
        { label: 'Billable km', key: 'final_billable_distance_km' }, { label: 'Fare (INR)', value: (b) => ((b.total_fare_paise ?? b.estimated_fare_paise ?? 0) / 100).toFixed(2) }, { label: 'Payment method', key: 'payment_method' }, { label: 'Payment status', key: 'payment_status' },
        { label: 'Cancelled by', key: 'cancelled_by' }, { label: 'Cancellation reason', key: 'cancellation_reason' }] },
    empty: { icon: 'fa-route', title: 'No bookings here', text: 'Bookings appear as soon as they are created by the Customer App or from “New booking”.' },
  });
  const soft = debounce(() => t.reload({ silent: true }), 1500);
  return subscribe('rides', ['bookings'], soft);
}

function disputesTable(pane) {
  const t = dataTable(pane, {
    search: false, filters: [{ name: 'status', label: 'All statuses', options: ['open', 'investigating', 'resolved', 'rejected'], value: 'open' }, { name: 'category', label: 'All categories', options: ['fare', 'distance', 'behaviour', 'payment', 'safety', 'other'] }],
    columns: [
      { label: 'Booking', render: (d) => `<span class="mono cell-main">${esc(d.booking?.booking_code ?? '—')}</span><div class="cell-sub">${esc(dateTime(d.created_at))}</div>` },
      { label: 'Category', render: (d) => badge(d.category, 'info') }, { label: 'Raised by', render: (d) => esc(titleCase(d.raised_by_type)) },
      { label: 'Description', render: (d) => `<div style="max-width:420px">${esc(d.description)}</div>` }, { label: 'Status', render: (d) => badge(d.status) },
      { label: 'Resolution', render: (d) => (d.resolution ? `<div style="max-width:300px">${esc(d.resolution)}</div><div class="cell-sub">${esc(dateTime(d.resolved_at))}</div>` : '<span class="muted">—</span>') },
    ],
    load: async (state) => { const r = await list('ride_disputes', { filters: state.filters, page: state.page, pageSize: state.pageSize }); await attach(r.rows, 'booking_id', 'bookings', 'id,booking_code,status', 'booking'); return r; },
    rowActions: (d) => [
      { icon: 'fa-eye', title: 'Open ride', onClick: () => openBooking(d.booking_id, () => t.reload()) },
      ['open', 'investigating'].includes(d.status) && { icon: 'fa-gavel', title: 'Resolve dispute', perm: 'rides.disputes', onClick: () => resolveDispute(d, () => t.reload()) },
    ],
    empty: { icon: 'fa-scale-balanced', title: 'No disputes', text: 'Disputes raised by customers, drivers or staff are listed here.' },
  });
}
async function resolveDispute(d, done) {
  const ok = await formModal({ title: 'Resolve dispute', subtitle: d.booking?.booking_code ?? '', submitText: 'Save decision',
    fields: [{ name: 'outcome', label: 'Decision', type: 'select', required: true, options: [{ value: 'resolved', label: 'Resolved (complaint upheld / settled)' }, { value: 'rejected', label: 'Rejected (no action)' }] },
      { name: 'resolution', label: 'Resolution details', type: 'textarea', required: true, rules: [rules.minLen(10)], help: 'Shown in the audit trail. If money must be returned, issue the refund from the ride’s Payment tab.' }],
    onSubmit: (v) => rpc('resolve_dispute', { p_dispute_id: d.id, p_outcome: v.outcome, p_resolution: v.resolution }) });
  if (ok) { toast('success', 'Dispute closed.'); done?.(); }
}

// ---------- booking detail ----------
export async function openBooking(id, onChange = null) {
  let changed = false;
  const m = openModal({ title: 'Booking', drawer: true, body: loadingState(), footer: '', onClose: () => { if (changed) onChange?.(); } });
  const done = () => { changed = true; render(); };
  async function render() {
    try {
      const b = await getOne('bookings', id);
      if (!b) { m.body.innerHTML = emptyState({ icon: 'fa-lock', title: 'Booking not found', text: 'It does not exist or is outside your city scope.' }); return; }
      const [cats, cityList] = await Promise.all([categories(), cities()]);
      await Promise.all([attach([b], 'customer_id', 'customer_directory', 'id,full_name,customer_code,phone', 'customer'), attach([b], 'driver_id', 'drivers', 'id,full_name,driver_code,phone,rating_avg', 'driver'), attach([b], 'vehicle_id', 'vehicles', 'id,registration_number,manufacturer,model,color', 'vehicle')]);
      m.setTitle(`${b.booking_code}`);
      m.root.querySelector('.modal-head small')?.remove();
      m.root.querySelector('.modal-head h2').insertAdjacentHTML('afterend', `<small>${badge(b.status)} ${b.is_emergency ? '<span class="badge solid-danger">EMERGENCY</span>' : ''} · created ${esc(dateTime(b.created_at))} via ${esc(titleCase(b.created_via))}</small>`);
      m.body.innerHTML = '<div data-tabs></div>';
      tabs(m.body.querySelector('[data-tabs]'), [
        { id: 'summary', label: 'Summary', render: (p) => { p.innerHTML = summaryHtml(b, nameMap(cats), nameMap(cityList)); } },
        { id: 'route', label: 'Route', render: (p) => routeTab(p, b) },
        { id: 'timeline', label: 'Timeline', render: (p) => timelineTab(p, b) },
        { id: 'payment', label: 'Payment', perm: 'finance.view', render: (p) => paymentTab(p, b, done) },
        { id: 'otp', label: 'OTP & distance', perm: 'otp.view', render: (p) => otpTab(p, b) },
        { id: 'disputes', label: 'Disputes', render: (p) => disputeTab(p, b, done) },
        { id: 'audit', label: 'Audit trail', perm: 'audit.view', render: (p) => auditTab(p, b) },
      ]);
      footer(b);
    } catch (e) { m.body.innerHTML = errorState(e); }
  }
  function footer(b) {
    const s = b.status; const A = [];
    if (['DRIVER_SEARCHING', 'BOOKING_CREATED'].includes(s)) A.push(['assign', 'btn-primary', 'fa-user-plus', 'Assign driver', 'rides.assign']);
    if (['DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'OTP_PENDING'].includes(s)) A.push(['assign', '', 'fa-people-arrows', 'Reassign driver', 'rides.assign']);
    if (s === 'RIDE_STARTED') A.push(['complete', '', 'fa-flag-checkered', 'Force complete', 'rides.manage']);
    if (s === 'PAYMENT_PENDING' && b.payment_method === 'cash') A.push(['cash', 'btn-success', 'fa-money-bill', 'Record cash received', 'finance.record_payment']);
    if (['PAYMENT_PENDING', 'PAYMENT_COMPLETED'].includes(s)) A.push(['dispute', '', 'fa-scale-balanced', 'Open dispute', 'rides.disputes']);
    if (ONGOING.includes(s) && !b.is_emergency) A.push(['sos', '', 'fa-triangle-exclamation', 'Raise SOS', 'safety.manage']);
    if (!['CANCELLED', 'RIDE_STARTED', 'RIDE_COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'DISPUTED'].includes(s)) A.push(['cancel', 'btn-danger', 'fa-ban', 'Cancel booking', 'rides.cancel']);
    m.foot.innerHTML = A.filter((a) => can(a[4])).map((a) => `<button class="btn ${a[1]}" data-do="${a[0]}"><i class="fa-solid ${a[2]}"></i> ${a[3]}</button>`).join('') || '<span class="muted small">No actions available for this status or your role.</span>';
    m.foot.querySelectorAll('[data-do]').forEach((btn) => { btn.onclick = () => actions[btn.dataset.do](b).catch(showError); });
  }
  const actions = {
    assign: (b) => assignDriver(b, done),
    cancel: async (b) => { const reason = await promptReason({ title: `Cancel ${b.booking_code}?`, text: 'The customer and driver are released and the ride OTP is invalidated. This cannot be undone.', confirmText: 'Cancel booking', danger: true, placeholder: 'e.g. Customer called to cancel' });
      if (!reason) return; await rpc('cancel_booking', { p_booking_id: b.id, p_reason: reason }); toast('success', 'Booking cancelled.'); done(); },
    complete: async (b) => { const reason = await promptReason({ title: 'Force-complete this ride?', text: 'Use only when the driver cannot end the ride in the app. The fare is calculated by the server from the recorded distance.', min: 10, confirmText: 'Complete ride', danger: true });
      if (!reason) return; await rpc('complete_ride', { p_booking_id: b.id, p_reason: reason }); toast('success', 'Ride completed. Payment is now pending.'); done(); },
    cash: async (b) => { if (!(await confirmDialog({ title: 'Record cash payment?', text: `Confirm that ${money(b.total_fare_paise)} was received in cash for ${b.booking_code}. The driver wallet is settled once.`, confirmText: 'Cash received' }))) return;
      const r = await rpc('record_cash_payment', { p_booking_id: b.id, p_reason: 'Recorded from manager console' }); toast('success', r?.duplicate ? 'This payment was already recorded — nothing changed.' : 'Cash payment recorded.'); done(); },
    dispute: async (b) => { const ok = await formModal({ title: 'Open dispute', subtitle: b.booking_code, fields: [{ name: 'category', label: 'Category', type: 'select', required: true, options: ['fare', 'distance', 'behaviour', 'payment', 'safety', 'other'] }, { name: 'description', label: 'What happened?', type: 'textarea', required: true, rules: [rules.minLen(10)] }],
      onSubmit: (v) => rpc('open_dispute', { p_booking_id: b.id, p_category: v.category, p_description: v.description }) }); if (ok) { toast('success', 'Dispute opened.'); done(); } },
    sos: async (b) => { const ok = await formModal({ title: 'Raise emergency (SOS)', subtitle: b.booking_code, danger: true, submitText: 'Raise emergency', intro: notice('danger', 'This alerts every safety officer immediately.', ' Use it only for a real safety concern.'),
      fields: [{ name: 'type', label: 'Type', type: 'select', required: true, noBlank: true, options: ['sos', 'accident', 'harassment', 'medical', 'vehicle_breakdown', 'theft', 'other'] }, { name: 'description', label: 'Details', type: 'textarea', required: true, rules: [rules.minLen(10)] }],
      onSubmit: (v) => rpc('raise_sos', { p_booking_id: b.id, p_description: v.description, p_incident_type: v.type }) }); if (ok) { toast('warning', 'Emergency raised. Safety team notified.'); done(); } },
  };
  await render();
}

function summaryHtml(b, catNames, cityNames) {
  const final = b.total_fare_paise !== null;
  const row = (k, v, cls = '') => `<div class="kv ${cls}"><span>${esc(k)}</span><span>${v}</span></div>`;
  return `<div class="stack">
    <div class="grid grid-2">
      <div>${dl([['Customer', b.customer ? `<a href="#/customers?id=${esc(b.customer.id)}">${esc(b.customer.full_name)}</a> <span class="cell-sub mono">${esc(b.customer.customer_code)}</span>` : '—'], ['Customer phone', esc(b.customer?.phone ?? '—')],
        ['Driver', b.driver ? `<a href="#/drivers?id=${esc(b.driver.id)}">${esc(b.driver.full_name)}</a> <span class="cell-sub mono">${esc(b.driver.driver_code)}</span>` : '<span class="muted">Not assigned</span>'],
        ['Vehicle', b.vehicle ? `${esc(b.vehicle.registration_number)} · ${esc(b.vehicle.manufacturer ?? '')} ${esc(b.vehicle.model ?? '')}` : '—'], ['Category', esc(catNames[b.category_id] ?? '—')], ['City', esc(cityNames[b.city_id] ?? '—')]])}</div>
      <div>${dl([['Pickup', esc(b.pickup_address)], ['Destination', esc(b.drop_address)], ['Scheduled for', b.scheduled_for ? esc(dateTime(b.scheduled_for)) : 'Immediately'],
        ['Payment', `${esc(titleCase(b.payment_method))} ${badge(b.payment_status)}`], b.status === 'CANCELLED' && ['Cancelled', `by ${esc(b.cancelled_by ?? '—')} — ${esc(b.cancellation_reason ?? '')}`]])}</div>
    </div>
    <div class="grid grid-2">
      <section class="card"><div class="card-head"><h3><i class="fa-solid fa-ruler-horizontal"></i>Distance &amp; duration</h3></div><div class="card-body">
        ${row('Booked distance', `${km(b.booked_distance_km)} <span class="cell-sub">${esc(titleCase(b.distance_source))}</span>`)}${row('Actual distance (GPS)', km(b.actual_distance_km))}${row('Billable distance', km(b.final_billable_distance_km))}
        ${row('Estimated duration', b.estimated_duration_min !== null ? `${esc(b.estimated_duration_min)} min` : '—')}${row('Actual duration', b.actual_duration_min !== null ? `${esc(b.actual_duration_min)} min` : '—')}${row('Waiting', b.waiting_minutes ? `${esc(b.waiting_minutes)} min` : '—')}
        ${b.distance_source === 'haversine_estimate' ? '<p class="field-help" style="margin-top:8px">Booked distance is a straight-line estimate × road factor because Google Routes was not available when this ride was booked.</p>' : ''}</div></section>
      <section class="card"><div class="card-head"><h3><i class="fa-solid fa-receipt"></i>Fare ${final ? '' : '<span class="badge warning">Estimate</span>'}</h3></div><div class="card-body">
        ${final ? `${row('Base fare', money(b.base_fare_paise))}${row('Distance fare', money(b.distance_fare_paise))}${row('Time fare', money(b.time_fare_paise))}${row('Waiting charges', money(b.waiting_fare_paise))}${row('Night / peak / surge', money(b.surcharge_paise))}${row('Discount', `− ${money(b.discount_paise)}`)}${row('GST', money(b.tax_paise))}${row('Total', money(b.total_fare_paise), 'total')}${row('Company commission', money(b.commission_paise))}${row('Driver earning', money(b.driver_earning_paise))}`
        : `${row('Estimated fare', money(b.estimated_fare_paise), 'total')}${row('Discount applied', b.discount_paise ? `− ${money(b.discount_paise)}` : '—')}<p class="field-help" style="margin-top:8px">The final fare is calculated by the server when the ride is completed.</p>`}
        ${b.cancellation_fee_paise ? row('Cancellation fee', money(b.cancellation_fee_paise)) : ''}</div></section>
    </div>
    <section class="card"><div class="card-head"><h3><i class="fa-regular fa-clock"></i>Ride timestamps</h3></div><div class="card-body">${dl([['Created', esc(dateTime(b.created_at))], ['Driver assigned', esc(dateTime(b.assigned_at))], ['Driver accepted', esc(dateTime(b.accepted_at))], ['Arrived at pickup', esc(dateTime(b.arrived_at))],
      ['OTP verified', esc(dateTime(b.otp_verified_at))], ['Ride started', esc(dateTime(b.started_at))], ['Ride completed', esc(dateTime(b.completed_at))], ['Paid', esc(dateTime(b.paid_at))], b.cancelled_at && ['Cancelled', esc(dateTime(b.cancelled_at))]])}</div></section>
    <details class="card"><summary class="card-head" style="cursor:pointer"><h3><i class="fa-solid fa-tags"></i>Pricing rule applied to this booking</h3></summary><div class="card-body"><p class="field-help">Stored with the booking so the fare stays explainable even after prices change.</p><pre class="mono" style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(b.pricing_snapshot ?? {}, null, 2))}</pre></div></details>
  </div>`;
}
async function routeTab(p, b) {
  p.innerHTML = `<div class="map md" data-map></div><p class="field-help" data-note style="margin-top:8px"></p>`;
  const map = await createMap(p.querySelector('[data-map]'), { center: { lat: Number(b.pickup_lat), lng: Number(b.pickup_lng) }, zoom: 13 });
  const note = p.querySelector('[data-note]');
  if (!map) { note.textContent = `Pickup: ${b.pickup_lat}, ${b.pickup_lng} · Destination: ${b.drop_lat}, ${b.drop_lng}`; return; }
  const maps = window.google.maps; const pts = [{ lat: Number(b.pickup_lat), lng: Number(b.pickup_lng) }, { lat: Number(b.drop_lat), lng: Number(b.drop_lng) }];
  new maps.Marker({ map, position: pts[0], icon: pinIcon(maps, '#15803d', 'P'), title: `Pickup: ${b.pickup_address}` });
  new maps.Marker({ map, position: pts[1], icon: pinIcon(maps, '#b91c1c', 'D'), title: `Destination: ${b.drop_address}` });
  const notes = [];
  const { data: routes } = await sb.from('ride_routes').select('route_kind,encoded_polyline,distance_km').eq('booking_id', b.id);
  const planned = routes?.find((r) => r.route_kind === 'planned' && r.encoded_polyline);
  if (planned) { const path = decodePolyline(planned.encoded_polyline); new maps.Polyline({ map, path, strokeColor: '#2563eb', strokeWeight: 4, strokeOpacity: .7 }); pts.push(...path); notes.push('Blue: planned route'); }
  else notes.push('No planned route stored (Google Routes was not configured at booking time)');
  if (can('tracking.history')) {
    try { const trail = await rpc('driver_location_trail', { p_booking_id: b.id, p_from: b.created_at, p_to: new Date().toISOString() });
      if (trail?.length) { const path = trail.map((t) => ({ lat: Number(t.lat), lng: Number(t.lng) })); new maps.Polyline({ map, path, strokeColor: '#15803d', strokeWeight: 4 }); pts.push(...path); notes.push(`Green: actual GPS trail (${trail.length} points)`); }
      else notes.push('No GPS trail recorded for this ride'); } catch { /* optional */ }
  }
  fitTo(map, pts); note.textContent = notes.join(' · ');
}
async function timelineTab(p, b) {
  const [hist, assigns] = await Promise.all([select('booking_status_history', '*', (q) => q.eq('booking_id', b.id).order('created_at')), select('driver_assignments', '*', (q) => q.eq('booking_id', b.id).order('created_at'))]);
  await attach(assigns, 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver');
  p.innerHTML = `<div class="grid grid-2"><div><h4 style="margin-bottom:10px">Status history</h4>${timeline(hist.map((h) => ({ title: `${esc(titleCase(h.from_status ?? 'start'))} → ${esc(titleCase(h.to_status))}`, text: `${esc(titleCase(h.actor_type))}${h.reason ? ` — ${esc(h.reason)}` : ''}`, time: dateTime(h.created_at), tone: h.to_status === 'CANCELLED' || h.to_status === 'DISPUTED' ? 'danger' : h.to_status === 'PAYMENT_COMPLETED' ? 'success' : '' })))}</div>
    <div><h4 style="margin-bottom:10px">Driver assignments</h4>${simpleTable([{ label: 'Driver', render: (a) => personCell(a.driver, 'driver_code') }, { label: 'Type', render: (a) => esc(titleCase(a.assignment_type)) }, { label: 'Result', render: (a) => badge(a.status) }, { label: 'When', render: (a) => esc(dateTime(a.created_at)) }, { label: 'Reason', render: (a) => esc(a.reason ?? '—') }], assigns, { icon: 'fa-user-slash', title: 'No driver offered yet' })}</div></div>`;
}
async function paymentTab(p, b, done) {
  const [pays, refunds] = await Promise.all([select('payments', '*', (q) => q.eq('booking_id', b.id)), select('refunds', '*', (q) => q.eq('booking_id', b.id).order('created_at'))]);
  const pay = pays[0];
  if (!pay) { p.innerHTML = emptyState({ icon: 'fa-receipt', title: 'No payment record yet', text: 'A payment record is created by the server when the ride is completed.' }); return; }
  const refundable = Number(pay.amount_paise) - Number(pay.refunded_paise);
  p.innerHTML = `${dl([['Transaction ID', `<span class="mono">${esc(pay.txn_code)}</span>`], ['Amount', money(pay.amount_paise)], ['Currency', esc(pay.currency)], ['Status', badge(pay.status)], ['Method', esc(titleCase(pay.method ?? b.payment_method))], ['Provider', esc(pay.provider ?? '—')],
    ['Provider order', `<span class="mono">${esc(pay.provider_order_id ?? '—')}</span>`], ['Provider payment', `<span class="mono">${esc(pay.provider_payment_id ?? '—')}</span>`], ['Captured at', esc(dateTime(pay.captured_at))], ['Refunded so far', money(pay.refunded_paise)], pay.failure_reason && ['Failure reason', esc(pay.failure_reason)]])}
    <div class="row" style="margin:14px 0">${['captured', 'partially_refunded'].includes(pay.status) && refundable > 0 && can('finance.refund') ? '<button class="btn" data-refund><i class="fa-solid fa-rotate-left"></i> Issue refund</button>' : ''}</div>
    <h4 style="margin:6px 0 10px">Refunds</h4>${simpleTable([{ label: 'Refund ID', render: (r) => `<span class="mono">${esc(r.txn_code)}</span>` }, { label: 'Amount', cls: 'num', render: (r) => money(r.amount_paise) }, { label: 'Status', render: (r) => badge(r.status) }, { label: 'Reason', render: (r) => esc(r.reason) }, { label: 'Requested', render: (r) => esc(dateTime(r.created_at)) }, { label: 'Provider ref', render: (r) => `<span class="mono">${esc(r.provider_refund_id ?? '—')}</span>` }], refunds, { icon: 'fa-rotate-left', title: 'No refunds' })}`;
  p.querySelector('[data-refund]')?.addEventListener('click', () => issueRefund(pay, done).catch(showError));
}
/** Two-step refund: the database validates and reserves; the gateway call happens server-side. */
export async function issueRefund(pay, done) {
  const max = Number(pay.amount_paise) - Number(pay.refunded_paise); const key = idempotencyKey('refund');
  const res = await formModal({ title: 'Issue refund', subtitle: `${pay.txn_code} · up to ${money(max)} refundable`, submitText: 'Issue refund', danger: true,
    fields: [{ name: 'amount', label: 'Refund amount (₹)', type: 'money', required: true, value: max, rules: [(v) => (Number(v) > 0 && Number(v) <= max ? null : `Enter between ₹0.01 and ${money(max)}`)] }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, rules: [rules.minLen(5)] }],
    onSubmit: async (v) => {
      const r = await rpc('request_refund', { p_payment_id: pay.id, p_amount_paise: v.amount, p_reason: v.reason, p_idempotency_key: key });
      if (r.needs_gateway) { const g = await fn('payments', { action: 'execute_refund', refund_id: r.refund_id }); return { ...r, gateway: g }; }
      return r;
    } });
  if (!res) return;
  if (res.duplicate) toast('info', 'This refund was already requested — nothing was repeated.');
  else if (res.needs_gateway) toast(res.gateway?.status === 'completed' ? 'success' : 'info', res.gateway?.status === 'completed' ? 'Refund completed by the gateway.' : 'Refund sent to the gateway. It will show as completed when the gateway confirms.');
  else toast('success', 'Cash refund recorded.');
  done?.();
}
async function otpTab(p, b) {
  const [otps, dist, disc] = await Promise.all([select('ride_otp_overview', '*', (q) => q.eq('booking_id', b.id).order('created_at', { ascending: false })), select('ride_distance_records', '*', (q) => q.eq('booking_id', b.id)), select('ride_discrepancies', '*', (q) => q.eq('booking_id', b.id).order('created_at'))]);
  const d = dist[0];
  p.innerHTML = `<h4 style="margin-bottom:10px">Distance record</h4>${d ? dl([['Original booked distance', km(d.original_booked_distance_km)], ['Booked distance (current)', km(d.booked_distance_km)], ['Driver-confirmed distance', `${km(d.driver_confirmed_distance_km)} ${d.driver_confirmed_at ? `<span class="cell-sub">${esc(dateTime(d.driver_confirmed_at))}</span>` : ''}`], ['Actual travelled (GPS)', km(d.actual_distance_km)], ['Final billable', km(d.final_billable_distance_km)], d.correction_reason && ['Correction', `${esc(d.correction_reason)} <span class="cell-sub">${esc(dateTime(d.corrected_at))}</span>`]]) : '<p class="muted">No distance record.</p>'}
    <h4 style="margin:16px 0 10px">OTP history</h4>${simpleTable([{ label: 'Generated', render: (o) => esc(dateTime(o.created_at)) }, { label: 'Type', render: (o) => badge(o.generation_type, o.generation_type === 'manual' ? 'violet' : 'info') }, { label: 'Status', render: (o) => badge(o.status) }, { label: 'Attempts', render: (o) => `${esc(o.attempt_count)} / ${esc(o.max_attempts)}` }, { label: 'SMS', render: (o) => badge(o.last_delivery_status) }, { label: 'Verified', render: (o) => esc(dateTime(o.verified_at)) }], otps, { icon: 'fa-key', title: 'No OTP generated yet', text: 'An OTP is generated automatically after the driver accepts.' })}
    <h4 style="margin:16px 0 10px">Distance discrepancies</h4>${simpleTable([{ label: 'Type', render: (x) => esc(titleCase(x.discrepancy_type)) }, { label: 'Expected', render: (x) => km(x.expected_km) }, { label: 'Reported', render: (x) => km(x.reported_km) }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Resolution', render: (x) => esc(x.resolution_reason ?? '—') }], disc, { icon: 'fa-ruler', title: 'No discrepancies' })}
    <p style="margin-top:12px"><a class="btn btn-sm" href="#/otp-verification?booking=${esc(b.id)}"><i class="fa-solid fa-key"></i> Open in OTP Verification Centre</a></p>`;
}
async function disputeTab(p, b, done) {
  const rows = await select('ride_disputes', '*', (q) => q.eq('booking_id', b.id).order('created_at', { ascending: false }));
  p.innerHTML = simpleTable([{ label: 'Opened', render: (d) => esc(dateTime(d.created_at)) }, { label: 'Category', render: (d) => badge(d.category, 'info') }, { label: 'Description', render: (d) => esc(d.description) }, { label: 'Status', render: (d) => badge(d.status) }, { label: 'Resolution', render: (d) => esc(d.resolution ?? '—') },
    { label: '', render: (d) => (['open', 'investigating'].includes(d.status) && can('rides.disputes') ? `<button class="btn btn-sm" data-resolve="${esc(d.id)}">Resolve</button>` : '') }], rows, { icon: 'fa-scale-balanced', title: 'No disputes on this ride' });
  p.querySelectorAll('[data-resolve]').forEach((btn) => { btn.onclick = () => resolveDispute({ ...rows.find((r) => r.id === btn.dataset.resolve), booking: b }, done); });
}
async function auditTab(p, b) {
  const rows = await select('audit_logs', 'id,action,actor_type,actor_staff_id,reason,created_at,new_data', (q) => q.eq('entity_id', b.id).order('created_at', { ascending: false }).limit(200));
  await attach(rows, 'actor_staff_id', 'staff_accounts', 'id,full_name', 'staff');
  p.innerHTML = timeline(rows.map((a) => ({ title: esc(titleCase(a.action.replace(/\./g, ' '))), text: `${esc(a.staff?.full_name ?? titleCase(a.actor_type))}${a.reason ? ` — ${esc(a.reason)}` : ''}`, time: dateTime(a.created_at), tone: /cancel|override|sos|refund/.test(a.action) ? 'danger' : '' })), 'No audit entries for this booking.');
}

// ---------- assignment ----------
async function assignDriver(b, done) {
  const m = openModal({ title: b.driver_id ? 'Reassign driver' : 'Assign driver', subtitle: `${b.booking_code} · nearest available drivers with a matching active vehicle`, size: 'lg', body: loadingState('Finding available drivers…'), footer: '' });
  let reason = null;
  const assign = async (driverId, btn) => withBusy(btn, async () => {
    try {
      if (b.driver_id && !reason) { reason = await promptReason({ title: 'Reason for reassignment', text: 'The current driver is released and their OTP is invalidated.', placeholder: 'e.g. Vehicle breakdown' }); if (!reason) return; }
      await rpc('assign_driver', { p_booking_id: b.id, p_driver_id: driverId, p_reason: reason });
      toast('success', 'Driver assigned. Waiting for the driver to accept.'); m.close(); done();
    } catch (e) { showError(e); }
  });
  try {
    const list_ = await rpc('allocation_candidates', { p_booking_id: b.id, p_limit: 15 });
    m.body.innerHTML = `${list_?.length ? `<div class="card">${list_.map((c, i) => `<div class="list-item" style="cursor:default"><span class="avatar">${i + 1}</span><div><div class="cell-main">${esc(c.full_name)} <span class="cell-sub mono">${esc(c.driver_code)}</span></div>
      <div class="cell-sub">${esc(c.registration_number)} · ${c.distance_km === null ? 'distance unknown' : `${esc(Number(c.distance_km).toFixed(1))} km from pickup`} · ★ ${esc(Number(c.rating_avg).toFixed(1))} · ${c.location_live ? '<span style="color:var(--success)">live location</span>' : `<span style="color:var(--warning)">location ${c.location_at ? esc(ago(c.location_at)) : 'never received'}</span>`}</div></div>
      <span class="badge info" title="Allocation score: distance, rating and acceptance">${esc(c.score)}</span><button class="btn btn-sm btn-primary" data-driver="${esc(c.driver_id)}">Assign</button></div>`).join('')}</div>`
      : emptyState({ icon: 'fa-user-slash', title: 'No available driver', text: 'No approved driver is online in this city with an active vehicle of this category. Drivers appear here when they go online.' })}
      <p class="field-help" style="margin-top:10px">Ranking is a transparent score (distance to pickup, rating, acceptance rate). You decide; nothing is assigned automatically from this list.</p>`;
    m.foot.innerHTML = `${setting('feature.auto_assignment', false) && list_?.length ? '<button class="btn" data-auto><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-assign best match</button>' : ''}<button class="btn" data-x>Close</button>`;
    m.foot.querySelector('[data-x]').onclick = () => m.close();
    m.foot.querySelector('[data-auto]')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => { try { await rpc('auto_assign_driver', { p_booking_id: b.id }); toast('success', 'Best-ranked driver assigned.'); m.close(); done(); } catch (err) { showError(err); } }));
    m.body.querySelectorAll('[data-driver]').forEach((btn) => { btn.onclick = () => assign(btn.dataset.driver, btn); });
  } catch (e) { m.body.innerHTML = errorState(e); }
}

// ---------- new booking ----------
async function newBooking(done) {
  const [cityList, cats] = await Promise.all([cities(), categories()]);
  const activeCities = cityList.filter((c) => c.is_active);
  let customer = null, quote = null;
  const fields = [
    { name: 'city_id', label: 'City', type: 'select', required: true, options: asOptions(activeCities), value: activeCities.length === 1 ? activeCities[0].id : '' },
    { name: 'category_id', label: 'Vehicle category', type: 'select', required: true, options: asOptions(cats.filter((c) => c.is_active)) },
    { name: 'pickup_address', label: 'Pickup address', required: true, full: true, rules: [rules.minLen(3)] },
    { name: 'pickup_lat', label: 'Pickup latitude', type: 'number', required: true, rules: [rules.lat] }, { name: 'pickup_lng', label: 'Pickup longitude', type: 'number', required: true, rules: [rules.lng] },
    { name: 'drop_address', label: 'Destination address', required: true, full: true, rules: [rules.minLen(3)] },
    { name: 'drop_lat', label: 'Destination latitude', type: 'number', required: true, rules: [rules.lat] }, { name: 'drop_lng', label: 'Destination longitude', type: 'number', required: true, rules: [rules.lng] },
    { name: 'payment_method', label: 'Payment method', type: 'select', required: true, noBlank: true, options: ['cash', 'upi', 'card', 'netbanking'], value: 'cash' },
    { name: 'coupon_code', label: 'Coupon code (optional)', upper: true },
    ...(setting('feature.scheduled_rides', true) ? [{ name: 'scheduled_for', label: 'Schedule for later (optional)', type: 'datetime', rules: [(v) => (!v || new Date(v) > new Date() ? null : 'Choose a future time')] }] : []),
  ];
  const m = openModal({ title: 'New booking', subtitle: 'Created on behalf of a customer. Distance and fare are calculated by the server.', size: 'lg',
    body: `<div class="field"><span class="label">Customer <span class="req">*</span></span><div class="row"><button type="button" class="btn" data-pick><i class="fa-solid fa-user"></i> Choose customer</button><span data-customer class="muted">None selected</span></div></div>
      ${mapsConfigured() ? '' : notice('warning', 'Address search is off', ' because Google Maps is not configured. Enter the coordinates by hand (right-click a place in Google Maps to copy them).')}
      <form novalidate>${formHtml(fields)}</form><div data-quote></div><div class="form-error" role="alert" hidden></div>`,
    footer: '<button class="btn" data-cancel>Cancel</button><button class="btn" data-quote-btn><i class="fa-solid fa-calculator"></i> Get fare quote</button><button class="btn btn-primary" data-create>Create booking</button>' });
  const form = m.body.querySelector('form'), err = m.body.querySelector('.form-error'), qbox = m.body.querySelector('[data-quote]');
  const input = (n) => form.querySelector(`[name="${n}"]`);
  m.foot.querySelector('[data-cancel]').onclick = () => m.close();
  m.body.querySelector('[data-pick]').onclick = async () => { const c = await pickCustomer(); if (c) { customer = c; m.body.querySelector('[data-customer]').innerHTML = `<strong>${esc(c.full_name)}</strong> <span class="mono">${esc(c.customer_code)}</span>`; if (c.city_id && !input('city_id').value) input('city_id').value = c.city_id; } };
  const bias = () => { const c = cityList.find((x) => x.id === input('city_id').value); return c?.center_lat ? { lat: Number(c.center_lat), lng: Number(c.center_lng) } : null; };
  for (const side of ['pickup', 'drop']) attachAutocomplete(input(`${side}_address`), (p) => { input(`${side}_address`).value = p.address; input(`${side}_lat`).value = p.lat; input(`${side}_lng`).value = p.lng; }, bias());
  const collect = () => {
    err.hidden = true; const v = readFields(form, fields); const res = validate(fields, v); showFieldErrors(form, res.errors);
    if (!customer) { err.textContent = 'Choose a customer first.'; err.hidden = false; return null; }
    return res.ok ? v : null;
  };
  const base = (v) => ({ customer_id: customer.id, category_id: v.category_id, city_id: v.city_id, pickup_address: v.pickup_address, pickup_lat: v.pickup_lat, pickup_lng: v.pickup_lng, drop_address: v.drop_address, drop_lat: v.drop_lat, drop_lng: v.drop_lng });
  m.foot.querySelector('[data-quote-btn]').onclick = (e) => withBusy(e.currentTarget, async () => {
    const v = collect(); if (!v) return;
    try {
      let q;
      try { q = await fn('bookings', { action: 'quote', ...base(v) }); if (q?.ok === false) throw new AppError(q.code, q.message); }
      catch (ex) {
        if (toAppError(ex).code !== 'FUNCTION_NOT_DEPLOYED') throw ex;
        // Server function not deployed: quote with the database's straight-line estimate, clearly labelled.
        const h = await rpc('haversine_km', { lat1: v.pickup_lat, lng1: v.pickup_lng, lat2: v.drop_lat, lng2: v.drop_lng }); const dist = Math.round(Number(h) * 1.3 * 100) / 100;
        q = { distance_km: dist, duration_min: null, distance_source: 'haversine_estimate', fare: await rpc('calculate_fare', { p_category_id: v.category_id, p_city_id: v.city_id, p_distance_km: dist, p_duration_min: Math.ceil(dist * 3), p_pickup_lat: v.pickup_lat, p_pickup_lng: v.pickup_lng }) };
      }
      quote = q; const f = q.fare;
      qbox.innerHTML = `<section class="card" style="margin-top:6px"><div class="card-head"><h3><i class="fa-solid fa-calculator"></i>Fare quote</h3><span class="badge ${q.distance_source === 'google_routes' ? 'success' : 'warning'}">${q.distance_source === 'google_routes' ? 'Road distance (Google Routes)' : 'Straight-line estimate'}</span></div><div class="card-body">
        <div class="kv"><span>Distance</span><span>${km(q.distance_km)}${q.duration_min ? ` · ~${esc(q.duration_min)} min` : ''}</span></div><div class="kv"><span>Base + distance + time</span><span>${money(Number(f.base_fare_paise) + Number(f.distance_fare_paise) + Number(f.time_fare_paise))}</span></div>
        <div class="kv"><span>Night / peak / surge</span><span>${money(f.surcharge_paise)}</span></div><div class="kv"><span>GST</span><span>${money(f.tax_paise)}</span></div><div class="kv total"><span>Estimated total (before coupon)</span><span>${money(f.total_fare_paise)}</span></div></div></section>`;
    } catch (ex) { err.textContent = toAppError(ex).message; err.hidden = false; }
  });
  m.foot.querySelector('[data-create]').onclick = (e) => withBusy(e.currentTarget, async () => {
    const v = collect(); if (!v) return;
    try {
      let booking;
      try { const r = await fn('bookings', { action: 'create', ...base(v), payment_method: v.payment_method, coupon_code: v.coupon_code, scheduled_for: v.scheduled_for }); if (r?.ok === false) throw new AppError(r.code, r.message); booking = r.booking; }
      catch (ex) {
        if (toAppError(ex).code !== 'FUNCTION_NOT_DEPLOYED') throw ex;
        booking = await rpc('create_booking', { p_customer_id: customer.id, p_category_id: v.category_id, p_city_id: v.city_id, p_pickup_address: v.pickup_address, p_pickup_lat: v.pickup_lat, p_pickup_lng: v.pickup_lng,
          p_drop_address: v.drop_address, p_drop_lat: v.drop_lat, p_drop_lng: v.drop_lng, p_payment_method: v.payment_method, p_coupon_code: v.coupon_code, p_scheduled_for: v.scheduled_for });
      }
      toast('success', `Booking ${booking.booking_code} created${booking.distance_source === 'haversine_estimate' ? ' (distance is a straight-line estimate)' : ''}.`);
      m.close(); done?.(); openBooking(booking.id, done);
    } catch (ex) { err.textContent = toAppError(ex).message; err.hidden = false; }
  });
}

export async function init(root, { params, setParams }) {
  applyPermissions(root);
  const [cityList, cats] = await Promise.all([cities(), categories()]);
  const ctx = { cityOptions: asOptions(cityList), catOptions: asOptions(cats), catNames: nameMap(cats) };
  const tb = tabs(root.querySelector('#rides-tabs'), [
    { id: 'all', label: 'All bookings', icon: 'fa-list', render: (p) => ridesTable(p, ctx) },
    { id: 'ongoing', label: 'Ongoing', icon: 'fa-route', render: (p) => ridesTable(p, { ...ctx, statuses: ONGOING }) },
    { id: 'completed', label: 'Completed', icon: 'fa-circle-check', render: (p) => ridesTable(p, { ...ctx, statuses: ['RIDE_COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED'] }) },
    { id: 'cancelled', label: 'Cancelled', icon: 'fa-ban', render: (p) => ridesTable(p, { ...ctx, statuses: ['CANCELLED'] }) },
    { id: 'disputes', label: 'Disputes', icon: 'fa-scale-balanced', render: (p) => disputesTable(p) },
    { id: 'emergency', label: 'Emergency rides', icon: 'fa-triangle-exclamation', render: (p) => ridesTable(p, { ...ctx, emergency: true }) },
  ], { initial: params.tab, onChange: (id) => setParams({ tab: id, id: null }) });
  root.querySelector('#ride-new')?.addEventListener('click', () => newBooking(() => tb.show(tb.current())).catch(showError));
  if (params.id) openBooking(params.id, () => tb.show(tb.current()));
  return () => tb.destroy();
}
