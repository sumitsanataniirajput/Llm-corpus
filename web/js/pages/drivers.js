// Module 2 — Driver management.
import { rpc } from '../supabase-client.js';
import { list, listAll, select, getOne, insert, update, cities, branches, asOptions, nameMap, uploadFile, countOf } from '../api.js';
import { dataTable, tabs, badge, openModal, formModal, promptReason, confirmDialog, toast, showError, dl, timeline, simpleTable, loadingState, errorState, emptyState, notice, statCards } from '../components.js';
import { esc, money, dateTime, date, ago, titleCase, number, pct, rangeFor, idempotencyKey, parseCsv, download } from '../utilities.js';
import { can } from '../permissions.js';
import { rules, normalisePhone, validateFile } from '../validation.js';
import { attach, viewDocument, docLabel, expiryBadge, DRIVER_DOCS, pickVehicle, rideLink } from './shared.js';

const STATUSES = ['pending', 'under_review', 'approved', 'rejected', 'suspended', 'deactivated', 'blacklisted'];
const driverFields = (cityOpts, branchOpts, d = {}) => [
  { type: 'section', label: 'Personal details' },
  { name: 'full_name', label: 'Full name', required: true, rules: [rules.minLen(3), rules.maxLen(120)] },
  { name: 'phone', label: 'Mobile number', type: 'tel', required: true, rules: [rules.phone], help: '10-digit Indian mobile number' },
  { name: 'email', label: 'E-mail', type: 'email', rules: [rules.email] },
  { name: 'date_of_birth', label: 'Date of birth', type: 'date', rules: [(v) => (!v || (Date.now() - new Date(v)) / 31557600000 >= 18 ? null : 'Driver must be at least 18 years old')] },
  { name: 'gender', label: 'Gender', type: 'select', options: ['male', 'female', 'other'] },
  { name: 'city_id', label: 'City', type: 'select', required: true, options: cityOpts },
  { name: 'branch_id', label: 'Branch', type: 'select', options: branchOpts },
  { name: 'address_line', label: 'Address', full: true }, { name: 'locality', label: 'Locality' }, { name: 'pincode', label: 'PIN code', rules: [rules.pincode] },
  { type: 'section', label: 'Identity (masked — full numbers are never stored)' },
  { name: 'aadhaar_last4', label: 'Aadhaar — last 4 digits', rules: [rules.last4], maxLength: 4 },
  { name: 'pan_masked', label: 'PAN (masked)', placeholder: 'ABCDE****F', upper: true, rules: [rules.panMasked] },
  { name: 'licence_masked', label: 'Driving licence (masked)', placeholder: 'UP32********1234', upper: true, rules: [rules.maxLen(30)] },
  { name: 'licence_expiry', label: 'Licence expiry', type: 'date' },
  { name: 'police_verification_status', label: 'Police verification', type: 'select', noBlank: true, options: ['not_started', 'submitted', 'verified', 'failed'], value: d.police_verification_status ?? 'not_started' },
  { type: 'section', label: 'Emergency contact' },
  { name: 'emergency_contact_name', label: 'Contact name' }, { name: 'emergency_contact_phone', label: 'Contact phone', type: 'tel', rules: [rules.phone] },
];
const clean = (v) => ({ ...v, phone: normalisePhone(v.phone), emergency_contact_phone: v.emergency_contact_phone ? normalisePhone(v.emergency_contact_phone) : null });

async function editDriver(d, done) {
  const [cityList, branchList] = await Promise.all([cities(), branches()]);
  const ok = await formModal({ title: d ? `Edit ${d.full_name}` : 'Register driver', subtitle: d ? d.driver_code : 'The driver starts as “pending” and cannot take rides until documents are approved.', size: 'lg', values: d ?? {}, fields: driverFields(asOptions(cityList), asOptions(branchList), d ?? {}),
    onSubmit: (v) => (d ? update('drivers', d.id, clean(v)) : insert('drivers', clean(v))) });
  if (ok) { toast('success', d ? 'Driver updated.' : 'Driver registered. Upload documents to continue verification.'); done?.(ok); }
}
async function changeStatus(d, status, done) {
  const label = { approved: 'Approve driver', rejected: 'Reject application', under_review: 'Mark as under review', suspended: 'Suspend driver', deactivated: 'Deactivate driver', blacklisted: 'Blacklist driver' }[status];
  let reason = null;
  if (['approved', 'under_review'].includes(status)) { if (!(await confirmDialog({ title: `${label}?`, text: status === 'approved' ? `${d.full_name} will be able to go online and accept rides. All required documents must be approved and unexpired.` : `${d.full_name}'s application will be marked as under review.`, confirmText: label }))) return; }
  else { reason = await promptReason({ title: `${label}?`, text: status === 'blacklisted' ? 'Blacklisting is permanent until reversed by a senior administrator. The driver is taken offline immediately.' : 'The driver is taken offline immediately and cannot accept rides.', confirmText: label, danger: true }); if (!reason) return; }
  await rpc('set_driver_status', { p_driver_id: d.id, p_status: status, p_reason: reason });
  toast('success', `Driver is now ${titleCase(status)}.`); done?.();
}
async function uploadDoc(d, done) {
  const ok = await formModal({ title: 'Upload document', subtitle: `${d.full_name} · stored privately; opened only through expiring links`,
    fields: [{ name: 'doc_type', label: 'Document type', type: 'select', required: true, options: [...DRIVER_DOCS, 'other'].map((t) => ({ value: t, label: docLabel(t) })) },
      { name: 'file', label: 'File (JPG, PNG, WebP or PDF, max 10 MB)', type: 'file', required: true, rules: [(f) => validateFile(f)] },
      { name: 'doc_number_masked', label: 'Document number (masked)', placeholder: 'e.g. ********1234', rules: [rules.maxLen(30)], help: 'Never type a full Aadhaar or PAN number here.' },
      { name: 'expiry_date', label: 'Expiry date (if any)', type: 'date' }, { name: 'notes', label: 'Notes', type: 'textarea' }],
    onSubmit: async (v) => { const path = await uploadFile('driver-documents', d.id, v.file); return insert('driver_documents', { driver_id: d.id, doc_type: v.doc_type, storage_path: path, doc_number_masked: v.doc_number_masked, expiry_date: v.expiry_date, notes: v.notes }); } });
  if (ok) { toast('success', 'Document uploaded. It is pending review.'); done?.(); }
}
async function reviewDoc(doc, approve, done) {
  let reason = null;
  if (!approve) { reason = await promptReason({ title: `Reject ${docLabel(doc.doc_type)}?`, text: 'The driver will be asked to upload it again.', confirmText: 'Reject document', danger: true, placeholder: 'e.g. Photo is blurred' }); if (!reason) return; }
  else if (!(await confirmDialog({ title: `Approve ${docLabel(doc.doc_type)}?`, text: 'Confirm that you opened the file and checked the name, number and expiry date.', confirmText: 'Approve' }))) return;
  await rpc('review_driver_document', { p_document_id: doc.id, p_approve: approve, p_reason: reason }); toast('success', approve ? 'Document approved.' : 'Document rejected.'); done?.();
}

export async function openDriver(id, onChange) {
  let changed = false;
  const m = openModal({ title: 'Driver', drawer: true, body: loadingState(), footer: '', onClose: () => { if (changed) onChange?.(); } });
  const done = () => { changed = true; render(); };
  async function render() {
    try {
      const d = await getOne('drivers', id);
      if (!d) { m.body.innerHTML = emptyState({ icon: 'fa-lock', title: 'Driver not found', text: 'The record does not exist or is outside your city scope.' }); return; }
      const [cityList, branchList] = await Promise.all([cities(), branches()]);
      m.setTitle(d.full_name); m.root.querySelector('.modal-head small')?.remove();
      m.root.querySelector('.modal-head h2').insertAdjacentHTML('afterend', `<small><span class="mono">${esc(d.driver_code)}</span> ${badge(d.status)} ${d.status === 'approved' ? badge(d.availability) : ''} ★ ${esc(Number(d.rating_avg).toFixed(1))} (${esc(d.rating_count)})</small>`);
      m.body.innerHTML = '<div data-tabs></div>';
      tabs(m.body.querySelector('[data-tabs]'), [
        { id: 'profile', label: 'Profile', render: (p) => { p.innerHTML = `${d.status_reason && d.status !== 'approved' ? notice(d.status === 'blacklisted' ? 'danger' : 'warning', `${titleCase(d.status)}:`, ` ${d.status_reason}`) : ''}<div class="grid grid-2"><div>${dl([['Mobile', esc(d.phone)], ['E-mail', esc(d.email ?? '—')], ['Date of birth', esc(date(d.date_of_birth))], ['Gender', esc(titleCase(d.gender ?? '—'))], ['City', esc(nameMap(cityList)[d.city_id] ?? '—')], ['Branch', esc(nameMap(branchList)[d.branch_id] ?? '—')], ['Address', esc([d.address_line, d.locality, d.pincode].filter(Boolean).join(', ') || '—')]])}</div>
          <div>${dl([['Aadhaar', d.aadhaar_last4 ? `<span class="mono">XXXX XXXX ${esc(d.aadhaar_last4)}</span>` : '—'], ['PAN', `<span class="mono">${esc(d.pan_masked ?? '—')}</span>`], ['Driving licence', `<span class="mono">${esc(d.licence_masked ?? '—')}</span>`], ['Licence expiry', expiryBadge(d.licence_expiry)], ['Police verification', badge(d.police_verification_status)],
            ['Emergency contact', d.emergency_contact_name ? `${esc(d.emergency_contact_name)} · ${esc(d.emergency_contact_phone ?? '')}` : '—'], ['Location consent', d.location_consent_at ? esc(dateTime(d.location_consent_at)) : '<span class="badge warning">Not given yet</span>'], ['Registered', esc(dateTime(d.created_at))], ['Approved', esc(dateTime(d.approved_at))]])}</div></div>`; } },
        { id: 'documents', label: 'Documents', perm: 'drivers.documents', render: (p) => docsTab(p, d, done) },
        { id: 'vehicle', label: 'Vehicle', perm: 'vehicles.view', render: (p) => vehicleTab(p, d, done) },
        { id: 'earnings', label: 'Earnings & wallet', render: (p) => earningsTab(p, d, done) },
        { id: 'trips', label: 'Trips', perm: 'rides.view', render: (p) => tripsTab(p, d) },
        { id: 'performance', label: 'Ratings & attendance', render: (p) => perfTab(p, d) },
        { id: 'notes', label: 'Notes', perm: 'drivers.notes', render: (p) => notesTab(p, d) },
        { id: 'history', label: 'Verification history', render: (p) => historyTab(p, d) },
      ]);
      const A = [];
      if (can('drivers.create')) A.push(['edit', '', 'fa-pen', 'Edit']);
      if (can('drivers.verify')) { if (d.status === 'pending') A.push(['under_review', '', 'fa-magnifying-glass', 'Start review']); if (['pending', 'under_review', 'rejected'].includes(d.status)) A.push(['approved', 'btn-success', 'fa-circle-check', 'Approve']); if (['pending', 'under_review'].includes(d.status)) A.push(['rejected', 'btn-danger', 'fa-circle-xmark', 'Reject']); }
      if (can('drivers.manage')) { if (d.status === 'approved') A.push(['suspended', '', 'fa-pause', 'Suspend'], ['deactivated', '', 'fa-user-slash', 'Deactivate']); if (['suspended', 'deactivated'].includes(d.status) && can('drivers.verify')) A.push(['approved', 'btn-success', 'fa-rotate-left', 'Reactivate']); }
      if (can('drivers.blacklist')) { if (d.status !== 'blacklisted') A.push(['blacklisted', 'btn-danger', 'fa-ban', 'Blacklist']); else if (can('drivers.verify')) A.push(['under_review', '', 'fa-rotate-left', 'Remove from blacklist (re-review)']); }
      m.foot.innerHTML = A.map((a) => `<button class="btn ${a[1]}" data-do="${a[0]}"><i class="fa-solid ${a[2]}"></i> ${a[3]}</button>`).join('') || '<span class="muted small">View only.</span>';
      m.foot.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => (b.dataset.do === 'edit' ? editDriver(d, done) : changeStatus(d, b.dataset.do, done)).catch(showError); });
    } catch (e) { m.body.innerHTML = errorState(e); }
  }
  await render();
}
async function docsTab(p, d, done) {
  const docs = await select('driver_documents', '*', (q) => q.eq('driver_id', d.id).order('created_at', { ascending: false }));
  const latest = (t) => docs.find((x) => x.doc_type === t);
  const missing = DRIVER_DOCS.filter((t) => { const x = latest(t); return !x || x.status !== 'approved' || (x.expiry_date && new Date(x.expiry_date) < new Date()); });
  p.innerHTML = `${missing.length ? notice('warning', 'Not yet verified:', ` ${missing.map(docLabel).join(', ')}. Which documents are mandatory is set in Settings → Drivers.`) : notice('success', 'All standard documents are approved and unexpired.')}
    <div class="row" style="margin-bottom:12px">${can('drivers.create') ? '<button class="btn btn-primary" data-up><i class="fa-solid fa-upload"></i> Upload document</button>' : ''}</div>
    ${simpleTable([{ label: 'Document', render: (x) => `<div class="cell-main">${esc(docLabel(x.doc_type))}</div><div class="cell-sub mono">${esc(x.doc_number_masked ?? '')}</div>` }, { label: 'Status', render: (x) => badge(x.status) + (x.rejection_reason ? `<div class="cell-sub">${esc(x.rejection_reason)}</div>` : '') }, { label: 'Expiry', render: (x) => expiryBadge(x.expiry_date) },
      { label: 'Uploaded', render: (x) => esc(dateTime(x.created_at)) }, { label: 'Reviewed', render: (x) => esc(dateTime(x.reviewed_at)) },
      { label: '', render: (x) => `<div class="row-actions"><button class="btn btn-sm" data-view="${esc(x.id)}"><i class="fa-solid fa-eye"></i> View</button>${x.status === 'pending' && can('drivers.verify') ? `<button class="btn btn-sm btn-success" data-ok="${esc(x.id)}">Approve</button><button class="btn btn-sm btn-danger" data-no="${esc(x.id)}">Reject</button>` : ''}</div>` }], docs, { icon: 'fa-file-circle-plus', title: 'No documents uploaded', text: 'Upload Aadhaar, PAN, driving licence, photograph and police verification to start verification.' })}`;
  p.querySelector('[data-up]')?.addEventListener('click', () => uploadDoc(d, done).catch(showError));
  const by = (id) => docs.find((x) => x.id === id);
  p.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => { const x = by(b.dataset.view); viewDocument('driver-documents', x.storage_path, `${docLabel(x.doc_type)} — ${d.full_name}`); }; });
  p.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = () => reviewDoc(by(b.dataset.ok), true, done).catch(showError); });
  p.querySelectorAll('[data-no]').forEach((b) => { b.onclick = () => reviewDoc(by(b.dataset.no), false, done).catch(showError); });
}
async function vehicleTab(p, d, done) {
  const rows = await select('vehicle_assignments', '*', (q) => q.eq('driver_id', d.id).order('assigned_at', { ascending: false }).limit(50));
  await attach(rows, 'vehicle_id', 'vehicles', 'id,registration_number,manufacturer,model,status,vehicle_code', 'vehicle');
  const cur = rows.find((r) => r.is_active);
  p.innerHTML = `${cur ? notice('info', 'Current vehicle:', ` ${cur.vehicle?.registration_number ?? ''} — ${cur.vehicle?.manufacturer ?? ''} ${cur.vehicle?.model ?? ''}`) : notice('warning', 'No vehicle assigned.', ' This driver cannot go online until an active vehicle is assigned.')}
    <div class="row" style="margin-bottom:12px">${can('vehicles.assign') ? `<button class="btn btn-primary" data-assign><i class="fa-solid fa-car"></i> ${cur ? 'Change vehicle' : 'Assign vehicle'}</button>${cur ? '<button class="btn" data-unassign>Unassign</button>' : ''}` : ''}</div>
    ${simpleTable([{ label: 'Vehicle', render: (r) => (r.vehicle ? `<a href="#/vehicles?id=${esc(r.vehicle.id)}">${esc(r.vehicle.registration_number)}</a>` : '—') }, { label: 'Assigned', render: (r) => esc(dateTime(r.assigned_at)) }, { label: 'Unassigned', render: (r) => (r.is_active ? '<span class="badge success">Current</span>' : esc(dateTime(r.unassigned_at))) }, { label: 'Reason', render: (r) => esc(r.unassigned_reason ?? '—') }], rows, { icon: 'fa-car', title: 'No assignment history' })}`;
  p.querySelector('[data-assign]')?.addEventListener('click', async () => { try { const v = await pickVehicle({ filters: { status: ['active', 'pending', 'maintenance'] } }); if (!v) return; await rpc('assign_vehicle', { p_vehicle_id: v.id, p_driver_id: d.id, p_reason: null }); toast('success', `${v.registration_number} assigned.`); done(); } catch (e) { showError(e); } });
  p.querySelector('[data-unassign]')?.addEventListener('click', async () => { try { const reason = await promptReason({ title: 'Unassign vehicle?', text: 'The driver will not be able to go online without a vehicle.', confirmText: 'Unassign' }); if (!reason) return; await rpc('assign_vehicle', { p_vehicle_id: cur.vehicle_id, p_driver_id: null, p_reason: reason }); toast('success', 'Vehicle unassigned.'); done(); } catch (e) { showError(e); } });
}
async function earningsTab(p, d, done) {
  const [wallets, tx, payouts, incentives] = await Promise.all([select('driver_wallets', 'balance_paise', (q) => q.eq('driver_id', d.id)).catch(() => null), can('finance.view') ? select('wallet_transactions', '*', (q) => q.eq('driver_id', d.id).order('created_at', { ascending: false }).limit(50)) : null,
    can('finance.view') ? select('driver_payouts', '*', (q) => q.eq('driver_id', d.id).order('created_at', { ascending: false }).limit(20)) : null, select('driver_incentives', '*', (q) => q.eq('driver_id', d.id).order('created_at', { ascending: false }).limit(30))]);
  const bal = wallets?.[0]?.balance_paise;
  p.innerHTML = `<div class="stats">${`<div class="stat"><div class="stat-ico ${Number(bal) < 0 ? 'danger' : 'success'}"><i class="fa-solid fa-wallet"></i></div><div><div class="stat-label">Wallet balance</div><div class="stat-value">${bal === undefined ? '—' : money(bal)}</div><div class="stat-hint">${Number(bal) < 0 ? 'Driver owes the company (cash commission)' : 'Payable to the driver'}</div></div></div>`}</div>
    <div class="row" style="margin-bottom:12px">${can('drivers.incentives') ? '<button class="btn" data-inc><i class="fa-solid fa-gift"></i> Add bonus / incentive</button>' : ''}${can('finance.payouts') ? `<a class="btn" href="#/finance?tab=payouts">Payouts</a>` : ''}</div>
    <h4 style="margin:6px 0 10px">Bonuses and incentives</h4>${simpleTable([{ label: 'Type', render: (x) => esc(titleCase(x.incentive_type)) }, { label: 'Amount', cls: 'num', render: (x) => money(x.amount_paise) }, { label: 'Reason', render: (x) => esc(x.reason) }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Created', render: (x) => esc(dateTime(x.created_at)) },
      { label: '', render: (x) => (x.status === 'pending' && can('finance.payouts.approve') ? `<button class="btn btn-sm" data-credit="${esc(x.id)}">Credit to wallet</button>` : '') }], incentives, { icon: 'fa-gift', title: 'No incentives' })}
    ${tx ? `<h4 style="margin:16px 0 10px">Wallet ledger (latest 50)</h4>${simpleTable([{ label: 'When', render: (x) => esc(dateTime(x.created_at)) }, { label: 'Entry', render: (x) => `${esc(titleCase(x.reason))}<div class="cell-sub mono">${esc(x.txn_code)}</div>` }, { label: 'Amount', cls: 'num', render: (x) => `<span style="color:var(--${x.direction === 'credit' ? 'success' : 'danger'})">${x.direction === 'credit' ? '+' : '−'} ${money(x.amount_paise)}</span>` }, { label: 'Balance after', cls: 'num', render: (x) => money(x.balance_after_paise) }], tx, { icon: 'fa-receipt', title: 'No wallet entries yet' })}
    <h4 style="margin:16px 0 10px">Payouts</h4>${simpleTable([{ label: 'Payout', render: (x) => `<span class="mono">${esc(x.txn_code)}</span>` }, { label: 'Amount', cls: 'num', render: (x) => money(x.amount_paise) }, { label: 'Method', render: (x) => esc(titleCase(x.method)) }, { label: 'Status', render: (x) => badge(x.status) }, { label: 'Paid', render: (x) => esc(dateTime(x.paid_at)) }], payouts, { icon: 'fa-money-bill-transfer', title: 'No payouts' })}` : '<p class="muted" style="margin-top:12px">The wallet ledger and payouts need the finance.view permission.</p>'}`;
  p.querySelector('[data-inc]')?.addEventListener('click', async () => { const ok = await formModal({ title: 'Add bonus / incentive', subtitle: `${d.full_name} · created as pending; Finance credits it to the wallet`,
    fields: [{ name: 'incentive_type', label: 'Type', type: 'select', required: true, noBlank: true, options: ['bonus', 'incentive', 'referral', 'penalty_reversal'] }, { name: 'amount_paise', label: 'Amount (₹)', type: 'money', required: true, rules: [rules.min(1)] }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, rules: [rules.minLen(5)] }],
    onSubmit: (v) => insert('driver_incentives', { driver_id: d.id, ...v }) }); if (ok) { toast('success', 'Incentive recorded as pending.'); done(); } });
  p.querySelectorAll('[data-credit]').forEach((b) => { b.onclick = async () => { try { if (!(await confirmDialog({ title: 'Credit to wallet?', text: 'The amount is added to the driver wallet once. This cannot be undone.', confirmText: 'Credit' }))) return; await rpc('credit_incentive', { p_incentive_id: b.dataset.credit }); toast('success', 'Credited to the driver wallet.'); done(); } catch (e) { showError(e); } }; });
}
function tripsTab(p, d) {
  dataTable(p, { search: false, filters: [{ name: 'status', label: 'All statuses', options: ['RIDE_STARTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CANCELLED', 'DISPUTED'].map((s) => ({ value: s, label: titleCase(s) })) }],
    columns: [{ label: 'Booking', render: (b) => rideLink(b) }, { label: 'Date', render: (b) => esc(dateTime(b.created_at)) }, { label: 'Route', render: (b) => `<span class="cell-sub">${esc(b.pickup_address)} → ${esc(b.drop_address)}</span>` }, { label: 'Status', render: (b) => badge(b.status) }, { label: 'Fare', cls: 'num', render: (b) => money(b.total_fare_paise ?? b.estimated_fare_paise) }, { label: 'Driver earning', cls: 'num', render: (b) => money(b.driver_earning_paise) }],
    load: (s) => list('bookings', { select: 'id,booking_code,created_at,pickup_address,drop_address,status,total_fare_paise,estimated_fare_paise,driver_earning_paise', filters: { driver_id: d.id, status: s.filters.status }, page: s.page, pageSize: 10 }), pageSize: 10, empty: { icon: 'fa-route', title: 'No trips yet' } });
}
async function perfTab(p, d) {
  const r = rangeFor('month');
  const [reviews, att, perf] = await Promise.all([select('reviews', '*', (q) => q.eq('driver_id', d.id).eq('reviewer_type', 'customer').order('created_at', { ascending: false }).limit(20)).catch(() => []), select('driver_attendance', '*', (q) => q.eq('driver_id', d.id).order('work_date', { ascending: false }).limit(31)),
    can('analytics.view') ? rpc('driver_performance', { p_from: r.from, p_to: r.to, p_limit: 500 }).catch(() => null) : null]);
  const me = perf?.drivers?.find((x) => x.driver_id === d.id);
  p.innerHTML = `${me ? `<div class="stats"><div class="stat"><div><div class="stat-label">Performance score (30 d)</div><div class="stat-value">${esc(me.score)}</div><div class="stat-hint">${esc(perf.formula)}</div></div></div><div class="stat"><div><div class="stat-label">Acceptance</div><div class="stat-value">${pct(me.acceptance_pct)}</div><div class="stat-hint">${esc(me.accepted)} of ${esc(me.offered)} offers</div></div></div><div class="stat"><div><div class="stat-label">Completed</div><div class="stat-value">${esc(me.completed)}</div><div class="stat-hint">${esc(me.complaints)} complaint(s) · ${esc(me.overspeed_alerts)} overspeed</div></div></div></div>` : ''}
    <div class="grid grid-2"><div><h4 style="margin-bottom:10px">Attendance (last 31 days online)</h4>${simpleTable([{ label: 'Date', render: (a) => esc(date(a.work_date)) }, { label: 'First online', render: (a) => esc(dateTime(a.first_online_at)) }, { label: 'Hours online', cls: 'num', render: (a) => (a.online_seconds / 3600).toFixed(1) }, { label: 'Rides', cls: 'num', render: (a) => esc(a.rides_completed) }], att, { icon: 'fa-calendar', title: 'No attendance recorded', text: 'Attendance is recorded when the driver goes online in the Driver App.' })}</div>
    <div><h4 style="margin-bottom:10px">Customer reviews</h4>${simpleTable([{ label: 'Rating', render: (x) => `★ ${esc(x.rating)}` }, { label: 'Comment', render: (x) => esc(x.comment ?? '—') }, { label: 'Date', render: (x) => esc(date(x.created_at)) }], reviews, { icon: 'fa-star', title: 'No reviews yet' })}</div></div>`;
}
async function notesTab(p, d) {
  const render = async () => {
    const notes = await select('driver_notes', '*', (q) => q.eq('driver_id', d.id).order('created_at', { ascending: false }).limit(100)); await attach(notes, 'staff_id', 'staff_accounts', 'id,full_name', 'staff');
    p.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn btn-primary" data-add><i class="fa-solid fa-plus"></i> Add note</button></div>${timeline(notes.map((n) => ({ title: `${esc(titleCase(n.kind))} ${n.kind === 'disciplinary' ? badge(n.severity, n.severity === 'high' ? 'danger' : 'warning') : ''}`, text: esc(n.body), time: `${n.staff?.full_name ?? 'Staff'} · ${dateTime(n.created_at)}`, tone: n.kind === 'disciplinary' ? 'danger' : '' })), 'No notes. Disciplinary records, recovery notes and support notes appear here.')}`;
    p.querySelector('[data-add]').onclick = async () => { const ok = await formModal({ title: 'Add note', subtitle: 'Notes cannot be edited or deleted after saving.', fields: [{ name: 'kind', label: 'Kind', type: 'select', required: true, noBlank: true, options: ['note', 'disciplinary', 'recovery', 'support'] }, { name: 'severity', label: 'Severity', type: 'select', noBlank: true, options: ['low', 'medium', 'high'], showIf: (v) => v.kind === 'disciplinary' }, { name: 'body', label: 'Note', type: 'textarea', required: true, rules: [rules.minLen(5)] }],
      onSubmit: (v) => insert('driver_notes', { driver_id: d.id, kind: v.kind, severity: v.kind === 'disciplinary' ? v.severity : null, body: v.body }) }); if (ok) render(); };
  };
  await render();
}
async function historyTab(p, d) {
  const rows = await select('driver_verifications', '*', (q) => q.eq('driver_id', d.id).order('created_at', { ascending: false }).limit(100)); await attach(rows, 'staff_id', 'staff_accounts', 'id,full_name', 'staff');
  p.innerHTML = timeline(rows.map((h) => ({ title: `${esc(titleCase(h.action))}${h.to_status ? ` → ${esc(titleCase(h.to_status))}` : ''}`, text: `${esc(h.staff?.full_name ?? 'Staff')}${h.reason ? ` — ${esc(h.reason)}` : ''}`, time: dateTime(h.created_at), tone: /reject|blacklist|suspend/.test(`${h.action}${h.to_status}`) ? 'danger' : /approv/.test(`${h.action}${h.to_status}`) ? 'success' : '' })), 'No verification activity yet.');
}

export async function importCsv(entity, columnsHelp, sample, done) {
  const ok = await formModal({ title: `Import ${entity} from CSV`, subtitle: 'Up to 2,000 rows. Each row is validated by the server; bad rows are reported and skipped.', submitText: 'Import',
    intro: `<p class="muted small">Required columns: <span class="mono">${esc(columnsHelp)}</span>. <a href="#" data-sample>Download a sample file</a></p>`,
    fields: [{ name: 'file', label: 'CSV file', type: 'file', accept: '.csv,text/csv', required: true }],
    onRender: (form) => { form.parentElement.querySelector('[data-sample]').onclick = (e) => { e.preventDefault(); download(`${entity}-sample.csv`, sample); }; },
    onSubmit: async (v) => { const rows = parseCsv(await v.file.text()); if (!rows.length) throw new Error('The file has no data rows.'); if (rows.length > 2000) throw new Error('The file has more than 2,000 rows. Split it and import in parts.'); return rpc('import_rows', { p_entity: entity, p_rows: rows, p_file_name: v.file.name }); } });
  if (!ok) return;
  openModal({ title: 'Import result', body: `${notice(ok.failed ? 'warning' : 'success', `${ok.imported} of ${ok.total} row(s) imported.`, ok.failed ? ` ${ok.failed} row(s) were skipped.` : '')}${ok.errors?.length ? simpleTable([{ label: 'Row', render: (e) => esc(e.row) }, { label: 'Problem', render: (e) => esc(e.error) }], ok.errors) : ''}`, footer: null });
  done?.();
}

export async function init(root, { params, setParams }) {
  const [cityList] = await Promise.all([cities()]);
  const actions = root.querySelector('#drivers-actions');
  actions.innerHTML = `${can('settings.import') ? '<button class="btn" id="drv-import"><i class="fa-solid fa-file-import"></i> Import CSV</button>' : ''}${can('drivers.create') ? '<button class="btn btn-primary" id="drv-new"><i class="fa-solid fa-plus"></i> Register driver</button>' : ''}`;
  let tb;
  const reload = () => { tb.show(tb.current()); stats(); };
  async function stats() {
    try {
      const c = (f) => countOf('drivers', f);
      const [total, pending, approved, online, onRide, susp] = await Promise.all([c(), c((q) => q.in('status', ['pending', 'under_review'])), c((q) => q.eq('status', 'approved')), c((q) => q.eq('status', 'approved').eq('availability', 'online')), c((q) => q.eq('availability', 'on_ride')), c((q) => q.in('status', ['suspended', 'blacklisted']))]);
      statCards(root.querySelector('#drivers-stats'), [{ label: 'Total drivers', value: number(total), icon: 'fa-id-card' }, { label: 'Awaiting verification', value: number(pending), icon: 'fa-user-clock', tone: 'warning' }, { label: 'Approved', value: number(approved), icon: 'fa-user-check', tone: 'success' }, { label: 'Online now', value: number(online), icon: 'fa-signal', tone: 'success' }, { label: 'On a ride', value: number(onRide), icon: 'fa-route', tone: 'info' }, { label: 'Suspended / blacklisted', value: number(susp), icon: 'fa-ban', tone: 'danger' }]);
      tb?.setCount('applications', pending, true);
    } catch { /* stats are secondary */ }
  }
  const table = (pane, fixed, withStatus) => { const t = dataTable(pane, {
    search: { placeholder: 'Name, driver ID, mobile…' }, filters: [...(withStatus ? [{ name: 'status', label: 'All statuses', options: STATUSES }] : []), { name: 'city_id', label: 'All cities', options: asOptions(cityList) }, { name: 'availability', label: 'Any availability', options: ['online', 'offline', 'on_ride'] }],
    columns: [{ label: 'Driver', sort: 'full_name', render: (d) => `<div class="cell-main">${esc(d.full_name)}</div><div class="cell-sub mono">${esc(d.driver_code)}</div>` }, { label: 'Mobile', render: (d) => esc(d.phone) }, { label: 'City', render: (d) => esc(nameMap(cityList)[d.city_id] ?? '—') },
      { label: 'Status', render: (d) => badge(d.status) }, { label: 'Availability', render: (d) => (d.status === 'approved' ? badge(d.availability) : '<span class="muted">—</span>') }, { label: 'Rating', sort: 'rating_avg', render: (d) => (d.rating_count ? `★ ${esc(Number(d.rating_avg).toFixed(1))} <span class="cell-sub">(${esc(d.rating_count)})</span>` : '<span class="muted">New</span>') },
      { label: 'Licence expiry', sort: 'licence_expiry', render: (d) => expiryBadge(d.licence_expiry) }, { label: 'Registered', sort: 'created_at', render: (d) => esc(date(d.created_at)) }],
    load: (s) => list('drivers', { search: s.search, searchColumns: ['full_name', 'driver_code', 'phone', 'email'], filters: { ...s.filters, ...fixed }, order: s.sort ?? 'created_at', ascending: s.sort ? s.ascending : false, page: s.page, pageSize: s.pageSize }),
    onRowClick: (d) => openDriver(d.id, () => { t.reload({ silent: true }); stats(); }),
    export: { perm: 'analytics.export', filename: 'drivers', loadAll: (s) => listAll('drivers', { search: s.search, searchColumns: ['full_name', 'driver_code', 'phone'], filters: { ...s.filters, ...fixed } }),
      columns: [{ label: 'Driver ID', key: 'driver_code' }, { label: 'Name', key: 'full_name' }, { label: 'Mobile', key: 'phone' }, { label: 'City', value: (d) => nameMap(cityList)[d.city_id] ?? '' }, { label: 'Status', key: 'status' }, { label: 'Availability', key: 'availability' }, { label: 'Rating', key: 'rating_avg' }, { label: 'Licence expiry', key: 'licence_expiry' }, { label: 'Registered', key: 'created_at' }] },
    empty: { icon: 'fa-id-card', title: 'No drivers yet', text: 'Register the first driver, or drivers can apply from the Driver App.' } }); };
  tb = tabs(root.querySelector('#drivers-tabs'), [
    { id: 'all', label: 'All drivers', icon: 'fa-users', render: (p) => table(p, {}, true) },
    { id: 'applications', label: 'Applications', icon: 'fa-user-clock', render: (p) => table(p, { status: ['pending', 'under_review'] }, false) },
    { id: 'approved', label: 'Approved', icon: 'fa-user-check', render: (p) => table(p, { status: 'approved' }, false) },
    { id: 'restricted', label: 'Suspended / blacklisted', icon: 'fa-ban', render: (p) => table(p, { status: ['suspended', 'deactivated', 'blacklisted', 'rejected'] }, false) },
    { id: 'expiring', label: 'Expiring documents', icon: 'fa-calendar-xmark', perm: 'drivers.documents', render: (p) => expiringPane(p) },
  ], { initial: params.tab, onChange: (id) => setParams({ tab: id, id: null }) });
  root.querySelector('#drv-new')?.addEventListener('click', () => editDriver(null, (d) => { reload(); if (d?.id) openDriver(d.id, reload); }).catch(showError));
  root.querySelector('#drv-import')?.addEventListener('click', () => importCsv('drivers', 'full_name, phone, email, city', 'full_name,phone,email,city\nRamesh Kumar,9876543210,ramesh@example.com,Lucknow\n', reload).catch(showError));
  stats(); if (params.id) openDriver(params.id, reload);
  return () => tb.destroy();
}
function expiringPane(pane) {
  dataTable(pane, { search: false, filters: [{ name: 'window', label: 'Next 30 days', options: [{ value: '0', label: 'Already expired' }, { value: '60', label: 'Next 60 days' }, { value: '90', label: 'Next 90 days' }] }],
    columns: [{ label: 'Driver', render: (x) => (x.driver ? `<a href="#/drivers?id=${esc(x.driver.id)}">${esc(x.driver.full_name)}</a> <span class="cell-sub mono">${esc(x.driver.driver_code)}</span>` : '—') }, { label: 'Document', render: (x) => esc(docLabel(x.doc_type)) }, { label: 'Expiry', render: (x) => expiryBadge(x.expiry_date) }, { label: 'Status', render: (x) => badge(x.status) }],
    load: async (s) => { const days = s.filters.window === '' ? 30 : Number(s.filters.window); const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      const r = await list('driver_documents', { order: 'expiry_date', ascending: true, page: s.page, pageSize: s.pageSize, apply: (q) => q.not('expiry_date', 'is', null).lte('expiry_date', until).in('status', ['approved', 'expired']) }); await attach(r.rows, 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver'); return r; },
    empty: { icon: 'fa-circle-check', title: 'No documents expiring in this window' } });
}
