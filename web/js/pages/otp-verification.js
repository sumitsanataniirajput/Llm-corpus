// Module 5A — Booking OTP, distance confirmation and ride-start control.
import { rpc, fn, toAppError, AppError } from '../supabase-client.js';
import { list, select, subscribe, getOne } from '../api.js';
import { dataTable, tabs, badge, statCards, notice, toast, showError, formModal, promptReason, confirmDialog, openModal, loadingState, errorState, emptyState, simpleTable, dl, timeline } from '../components.js';
import { esc, dateTime, ago, km, money, titleCase, number, duration, debounce, rangeFor } from '../utilities.js';
import { can } from '../permissions.js';
import { reauthenticate } from '../auth.js';
import { rules } from '../validation.js';
import { attach, rideLink } from './shared.js';

const callOtp = async (body) => { const r = await fn('otp', body); if (r?.ok === false) throw new AppError(r.code, r.message); return r; };
const smsNote = (r) => (r.delivery?.status === 'sent' || r.delivery?.status === 'delivered' ? 'SMS sent to the customer.' : r.delivery?.status === 'not_configured' ? 'OTP created, but SMS is NOT configured — the customer has not received it.' : `OTP created, but the SMS failed: ${r.delivery?.error ?? 'unknown error'}`);

async function resend(row, done) {
  if (!(await confirmDialog({ title: 'Resend OTP?', text: `A NEW OTP is generated for ${row.booking_code} and sent to the customer’s registered mobile number. The previous OTP stops working.`, confirmText: 'Resend OTP' }))) return;
  const r = await callOtp({ action: 'resend', booking_id: row.booking_id }); toast(r.delivery?.status === 'sent' ? 'success' : 'warning', smsNote(r), 9000); done?.();
}
async function generateManual(row, done) {
  const reason = await promptReason({ title: 'Generate OTP manually', text: `Use when the automatic OTP was not created for ${row.booking_code}. It is sent only to the customer’s registered mobile number and recorded as a manual generation.`, confirmText: 'Generate & send' });
  if (!reason) return; const r = await callOtp({ action: 'generate', booking_id: row.booking_id, reason }); toast(r.delivery?.status === 'sent' ? 'success' : 'warning', smsNote(r), 9000); done?.();
}
async function override(row, done) {
  const ok = await formModal({ title: 'Emergency override', subtitle: `${row.booking_code} — allow the ride to start WITHOUT an OTP`, danger: true, submitText: 'Authorise ride start',
    intro: notice('danger', 'Super Admin only. This bypasses customer verification.', ' Use it only when the customer is present but cannot receive the OTP. Your identity, the reason and the time are recorded permanently and cannot be edited.'),
    fields: [{ name: 'reason', label: 'Mandatory reason', type: 'textarea', required: true, rules: [rules.minLen(20)], help: 'At least 20 characters. Why can the customer not receive or read the OTP?' },
      { name: 'identity', label: 'How was the customer identified?', type: 'textarea', required: true, rules: [rules.minLen(10)], help: 'e.g. “Called the registered number, customer confirmed name and pickup address”.' },
      { name: 'password', label: 'Re-enter your password', type: 'password', required: true, autocomplete: 'current-password' }],
    onSubmit: async (v) => callOtp({ action: 'override', booking_id: row.booking_id, reason: v.reason, identity_confirmation: v.identity, password: v.password }) });
  if (ok) { toast('warning', 'Override recorded. The driver can now start the ride.', 9000); done?.(); }
}
async function resolveDiscrepancy(d, done) {
  const ok = await formModal({ title: 'Resolve distance discrepancy', subtitle: `${d.booking?.booking_code ?? ''} · booked ${km(d.expected_km)} vs reported ${km(d.reported_km)}`,
    fields: [{ name: 'action', label: 'Decision', type: 'select', required: true, noBlank: true, options: [{ value: 'dismiss', label: 'Keep the booked distance (dismiss)' }, { value: 'correct', label: 'Correct the billable distance' }] },
      { name: 'km', label: 'Corrected distance (km)', type: 'number', min: 0.1, max: 2000, showIf: (v) => v.action === 'correct', rules: [(v, all) => (all.action !== 'correct' || (v > 0 && v <= 2000) ? null : 'Enter the corrected distance in km')] },
      { name: 'reason', label: 'Reason', type: 'textarea', required: true, rules: [rules.minLen(5)], help: 'The original booked distance is preserved; the correction is stored separately with your name.' }],
    onSubmit: (v) => rpc('resolve_distance_discrepancy', { p_discrepancy_id: d.id, p_action: v.action, p_corrected_km: v.action === 'correct' ? v.km : null, p_reason: v.reason }) });
  if (ok) { toast('success', 'Discrepancy resolved.'); done?.(); }
}
async function showHistory(row) {
  const m = openModal({ title: `OTP history — ${row.booking_code}`, size: 'lg', footer: null, body: loadingState() });
  try {
    const [audit, attempts, deliveries, daudit] = await Promise.all([
      select('otp_audit_logs', '*', (q) => q.eq('booking_id', row.booking_id).order('created_at', { ascending: false }).limit(200)), select('otp_verification_attempts', '*', (q) => q.eq('booking_id', row.booking_id).order('created_at', { ascending: false }).limit(100)),
      select('otp_delivery_logs', '*', (q) => q.eq('booking_id', row.booking_id).order('created_at', { ascending: false }).limit(100)), select('distance_audit_logs', '*', (q) => q.eq('booking_id', row.booking_id).order('created_at', { ascending: false }).limit(100))]);
    m.body.innerHTML = `<div class="grid grid-2"><div><h4 style="margin-bottom:10px">OTP events (immutable)</h4>${timeline(audit.map((a) => ({ title: esc(titleCase(a.event)), text: `${esc(titleCase(a.actor_type))}${a.details?.reason ? ` — ${esc(a.details.reason)}` : ''}`, time: dateTime(a.created_at), tone: /override|locked|failed|suspicious/.test(a.event) ? 'danger' : /verified/.test(a.event) ? 'success' : '' })), 'No OTP events yet.')}</div>
      <div><h4 style="margin-bottom:10px">Verification attempts</h4>${simpleTable([{ label: 'When', render: (a) => esc(dateTime(a.created_at)) }, { label: 'Result', render: (a) => badge(a.result, a.result === 'success' ? 'success' : 'danger') }, { label: 'Distance entered', render: (a) => km(a.submitted_distance_km) }, { label: 'Flag', render: (a) => (a.is_suspicious ? '<span class="badge danger">Suspicious</span>' : '') }], attempts, { icon: 'fa-keyboard', title: 'No attempts yet' })}
      <h4 style="margin:16px 0 10px">SMS deliveries</h4>${simpleTable([{ label: 'When', render: (x) => esc(dateTime(x.created_at)) }, { label: 'Type', render: (x) => esc(titleCase(x.delivery_type)) }, { label: 'To', render: (x) => `<span class="mono">${esc(x.phone_masked)}</span>` }, { label: 'Provider', render: (x) => esc(x.provider ?? '—') }, { label: 'Status', render: (x) => badge(x.status) + (x.error ? `<div class="cell-sub">${esc(x.error)}</div>` : '') }], deliveries, { icon: 'fa-comment-sms', title: 'No SMS attempted' })}
      <h4 style="margin:16px 0 10px">Distance events</h4>${timeline(daudit.map((a) => ({ title: esc(titleCase(a.event)), text: esc(titleCase(a.actor_type)), time: dateTime(a.created_at) })), 'No distance events.')}</div></div>`;
  } catch (e) { m.body.innerHTML = errorState(e); }
}

function ridesPane(pane, { waitingOnly, bookingId }) {
  const t = dataTable(pane, {
    search: { placeholder: 'Booking ID, customer or driver…' },
    filters: waitingOnly ? [] : [{ name: 'status', label: 'Any OTP status', options: ['active', 'locked', 'verified', 'expired', 'invalidated', 'overridden'] }, { name: 'generation_type', label: 'Any type', options: [{ value: 'auto', label: 'Automatic' }, 'resend', 'manual'] }],
    columns: [
      { label: 'Booking', render: (r) => `<a class="mono cell-main" href="#/rides?id=${esc(r.booking_id)}">${esc(r.booking_code)}</a><div>${badge(r.booking_status)}</div>` },
      { label: 'Customer / driver', render: (r) => `<div class="cell-main">${esc(r.customer_name ?? '—')}</div><div class="cell-sub"><i class="fa-solid fa-id-card"></i> ${esc(r.driver_name ?? 'No driver')} ${esc(r.driver_code ?? '')}</div>` },
      { label: 'Route', render: (r) => `<div style="max-width:260px" class="cell-sub">${esc(r.pickup_address)} → ${esc(r.drop_address)}</div>` },
      { label: 'Booked distance', cls: 'num', render: (r) => km(r.booked_distance_km) },
      { label: 'OTP', render: (r) => `${badge(r.status)} <span class="cell-sub">${esc(titleCase(r.generation_type))}</span><div class="cell-sub">${r.status === 'active' ? (new Date(r.expires_at) > new Date() ? `expires ${esc(ago(r.expires_at))}` : '<span style="color:var(--danger)">expired — resend needed</span>') : r.verified_at ? `verified ${esc(dateTime(r.verified_at))}` : ''}</div>` },
      { label: 'Attempts', render: (r) => `<span class="${r.attempt_count >= r.max_attempts ? 'badge danger' : ''}">${esc(r.attempt_count)} / ${esc(r.max_attempts)}</span>` },
      { label: 'SMS', render: (r) => (r.last_delivery_status ? badge(r.last_delivery_status) : '<span class="muted">—</span>') + `<div class="cell-sub">${esc(r.delivery_count ?? 0)} sent</div>` },
    ],
    rowClass: (r) => (r.status === 'locked' ? 'row-danger' : ''),
    load: (state) => list('ride_otp_overview', { search: state.search, searchColumns: ['booking_code', 'customer_name', 'driver_name', 'driver_code'], filters: state.filters, page: state.page, pageSize: state.pageSize,
      apply: (q) => { if (bookingId) q = q.eq('booking_id', bookingId); if (waitingOnly) q = q.in('booking_status', ['DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'OTP_PENDING']).in('status', ['active', 'locked', 'expired']); return q; } }),
    rowActions: (r) => { const open = ['DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'OTP_PENDING'].includes(r.booking_status); return [
      { icon: 'fa-clock-rotate-left', title: 'OTP history', onClick: () => showHistory(r) },
      open && { icon: 'fa-paper-plane', title: 'Resend OTP to customer', perm: 'otp.deliver', onClick: () => resend(r, () => t.reload()) },
      open && { icon: 'fa-key', title: 'Generate OTP manually', perm: 'otp.generate', onClick: () => generateManual(r, () => t.reload()) },
      open && { icon: 'fa-unlock-keyhole', title: 'Emergency override (Super Admin)', perm: 'otp.override', onClick: () => override(r, () => t.reload()) },
    ]; },
    empty: waitingOnly ? { icon: 'fa-circle-check', title: 'No ride is waiting for an OTP', text: 'Accepted rides appear here until the driver verifies the customer’s OTP.' } : { icon: 'fa-key', title: 'No OTPs generated yet', text: 'An OTP is created automatically when a driver accepts a booking.' },
  });
  const soft = debounce(() => t.reload({ silent: true }), 1200);
  return subscribe('otp-centre', ['otp_audit_logs', 'otp_delivery_logs', { table: 'bookings', event: 'UPDATE' }], soft);
}
function missingPane(pane) {
  // Accepted rides that have NO OTP at all (automatic generation failed or the function is not deployed).
  dataTable(pane, { search: false, columns: [
    { label: 'Booking', render: (b) => rideLink(b) }, { label: 'Status', render: (b) => badge(b.status) }, { label: 'Accepted', render: (b) => esc(dateTime(b.accepted_at)) }, { label: 'Pickup', render: (b) => esc(b.pickup_address) }, { label: 'Booked distance', render: (b) => km(b.booked_distance_km) }],
    load: async () => { const d = await rpc('otp_dashboard'); const ids = (d.waiting_for_otp ?? []).filter((x) => !x.otp_status).map((x) => x.booking_id); if (!ids.length) return { rows: [], count: 0 }; const rows = await select('bookings', 'id,booking_code,status,accepted_at,pickup_address,booked_distance_km', (q) => q.in('id', ids)); return { rows, count: rows.length }; },
    rowActions: (b) => [{ icon: 'fa-key', title: 'Generate OTP now', perm: 'otp.generate', onClick: () => generateManual({ booking_id: b.id, booking_code: b.booking_code }) }],
    empty: { icon: 'fa-circle-check', title: 'Every accepted ride has an OTP', text: 'If a ride appears here, the OTP Edge Function did not run — generate it manually.' } });
}
function attemptsPane(pane) {
  dataTable(pane, { search: false, filters: [{ name: 'result', label: 'Any result', options: ['success', 'incorrect_otp', 'distance_mismatch', 'expired', 'locked', 'not_assigned_driver', 'invalid_state', 'already_used', 'no_active_otp', 'rate_limited'] }, { name: 'is_suspicious', label: 'All attempts', options: [{ value: 'true', label: 'Suspicious only' }] }],
    columns: [{ label: 'When', render: (a) => esc(dateTime(a.created_at)) }, { label: 'Booking', render: (a) => rideLink(a.booking) }, { label: 'Driver', render: (a) => esc(a.driver?.full_name ?? '—') }, { label: 'Result', render: (a) => badge(a.result, a.result === 'success' ? 'success' : 'danger') },
      { label: 'Distance entered', render: (a) => km(a.submitted_distance_km) }, { label: 'Flag', render: (a) => (a.is_suspicious ? '<span class="badge danger">Suspicious</span>' : '—') }, { label: 'IP', render: (a) => `<span class="mono">${esc(a.ip ?? '—')}</span>` }],
    load: async (s) => { const r = await list('otp_verification_attempts', { filters: s.filters, page: s.page, pageSize: s.pageSize }); await Promise.all([attach(r.rows, 'booking_id', 'bookings', 'id,booking_code', 'booking'), attach(r.rows, 'driver_id', 'drivers', 'id,full_name', 'driver')]); return r; },
    empty: { icon: 'fa-keyboard', title: 'No verification attempts recorded' } });
}
function discrepancyPane(pane) {
  const t = dataTable(pane, { search: false, filters: [{ name: 'status', label: 'All statuses', options: ['open', 'corrected', 'dismissed'], value: 'open' }, { name: 'discrepancy_type', label: 'All types', options: ['distance_confirmation_mismatch', 'actual_vs_booked_distance'] }],
    columns: [{ label: 'Booking', render: (d) => rideLink(d.booking) }, { label: 'Type', render: (d) => esc(titleCase(d.discrepancy_type)) }, { label: 'Booked', cls: 'num', render: (d) => km(d.expected_km) }, { label: 'Reported', cls: 'num', render: (d) => km(d.reported_km) },
      { label: 'Difference', cls: 'num', render: (d) => (d.expected_km && d.reported_km ? `${(((d.reported_km - d.expected_km) / d.expected_km) * 100).toFixed(0)}%` : '—') }, { label: 'Status', render: (d) => badge(d.status) }, { label: 'Raised', render: (d) => esc(dateTime(d.created_at)) },
      { label: 'Resolution', render: (d) => (d.resolution_reason ? `${d.corrected_km ? `${km(d.corrected_km)} — ` : ''}${esc(d.resolution_reason)}` : '—') }],
    load: async (s) => { const r = await list('ride_discrepancies', { filters: s.filters, page: s.page, pageSize: s.pageSize }); await attach(r.rows, 'booking_id', 'bookings', 'id,booking_code,status', 'booking'); return r; },
    rowActions: (d) => [d.status === 'open' && { icon: 'fa-gavel', title: 'Resolve', perm: 'otp.correct_distance', onClick: () => resolveDiscrepancy(d, () => t.reload()) }],
    empty: { icon: 'fa-ruler', title: 'No distance discrepancies' } });
}
function deliveryPane(pane) {
  dataTable(pane, { search: false, filters: [{ name: 'status', label: 'Any status', options: ['sent', 'delivered', 'failed', 'not_configured', 'queued'] }],
    columns: [{ label: 'When', render: (x) => esc(dateTime(x.created_at)) }, { label: 'Booking', render: (x) => rideLink(x.booking) }, { label: 'Type', render: (x) => esc(titleCase(x.delivery_type)) }, { label: 'To', render: (x) => `<span class="mono">${esc(x.phone_masked)}</span>` },
      { label: 'Provider', render: (x) => esc(x.provider ?? '—') }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Error', render: (x) => esc(x.error ?? '—') }],
    load: async (s) => { const r = await list('otp_delivery_logs', { filters: s.filters, page: s.page, pageSize: s.pageSize }); await attach(r.rows, 'booking_id', 'bookings', 'id,booking_code', 'booking'); return r; },
    empty: { icon: 'fa-comment-sms', title: 'No SMS delivery attempts yet' } });
}
function auditPane(pane) {
  dataTable(pane, { search: false, filters: [{ name: 'event', label: 'All events', options: ['otp_generated', 'otp_verified', 'incorrect_otp', 'suspicious_attempt', 'otp_locked', 'otp_expired', 'resend_limit_reached', 'manager_override', 'ride_start_authorized'] }],
    columns: [{ label: 'When', render: (a) => esc(dateTime(a.created_at)) }, { label: 'Booking', render: (a) => rideLink(a.booking) }, { label: 'Event', render: (a) => badge(a.event, /override|locked|failed/.test(a.event) ? 'danger' : /verified/.test(a.event) ? 'success' : 'info') },
      { label: 'By', render: (a) => esc(a.staff?.full_name ?? titleCase(a.actor_type)) }, { label: 'Details', render: (a) => `<span class="cell-sub">${esc(Object.entries(a.details ?? {}).filter(([k]) => !/hash|salt|otp$/i.test(k)).map(([k, v]) => `${titleCase(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '))}</span>` }],
    load: async (s) => { const r = await list('otp_audit_logs', { filters: s.filters, page: s.page, pageSize: s.pageSize }); await Promise.all([attach(r.rows, 'booking_id', 'bookings', 'id,booking_code', 'booking'), attach(r.rows.filter((x) => x.actor_type === 'staff'), 'actor_id', 'staff_accounts', 'id,full_name', 'staff')]); return r; },
    empty: { icon: 'fa-clipboard-list', title: 'No OTP audit entries yet' } });
}

export async function init(root, { params, setParams }) {
  const $ = (s) => root.querySelector(s);
  async function stats() {
    try {
      const r = rangeFor('week'); const d = await rpc('otp_dashboard', { p_from: r.from, p_to: r.to });
      statCards($('#otp-stats'), [
        { label: 'Waiting for verification', value: number(d.active), icon: 'fa-hourglass-half', tone: 'info' }, { label: 'Verified (7 days)', value: number(d.verified), icon: 'fa-circle-check', tone: 'success', hint: d.avg_seconds_to_verify ? `avg ${duration(d.avg_seconds_to_verify)} to verify` : '' },
        { label: 'Incorrect attempts', value: number(d.incorrect_attempts), icon: 'fa-circle-xmark', tone: 'warning', hint: `${number(d.suspicious_attempts)} suspicious` }, { label: 'Locked', value: number(d.locked), icon: 'fa-lock', tone: 'danger' },
        { label: 'Expired', value: number(d.expired), icon: 'fa-clock' }, { label: 'Resent / manual', value: `${number(d.resent)} / ${number(d.manual_generated)}`, icon: 'fa-paper-plane' },
        { label: 'Distance mismatches', value: number(d.distance_mismatches), icon: 'fa-ruler', tone: 'warning', hint: `${number(d.open_discrepancies)} open` }, { label: 'Emergency overrides', value: number(d.overridden), icon: 'fa-unlock-keyhole', tone: d.overridden ? 'danger' : 'neutral' },
      ]);
      tb?.setCount('missing', d.accepted_without_otp, true); tb?.setCount('discrepancies', d.open_discrepancies, true);
      const del = d.deliveries ?? {};
      $('#otp-sms').innerHTML = del.not_configured ? notice('danger', 'SMS is not configured.', ` ${del.not_configured} OTP message(s) in the last 7 days were NOT delivered. Customers cannot receive their OTP until an SMS provider is configured (Settings → Integrations).`)
        : del.failed ? notice('warning', `${del.failed} OTP SMS failed in the last 7 days.`, ' Check the SMS delivery tab for the provider error.') : '';
    } catch (e) { $('#otp-stats').innerHTML = errorState(e); }
  }
  let tb = null;
  tb = tabs($('#otp-tabs'), [
    { id: 'waiting', label: 'Waiting for OTP', icon: 'fa-hourglass-half', render: (p) => ridesPane(p, { waitingOnly: true }) },
    { id: 'missing', label: 'Accepted without OTP', icon: 'fa-triangle-exclamation', render: (p) => missingPane(p) },
    { id: 'all', label: 'All OTPs', icon: 'fa-key', render: (p) => ridesPane(p, { waitingOnly: false, bookingId: params.booking }) },
    { id: 'attempts', label: 'Attempts', icon: 'fa-keyboard', render: (p) => attemptsPane(p) },
    { id: 'discrepancies', label: 'Distance discrepancies', icon: 'fa-ruler', render: (p) => discrepancyPane(p) },
    { id: 'delivery', label: 'SMS delivery', icon: 'fa-comment-sms', render: (p) => deliveryPane(p) },
    { id: 'audit', label: 'Audit trail', icon: 'fa-clipboard-list', perm: 'otp.reports', render: (p) => auditPane(p) },
  ], { initial: params.booking ? 'all' : params.tab, onChange: (id) => setParams({ tab: id }) });
  $('#otp-refresh').onclick = () => { stats(); tb.show(tb.current()); };
  await stats();
  const timer = setInterval(() => { if (!document.hidden) stats(); }, 30000);
  return () => { clearInterval(timer); tb.destroy(); };
}
