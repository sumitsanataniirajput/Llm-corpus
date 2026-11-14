// Module 3 — Vehicle management.
import { rpc } from '../supabase-client.js';
import { list, listAll, select, getOne, insert, update, remove, cities, branches, categories, asOptions, nameMap, uploadFile, countOf } from '../api.js';
import { dataTable, tabs, badge, openModal, formModal, promptReason, confirmDialog, toast, showError, dl, simpleTable, loadingState, errorState, emptyState, notice, statCards } from '../components.js';
import { esc, money, dateTime, date, titleCase, number, isoDate } from '../utilities.js';
import { can } from '../permissions.js';
import { rules, normalisePhone, validateFile } from '../validation.js';
import { attach, viewDocument, docLabel, expiryBadge, VEHICLE_DOCS, pickDriver, rideLink } from './shared.js';
import { importCsv } from './drivers.js';

const STATUSES = ['pending', 'active', 'maintenance', 'suspended', 'retired'];
const year = new Date().getFullYear();
const fields = (cats, cityOpts, branchOpts, driverOpts = []) => [
  { name: 'registration_number', label: 'Registration number', required: true, upper: true, placeholder: 'UP32AB1234', rules: [rules.vehicleReg] },
  { name: 'category_id', label: 'Category', type: 'select', required: true, options: asOptions(cats) },
  { name: 'manufacturer', label: 'Manufacturer', required: true, placeholder: 'Maruti Suzuki' }, { name: 'model', label: 'Model', required: true, placeholder: 'Dzire' },
  { name: 'manufacture_year', label: 'Year', type: 'number', rules: [rules.integer, rules.min(1990), rules.max(year + 1)] }, { name: 'color', label: 'Colour' },
  { name: 'fuel_type', label: 'Fuel', type: 'select', options: ['petrol', 'diesel', 'cng', 'electric', 'hybrid', 'lpg'] }, { name: 'seating_capacity', label: 'Seats (excluding driver)', type: 'number', rules: [rules.integer, rules.min(1), rules.max(60)] },
  { name: 'city_id', label: 'City', type: 'select', required: true, options: cityOpts }, { name: 'branch_id', label: 'Branch', type: 'select', options: branchOpts },
  { type: 'section', label: 'Ownership' },
  { name: 'ownership_type', label: 'Owned by', type: 'select', required: true, noBlank: true, options: [{ value: 'company', label: 'Company' }, { value: 'driver_owned', label: 'Driver / partner' }] },
  { name: 'owner_name', label: 'Owner name', required: true }, { name: 'owner_phone', label: 'Owner phone', type: 'tel', rules: [rules.phone] },
  { name: 'odometer_km', label: 'Odometer (km)', type: 'number', rules: [rules.min(0)] }, { name: 'gps_device_id', label: 'GPS device ID (optional)' },
];
const clean = (v) => ({ ...v, registration_number: v.registration_number.replace(/[\s-]/g, ''), owner_phone: v.owner_phone ? normalisePhone(v.owner_phone) : null, owner_driver_id: v.ownership_type === 'driver_owned' ? v.owner_driver_id : null });

async function editVehicle(v, done) {
  const [cats, cityList, branchList, owners] = await Promise.all([categories(), cities(), branches(), select('drivers', 'id,full_name,driver_code', (q) => q.not('status', 'in', '(rejected,blacklisted)').order('full_name').limit(1000)).catch(() => [])]);
  const ok = await formModal({ title: v ? `Edit ${v.registration_number}` : 'Add vehicle', subtitle: v ? v.vehicle_code : 'The vehicle starts as “pending” until its documents are approved and it is activated.', size: 'lg', values: v ?? { ownership_type: 'company', owner_name: 'Company' }, fields: fields(cats.filter((c) => c.is_active || c.id === v?.category_id), asOptions(cityList), asOptions(branchList), owners.map((d) => ({ value: d.id, label: `${d.full_name} (${d.driver_code})` }))),
    onSubmit: (x) => (v ? update('vehicles', v.id, clean(x)) : insert('vehicles', clean(x))) });
  if (ok) { toast('success', v ? 'Vehicle updated.' : 'Vehicle added. Upload RC, insurance and PUC to activate it.'); done?.(ok); }
}
async function changeStatus(v, status, done) {
  let reason = null;
  if (status === 'active') { if (!(await confirmDialog({ title: 'Activate vehicle?', text: `${v.registration_number} becomes available for rides. Required documents must be approved and unexpired.`, confirmText: 'Activate' }))) return; }
  else { reason = await promptReason({ title: `${titleCase(status === 'maintenance' ? 'send to maintenance' : status === 'retired' ? 'retire vehicle' : 'suspend vehicle')}?`, text: 'The vehicle cannot be used for new rides.', confirmText: 'Confirm', danger: status !== 'maintenance' }); if (!reason) return; }
  await rpc('set_vehicle_status', { p_vehicle_id: v.id, p_status: status, p_reason: reason }); toast('success', `Vehicle is now ${titleCase(status)}.`); done?.();
}

export async function openVehicle(id, onChange) {
  let changed = false;
  const m = openModal({ title: 'Vehicle', drawer: true, body: loadingState(), footer: '', onClose: () => { if (changed) onChange?.(); } });
  const done = () => { changed = true; render(); };
  async function render() {
    try {
      const v = await getOne('vehicles', id);
      if (!v) { m.body.innerHTML = emptyState({ icon: 'fa-lock', title: 'Vehicle not found', text: 'The record does not exist or is outside your city scope.' }); return; }
      const [cats, cityList] = await Promise.all([categories(), cities()]);
      m.setTitle(v.registration_number); m.root.querySelector('.modal-head small')?.remove();
      m.root.querySelector('.modal-head h2').insertAdjacentHTML('afterend', `<small><span class="mono">${esc(v.vehicle_code)}</span> ${badge(v.status)} ${esc(v.manufacturer ?? '')} ${esc(v.model ?? '')}</small>`);
      m.body.innerHTML = '<div data-tabs></div>';
      tabs(m.body.querySelector('[data-tabs]'), [
        { id: 'details', label: 'Details', render: (p) => { p.innerHTML = `${v.status_reason && v.status !== 'active' ? notice('warning', `${titleCase(v.status)}:`, ` ${v.status_reason}`) : ''}<div class="grid grid-2"><div>${dl([['Category', esc(nameMap(cats)[v.category_id] ?? '—')], ['Manufacturer / model', `${esc(v.manufacturer ?? '—')} ${esc(v.model ?? '')}`], ['Year', esc(v.manufacture_year ?? '—')], ['Colour', esc(v.color ?? '—')], ['Fuel', esc(titleCase(v.fuel_type ?? '—'))], ['Seats', esc(v.seating_capacity ?? '—')]])}</div>
          <div>${dl([['City', esc(nameMap(cityList)[v.city_id] ?? '—')], ['Ownership', esc(v.ownership_type === 'company' ? 'Company' : 'Driver / partner')], ['Owner', `${esc(v.owner_name ?? '—')} ${v.owner_phone ? `· ${esc(v.owner_phone)}` : ''}`], ['Odometer', v.odometer_km === null ? '—' : `${number(v.odometer_km)} km`], ['GPS device', esc(v.gps_device_id ?? '—')], ['Added', esc(dateTime(v.created_at))]])}</div></div>`; } },
        { id: 'documents', label: 'Documents', render: (p) => docsTab(p, v, done) },
        { id: 'driver', label: 'Driver', render: (p) => driverTab(p, v, done) },
        { id: 'maintenance', label: 'Service, fuel & accidents', render: (p) => maintTab(p, v) },
        { id: 'trips', label: 'Trips', perm: 'rides.view', render: (p) => dataTable(p, { search: false, pageSize: 10, columns: [{ label: 'Booking', render: (b) => rideLink(b) }, { label: 'Date', render: (b) => esc(dateTime(b.created_at)) }, { label: 'Status', render: (b) => badge(b.status) }, { label: 'Distance', cls: 'num', render: (b) => (b.final_billable_distance_km ?? b.booked_distance_km) + ' km' }, { label: 'Fare', cls: 'num', render: (b) => money(b.total_fare_paise ?? b.estimated_fare_paise) }],
          load: (s) => list('bookings', { select: 'id,booking_code,created_at,status,final_billable_distance_km,booked_distance_km,total_fare_paise,estimated_fare_paise', filters: { vehicle_id: v.id }, page: s.page, pageSize: 10 }), empty: { icon: 'fa-route', title: 'No trips yet' } }) },
      ]);
      const A = [];
      if (can('vehicles.edit')) A.push(['edit', '', 'fa-pen', 'Edit']);
      if (can('vehicles.manage')) { if (v.status !== 'active') A.push(['active', 'btn-success', 'fa-circle-check', v.status === 'pending' ? 'Activate' : 'Return to service']); if (v.status === 'active') A.push(['maintenance', '', 'fa-screwdriver-wrench', 'Send to maintenance'], ['suspended', '', 'fa-pause', 'Suspend']); if (v.status !== 'retired') A.push(['retired', 'btn-danger', 'fa-box-archive', 'Retire']); }
      m.foot.innerHTML = A.map((a) => `<button class="btn ${a[1]}" data-do="${a[0]}"><i class="fa-solid ${a[2]}"></i> ${a[3]}</button>`).join('') || '<span class="muted small">View only.</span>';
      m.foot.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => (b.dataset.do === 'edit' ? editVehicle(v, done) : changeStatus(v, b.dataset.do, done)).catch(showError); });
    } catch (e) { m.body.innerHTML = errorState(e); }
  }
  await render();
}
async function docsTab(p, v, done) {
  const docs = await select('vehicle_documents', '*', (q) => q.eq('vehicle_id', v.id).order('created_at', { ascending: false }));
  const missing = ['rc', 'insurance', 'pollution'].filter((t) => { const x = docs.find((d) => d.doc_type === t); return !x || x.status !== 'approved' || (x.expiry_date && new Date(x.expiry_date) < new Date()); });
  p.innerHTML = `${missing.length ? notice('warning', 'Not yet verified:', ` ${missing.map(docLabel).join(', ')}.`) : notice('success', 'RC, insurance and PUC are approved and unexpired.')}
    <div class="row" style="margin-bottom:12px">${can('vehicles.edit') ? '<button class="btn btn-primary" data-up><i class="fa-solid fa-upload"></i> Upload document</button>' : ''}</div>
    ${simpleTable([{ label: 'Document', render: (x) => `<div class="cell-main">${esc(docLabel(x.doc_type))}</div><div class="cell-sub mono">${esc(x.doc_number_masked ?? '')}</div>` }, { label: 'Status', render: (x) => badge(x.status) + (x.rejection_reason ? `<div class="cell-sub">${esc(x.rejection_reason)}</div>` : '') }, { label: 'Expiry', render: (x) => expiryBadge(x.expiry_date) }, { label: 'Uploaded', render: (x) => esc(dateTime(x.created_at)) },
      { label: '', render: (x) => `<div class="row-actions"><button class="btn btn-sm" data-view="${esc(x.id)}"><i class="fa-solid fa-eye"></i> View</button>${x.status === 'pending' && can('vehicles.verify') ? `<button class="btn btn-sm btn-success" data-ok="${esc(x.id)}">Approve</button><button class="btn btn-sm btn-danger" data-no="${esc(x.id)}">Reject</button>` : ''}</div>` }], docs, { icon: 'fa-file-circle-plus', title: 'No documents uploaded', text: 'Upload the RC, insurance and pollution certificate.' })}`;
  const by = (id) => docs.find((x) => x.id === id);
  p.querySelector('[data-up]')?.addEventListener('click', async () => { const ok = await formModal({ title: 'Upload vehicle document', subtitle: v.registration_number,
    fields: [{ name: 'doc_type', label: 'Document type', type: 'select', required: true, options: [...VEHICLE_DOCS, 'other'].map((t) => ({ value: t, label: docLabel(t) })) }, { name: 'file', label: 'File (JPG, PNG, WebP or PDF, max 10 MB)', type: 'file', required: true, rules: [(f) => validateFile(f)] }, { name: 'doc_number_masked', label: 'Document / policy number', rules: [rules.maxLen(40)] }, { name: 'expiry_date', label: 'Expiry date', type: 'date' }],
    onSubmit: async (x) => { const path = await uploadFile('vehicle-documents', v.id, x.file); return insert('vehicle_documents', { vehicle_id: v.id, doc_type: x.doc_type, storage_path: path, doc_number_masked: x.doc_number_masked, expiry_date: x.expiry_date }); } }); if (ok) { toast('success', 'Document uploaded. It is pending review.'); done(); } });
  p.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => { const x = by(b.dataset.view); viewDocument('vehicle-documents', x.storage_path, `${docLabel(x.doc_type)} — ${v.registration_number}`); }; });
  const review = async (x, approve) => { try { let reason = null; if (!approve) { reason = await promptReason({ title: `Reject ${docLabel(x.doc_type)}?`, confirmText: 'Reject document', danger: true }); if (!reason) return; } else if (!(await confirmDialog({ title: `Approve ${docLabel(x.doc_type)}?`, text: 'Confirm that you opened the file and checked the registration number and expiry date.', confirmText: 'Approve' }))) return;
    await rpc('review_vehicle_document', { p_document_id: x.id, p_approve: approve, p_reason: reason }); toast('success', approve ? 'Document approved.' : 'Document rejected.'); done(); } catch (e) { showError(e); } };
  p.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = () => review(by(b.dataset.ok), true); }); p.querySelectorAll('[data-no]').forEach((b) => { b.onclick = () => review(by(b.dataset.no), false); });
}
async function driverTab(p, v, done) {
  const rows = await select('vehicle_assignments', '*', (q) => q.eq('vehicle_id', v.id).order('assigned_at', { ascending: false }).limit(50)); await attach(rows, 'driver_id', 'drivers', 'id,full_name,driver_code,status', 'driver');
  const cur = rows.find((r) => r.is_active);
  p.innerHTML = `${cur ? notice('info', 'Current driver:', ` ${cur.driver?.full_name ?? ''} (${cur.driver?.driver_code ?? ''})`) : notice('warning', 'No driver assigned.')}
    <div class="row" style="margin-bottom:12px">${can('vehicles.assign') ? `<button class="btn btn-primary" data-assign><i class="fa-solid fa-user-plus"></i> ${cur ? 'Change driver' : 'Assign driver'}</button>${cur ? '<button class="btn" data-unassign>Unassign</button>' : ''}` : ''}</div>
    ${simpleTable([{ label: 'Driver', render: (r) => (r.driver ? `<a href="#/drivers?id=${esc(r.driver.id)}">${esc(r.driver.full_name)}</a>` : '—') }, { label: 'Assigned', render: (r) => esc(dateTime(r.assigned_at)) }, { label: 'Unassigned', render: (r) => (r.is_active ? '<span class="badge success">Current</span>' : esc(dateTime(r.unassigned_at))) }, { label: 'Reason', render: (r) => esc(r.unassigned_reason ?? '—') }], rows, { icon: 'fa-user', title: 'No assignment history' })}`;
  p.querySelector('[data-assign]')?.addEventListener('click', async () => { try { const d = await pickDriver({ filters: { status: ['approved', 'pending', 'under_review', 'suspended'] } }); if (!d) return; await rpc('assign_vehicle', { p_vehicle_id: v.id, p_driver_id: d.id, p_reason: null }); toast('success', `Assigned to ${d.full_name}.`); done(); } catch (e) { showError(e); } });
  p.querySelector('[data-unassign]')?.addEventListener('click', async () => { try { const reason = await promptReason({ title: 'Unassign driver?', confirmText: 'Unassign' }); if (!reason) return; await rpc('assign_vehicle', { p_vehicle_id: v.id, p_driver_id: null, p_reason: reason }); toast('success', 'Driver unassigned.'); done(); } catch (e) { showError(e); } });
}
async function maintTab(p, v) {
  const render = async () => {
    const rows = await select('vehicle_maintenance', '*', (q) => q.eq('vehicle_id', v.id).order('performed_on', { ascending: false }).limit(200));
    const total = rows.reduce((a, r) => a + Number(r.cost_paise ?? 0), 0);
    p.innerHTML = `<div class="row" style="margin-bottom:12px">${can('vehicles.edit') ? '<button class="btn btn-primary" data-add><i class="fa-solid fa-plus"></i> Add record</button>' : ''}<span class="muted">Total recorded cost: <strong>${money(total)}</strong></span></div>
      ${simpleTable([{ label: 'Date', render: (r) => esc(date(r.performed_on)) }, { label: 'Type', render: (r) => badge(r.record_type, r.record_type === 'accident' ? 'danger' : 'info') }, { label: 'Description', render: (r) => `${esc(r.description)}${r.vendor ? `<div class="cell-sub">${esc(r.vendor)}</div>` : ''}` }, { label: 'Odometer', cls: 'num', render: (r) => (r.odometer_km === null ? '—' : `${number(r.odometer_km)} km`) },
        { label: 'Fuel', cls: 'num', render: (r) => (r.fuel_litres ? `${esc(r.fuel_litres)} L` : '—') }, { label: 'Cost', cls: 'num', render: (r) => money(r.cost_paise) }, { label: 'Next due', render: (r) => (r.next_due_on ? expiryBadge(r.next_due_on) : r.next_due_odometer_km ? `${number(r.next_due_odometer_km)} km` : '—') },
        { label: '', render: (r) => (can('vehicles.edit') ? `<button class="btn btn-sm btn-ghost" data-del="${esc(r.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button>` : '') }], rows, { icon: 'fa-screwdriver-wrench', title: 'No service, fuel or accident records' })}`;
    p.querySelector('[data-add]')?.addEventListener('click', async () => { const ok = await formModal({ title: 'Add record', subtitle: v.registration_number, values: { performed_on: isoDate(), record_type: 'service' },
      fields: [{ name: 'record_type', label: 'Type', type: 'select', required: true, noBlank: true, options: ['service', 'repair', 'fuel', 'accident', 'inspection'] }, { name: 'performed_on', label: 'Date', type: 'date', required: true, max: isoDate() }, { name: 'description', label: 'Description', required: true, full: true, rules: [rules.minLen(3)] },
        { name: 'cost_paise', label: 'Cost (₹)', type: 'money' }, { name: 'odometer_km', label: 'Odometer (km)', type: 'number', rules: [rules.min(0)] }, { name: 'fuel_litres', label: 'Fuel (litres)', type: 'number', showIf: (x) => x.record_type === 'fuel', rules: [rules.min(0)] }, { name: 'vendor', label: 'Garage / vendor' },
        { name: 'next_due_on', label: 'Next service due on', type: 'date' }, { name: 'next_due_odometer_km', label: 'Next service due at (km)', type: 'number', rules: [rules.min(0)] }],
      onSubmit: (x) => insert('vehicle_maintenance', { vehicle_id: v.id, ...x }) }); if (ok) { toast('success', 'Record added.'); render(); } });
    p.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { try { if (!(await confirmDialog({ title: 'Delete this record?', text: 'The deletion is written to the audit log.', confirmText: 'Delete', danger: true }))) return; await remove('vehicle_maintenance', b.dataset.del); render(); } catch (e) { showError(e); } }; });
  };
  await render();
}

export async function init(root, { params, setParams }) {
  const [cityList, cats] = await Promise.all([cities(), categories()]);
  root.querySelector('#vehicles-actions').innerHTML = `${can('settings.import') ? '<button class="btn" id="veh-import"><i class="fa-solid fa-file-import"></i> Import CSV</button>' : ''}${can('vehicles.edit') ? '<button class="btn btn-primary" id="veh-new"><i class="fa-solid fa-plus"></i> Add vehicle</button>' : ''}`;
  let tb;
  async function stats() {
    try { const c = (f) => countOf('vehicles', f); const [total, active, pending, maint, off] = await Promise.all([c(), c((q) => q.eq('status', 'active')), c((q) => q.eq('status', 'pending')), c((q) => q.eq('status', 'maintenance')), c((q) => q.in('status', ['suspended', 'retired']))]);
      statCards(root.querySelector('#vehicles-stats'), [{ label: 'Total vehicles', value: number(total), icon: 'fa-car' }, { label: 'Active', value: number(active), icon: 'fa-circle-check', tone: 'success' }, { label: 'Awaiting verification', value: number(pending), icon: 'fa-hourglass-half', tone: 'warning' }, { label: 'In maintenance', value: number(maint), icon: 'fa-screwdriver-wrench', tone: 'info' }, { label: 'Suspended / retired', value: number(off), icon: 'fa-box-archive', tone: 'neutral' }]);
    } catch { /* secondary */ }
  }
  const reload = () => { tb.show(tb.current()); stats(); };
  const table = (pane, fixed, withStatus) => { const t = dataTable(pane, {
    search: { placeholder: 'Registration, vehicle ID, model…' }, filters: [...(withStatus ? [{ name: 'status', label: 'All statuses', options: STATUSES }] : []), { name: 'category_id', label: 'All categories', options: asOptions(cats) }, { name: 'city_id', label: 'All cities', options: asOptions(cityList) }, { name: 'ownership_type', label: 'Any owner', options: [{ value: 'company', label: 'Company' }, { value: 'driver_owned', label: 'Driver / partner' }] }],
    columns: [{ label: 'Vehicle', sort: 'registration_number', render: (v) => `<div class="cell-main">${esc(v.registration_number)}</div><div class="cell-sub mono">${esc(v.vehicle_code)}</div>` }, { label: 'Model', render: (v) => `${esc(v.manufacturer ?? '')} ${esc(v.model ?? '')}<div class="cell-sub">${esc(v.color ?? '')} ${esc(v.manufacture_year ?? '')}</div>` }, { label: 'Category', render: (v) => esc(nameMap(cats)[v.category_id] ?? '—') },
      { label: 'City', render: (v) => esc(nameMap(cityList)[v.city_id] ?? '—') }, { label: 'Owner', render: (v) => esc(v.ownership_type === 'company' ? 'Company' : v.owner_name ?? 'Partner') }, { label: 'Driver', render: (v) => (v.driver ? esc(v.driver.full_name) : '<span class="muted">Unassigned</span>') }, { label: 'Status', render: (v) => badge(v.status) }],
    load: async (s) => { const r = await list('vehicles', { search: s.search, searchColumns: ['registration_number', 'vehicle_code', 'model', 'manufacturer'], filters: { ...s.filters, ...fixed }, order: s.sort ?? 'created_at', ascending: s.sort ? s.ascending : false, page: s.page, pageSize: s.pageSize });
      if (r.rows.length) { const a = await select('vehicle_assignments', 'vehicle_id,driver_id', (q) => q.eq('is_active', true).in('vehicle_id', r.rows.map((v) => v.id))); await attach(a, 'driver_id', 'drivers', 'id,full_name', 'driver'); const map = new Map(a.map((x) => [x.vehicle_id, x.driver])); r.rows.forEach((v) => { v.driver = map.get(v.id) ?? null; }); } return r; },
    onRowClick: (v) => openVehicle(v.id, () => { t.reload({ silent: true }); stats(); }),
    export: { perm: 'analytics.export', filename: 'vehicles', loadAll: (s) => listAll('vehicles', { search: s.search, searchColumns: ['registration_number', 'vehicle_code'], filters: { ...s.filters, ...fixed } }), columns: [{ label: 'Vehicle ID', key: 'vehicle_code' }, { label: 'Registration', key: 'registration_number' }, { label: 'Manufacturer', key: 'manufacturer' }, { label: 'Model', key: 'model' }, { label: 'Category', value: (v) => nameMap(cats)[v.category_id] ?? '' }, { label: 'City', value: (v) => nameMap(cityList)[v.city_id] ?? '' }, { label: 'Ownership', key: 'ownership_type' }, { label: 'Status', key: 'status' }, { label: 'Odometer km', key: 'odometer_km' }] },
    empty: { icon: 'fa-car', title: 'No vehicles yet', text: 'Add the first vehicle to your fleet.' } }); };
  tb = tabs(root.querySelector('#vehicles-tabs'), [
    { id: 'all', label: 'All vehicles', icon: 'fa-car', render: (p) => table(p, {}, true) },
    { id: 'pending', label: 'Awaiting verification', icon: 'fa-hourglass-half', render: (p) => table(p, { status: 'pending' }, false) },
    { id: 'maintenance', label: 'In maintenance', icon: 'fa-screwdriver-wrench', render: (p) => table(p, { status: 'maintenance' }, false) },
    { id: 'expiring', label: 'Expiring documents', icon: 'fa-calendar-xmark', render: (pane) => dataTable(pane, { search: false, filters: [{ name: 'window', label: 'Next 30 days', options: [{ value: '0', label: 'Already expired' }, { value: '60', label: 'Next 60 days' }, { value: '90', label: 'Next 90 days' }] }],
      columns: [{ label: 'Vehicle', render: (x) => (x.vehicle ? `<a href="#/vehicles?id=${esc(x.vehicle.id)}">${esc(x.vehicle.registration_number)}</a>` : '—') }, { label: 'Document', render: (x) => esc(docLabel(x.doc_type)) }, { label: 'Expiry', render: (x) => expiryBadge(x.expiry_date) }, { label: 'Status', render: (x) => badge(x.status) }],
      load: async (s) => { const days = s.filters.window === '' ? 30 : Number(s.filters.window); const until = isoDate(new Date(Date.now() + days * 86400000)); const r = await list('vehicle_documents', { order: 'expiry_date', ascending: true, page: s.page, pageSize: s.pageSize, apply: (q) => q.not('expiry_date', 'is', null).lte('expiry_date', until).in('status', ['approved', 'expired']) }); await attach(r.rows, 'vehicle_id', 'vehicles', 'id,registration_number', 'vehicle'); return r; },
      empty: { icon: 'fa-circle-check', title: 'No documents expiring in this window' } }) },
    { id: 'due', label: 'Service due', icon: 'fa-wrench', perm: 'analytics.view', render: async (pane) => { const r = await rpc('maintenance_predictions'); pane.innerHTML = `<section class="card"><div class="card-body"><p class="muted small">${esc(r.method)}</p>${simpleTable([{ label: 'Vehicle', render: (x) => `<a href="#/vehicles?id=${esc(x.vehicle_id)}">${esc(x.registration_number)}</a><div class="cell-sub">${esc(x.vehicle ?? '')}</div>` }, { label: 'Urgency', render: (x) => (Number(x.urgency) >= 3 ? '<span class="badge danger">Overdue</span>' : '<span class="badge warning">Due soon</span>') }, { label: 'Why', render: (x) => esc(x.reason) }, { label: 'Odometer', render: (x) => (x.odometer_km === null ? '—' : `${number(x.odometer_km)} km`) }, { label: 'Last service', render: (x) => esc(date(x.last_service_on)) }], r.vehicles ?? [], { icon: 'fa-circle-check', title: 'No vehicle is due for service', text: 'Based on the “next due” date and odometer you record with each service.' })}</div></section>`; } },
  ], { initial: params.tab, onChange: (id) => setParams({ tab: id, id: null }) });
  root.querySelector('#veh-new')?.addEventListener('click', () => editVehicle(null, (v) => { reload(); if (v?.id) openVehicle(v.id, reload); }).catch(showError));
  root.querySelector('#veh-import')?.addEventListener('click', () => importCsv('vehicles', 'registration_number, category, manufacturer, model, city, owner_name', 'registration_number,category,manufacturer,model,city,owner_name\nUP32AB1234,sedan,Maruti Suzuki,Dzire,Lucknow,Company\n', reload).catch(showError));
  stats(); if (params.id) openVehicle(params.id, reload);
  return () => tb.destroy();
}
