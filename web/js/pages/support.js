// Module 11 — Complaints, support tickets, lost & found, and emergency (SOS) incidents.
import { rpc } from '../supabase-client.js';
import { list, select, getOne, insert, update, staffList, asOptions, nameMap, subscribe, uploadFile, countOf } from '../api.js';
import { dataTable, tabs, badge, openModal, formModal, confirmDialog, toast, showError, dl, timeline, simpleTable, loadingState, errorState, emptyState, notice, statCards, withBusy } from '../components.js';
import { esc, dateTime, ago, titleCase, number, debounce } from '../utilities.js';
import { can, me } from '../permissions.js';
import { rules, validateFile } from '../validation.js';
import { attach, personCell, rideLink, viewDocument, pickCustomer, pickDriver } from './shared.js';
import { createMap, pinIcon } from '../maps.js';

const TYPES = ['customer_complaint', 'driver_complaint', 'support', 'lost_and_found', 'fraud_report', 'dispute'];
const PRIO = { low: '', medium: 'info', high: 'warning', urgent: 'danger' }, SEV = { low: '', medium: 'info', high: 'warning', critical: 'danger' };
const staffOpts = async () => asOptions((await staffList().catch(() => [])).filter((s) => s.status === 'active'), 'full_name');

async function newTicket(done, preset = {}) {
  let customer = null, driver = null;
  const ok = await formModal({ title: 'New ticket', size: 'lg', values: { ticket_type: preset.ticket_type ?? 'support', priority: 'medium' },
    intro: `<div class="row" style="margin-bottom:12px"><button type="button" class="btn btn-sm" data-pc><i class="fa-solid fa-user"></i> Link customer</button><span data-c class="muted small">No customer</span><button type="button" class="btn btn-sm" data-pd><i class="fa-solid fa-id-card"></i> Link driver</button><span data-d class="muted small">No driver</span></div>`,
    fields: [{ name: 'ticket_type', label: 'Type', type: 'select', required: true, noBlank: true, options: TYPES }, { name: 'priority', label: 'Priority', type: 'select', required: true, noBlank: true, options: Object.keys(PRIO) }, { name: 'subject', label: 'Subject', required: true, full: true, rules: [rules.minLen(5), rules.maxLen(150)] }, { name: 'description', label: 'Details', type: 'textarea', required: true, rules: [rules.minLen(10)] },
      { name: 'booking_code', label: 'Booking ID (optional)', upper: true, placeholder: 'BKG-…' }, { name: 'item_description', label: 'Lost item description', showIf: (v) => v.ticket_type === 'lost_and_found', rules: [(v, a) => (a.ticket_type !== 'lost_and_found' || (v ?? '').length >= 3 ? null : 'Describe the item')] }],
    onRender: (form, m) => { m.body.querySelector('[data-pc]').onclick = async () => { const c = await pickCustomer(); if (c) { customer = c; m.body.querySelector('[data-c]').textContent = `${c.full_name} (${c.customer_code})`; } }; m.body.querySelector('[data-pd]').onclick = async () => { const d = await pickDriver(); if (d) { driver = d; m.body.querySelector('[data-d]').textContent = `${d.full_name} (${d.driver_code})`; } }; },
    onSubmit: async (v) => { let booking = null; if (v.booking_code) { const b = await select('bookings', 'id,customer_id,driver_id', (q) => q.eq('booking_code', v.booking_code).limit(1)); if (!b.length) throw new Error(`Booking ${v.booking_code} was not found.`); booking = b[0]; }
      return insert('support_tickets', { ticket_type: v.ticket_type, priority: v.priority, subject: v.subject, description: v.description, raised_by_type: 'staff', booking_id: booking?.id ?? null, customer_id: customer?.id ?? booking?.customer_id ?? null, driver_id: driver?.id ?? booking?.driver_id ?? null, item_description: v.ticket_type === 'lost_and_found' ? v.item_description : null, item_status: v.ticket_type === 'lost_and_found' ? 'reported' : null }); } });
  if (ok) { toast('success', `Ticket ${ok.ticket_code} created.`); done?.(ok); }
}
async function evidenceBlock(box, where, canAdd, bucketFolder) {
  const render = async () => { const files = await select('evidence_files', '*', (q) => q.eq(where.col, where.id).order('created_at', { ascending: false }));
    box.innerHTML = `<h4 style="margin:16px 0 10px">Evidence files</h4>${files.length ? `<div class="doc-grid">${files.map((f) => `<button class="btn" data-file="${esc(f.id)}"><i class="fa-solid fa-paperclip"></i> ${esc(f.file_name)}</button>`).join('')}</div>` : '<p class="muted">No files attached.</p>'}${canAdd ? '<div class="row" style="margin-top:10px"><input type="file" data-pick accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="Evidence file"><button class="btn btn-sm" data-up>Upload</button></div>' : ''}`;
    box.querySelectorAll('[data-file]').forEach((b) => { b.onclick = () => { const f = files.find((x) => x.id === b.dataset.file); viewDocument('evidence', f.storage_path, f.file_name); }; });
    box.querySelector('[data-up]')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => { const file = box.querySelector('[data-pick]').files?.[0]; const bad = validateFile(file, { maxMb: 25 }); if (bad) { toast('error', bad); return; }
      try { const path = await uploadFile('evidence', bucketFolder, file); await insert('evidence_files', { [where.col]: where.id, storage_path: path, file_name: file.name.slice(0, 150), mime_type: file.type }); toast('success', 'File attached.'); render(); } catch (err) { showError(err); } })); };
  await render();
}
export async function openTicket(id, onChange) {
  let changed = false; const m = openModal({ title: 'Ticket', drawer: true, body: loadingState(), footer: '', onClose: () => { if (changed) onChange?.(); } });
  const manage = can('support.manage');
  async function render() {
    try {
      const t = await getOne('support_tickets', id); if (!t) { m.body.innerHTML = emptyState({ icon: 'fa-lock', title: 'Ticket not found' }); return; }
      const [msgs, staff] = await Promise.all([select('support_messages', '*', (q) => q.eq('ticket_id', id).order('created_at')), staffList().catch(() => [])]);
      await Promise.all([attach([t], 'customer_id', 'customer_directory', 'id,full_name,customer_code', 'customer'), attach([t], 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver'), attach([t], 'booking_id', 'bookings', 'id,booking_code', 'booking')]);
      const names = nameMap(staff, 'full_name'); m.setTitle(t.ticket_code); m.root.querySelector('.modal-head small')?.remove();
      m.root.querySelector('.modal-head h2').insertAdjacentHTML('afterend', `<small>${badge(t.status)} <span class="badge ${PRIO[t.priority]}">${esc(titleCase(t.priority))}</span> ${esc(titleCase(t.ticket_type))} · opened ${esc(ago(t.created_at))}</small>`);
      m.body.innerHTML = `<h3 style="margin:0 0 6px">${esc(t.subject)}</h3><p style="white-space:pre-wrap">${esc(t.description)}</p>
        ${dl([['Raised by', esc(titleCase(t.raised_by_type))], ['Customer', t.customer ? `<a href="#/customers?id=${esc(t.customer.id)}">${esc(t.customer.full_name)}</a>` : '—'], ['Driver', t.driver ? `<a href="#/drivers?id=${esc(t.driver.id)}">${esc(t.driver.full_name)}</a>` : '—'], ['Booking', rideLink(t.booking)], ['Assigned to', esc(names[t.assigned_staff_id] ?? 'Unassigned')],
          t.ticket_type === 'lost_and_found' && ['Lost item', `${esc(t.item_description ?? '—')} ${badge(t.item_status ?? 'reported')}`], t.resolution && ['Resolution', `${esc(t.resolution)} <span class="cell-sub">${esc(dateTime(t.resolved_at))}</span>`]])}
        <h4 style="margin:16px 0 10px">Conversation</h4>${timeline(msgs.map((x) => ({ title: `${esc(x.sender_type === 'staff' ? names[x.sender_id] ?? 'Staff' : titleCase(x.sender_type))} ${x.is_internal ? '<span class="badge warning">Internal note</span>' : ''}`, text: esc(x.body), time: dateTime(x.created_at), tone: x.is_internal ? 'warning' : '' })), 'No messages yet.')}
        ${manage && !['closed'].includes(t.status) ? `<div class="field" style="margin-top:12px"><label for="tk-reply">Add a message</label><textarea id="tk-reply" rows="3" maxlength="2000" placeholder="Write a reply or an internal note…"></textarea></div><div class="row"><label class="check"><input type="checkbox" id="tk-internal" checked> Internal note (not visible to the customer or driver)</label><span class="spacer"></span><button class="btn btn-primary" data-send>Add message</button></div>` : ''}<div data-evidence></div>`;
      m.body.querySelector('[data-send]')?.addEventListener('click', (e) => withBusy(e.currentTarget, async () => { const body = m.body.querySelector('#tk-reply').value.trim(); if (body.length < 2) { toast('info', 'Write a message first.'); return; }
        try { await insert('support_messages', { ticket_id: id, sender_type: 'staff', sender_id: me()?.id, body, is_internal: m.body.querySelector('#tk-internal').checked }); if (t.status === 'open') await update('support_tickets', id, { status: 'in_progress' }); changed = true; render(); } catch (err) { showError(err); } }));
      evidenceBlock(m.body.querySelector('[data-evidence]'), { col: 'ticket_id', id }, manage, `tickets/${id}`).catch(() => {});
      const A = [];
      if (manage) { if (!['resolved', 'closed'].includes(t.status)) A.push(['assign', '', 'fa-user-tag', 'Assign'], ['priority', '', 'fa-flag', 'Priority'], ['wait', '', 'fa-hourglass-half', t.status === 'waiting' ? 'Resume' : 'Waiting on user'], ['resolve', 'btn-success', 'fa-check', 'Resolve']); if (t.status === 'resolved') A.push(['close', '', 'fa-box-archive', 'Close'], ['reopen', '', 'fa-rotate-left', 'Reopen']); if (t.status === 'closed') A.push(['reopen', '', 'fa-rotate-left', 'Reopen']); if (t.ticket_type === 'lost_and_found') A.push(['item', '', 'fa-box-open', 'Item status']); }
      m.foot.innerHTML = A.map((a) => `<button class="btn ${a[1]}" data-do="${a[0]}"><i class="fa-solid ${a[2]}"></i> ${a[3]}</button>`).join('') || '<span class="muted small">View only.</span>';
      const save = async (v, msg) => { await update('support_tickets', id, v); toast('success', msg); changed = true; render(); };
      const act = { assign: async () => { const ok = await formModal({ title: 'Assign ticket', values: { s: t.assigned_staff_id ?? me()?.id }, fields: [{ name: 's', label: 'Assign to', type: 'select', required: true, options: await staffOpts() }], onSubmit: (v) => update('support_tickets', id, { assigned_staff_id: v.s, status: t.status === 'open' ? 'in_progress' : t.status }) }); if (ok) { changed = true; render(); } },
        priority: async () => { const ok = await formModal({ title: 'Change priority', values: { p: t.priority }, fields: [{ name: 'p', label: 'Priority', type: 'select', required: true, noBlank: true, options: Object.keys(PRIO) }], onSubmit: (v) => update('support_tickets', id, { priority: v.p }) }); if (ok) { changed = true; render(); } },
        wait: () => save({ status: t.status === 'waiting' ? 'in_progress' : 'waiting' }, 'Status updated.'),
        resolve: async () => { const ok = await formModal({ title: 'Resolve ticket', submitText: 'Mark resolved', fields: [{ name: 'r', label: 'Resolution', type: 'textarea', required: true, rules: [rules.minLen(10)], help: 'What was done? This is kept with the ticket.' }], onSubmit: (v) => update('support_tickets', id, { status: 'resolved', resolution: v.r, resolved_at: new Date().toISOString() }) }); if (ok) { toast('success', 'Ticket resolved.'); changed = true; render(); } },
        close: () => save({ status: 'closed' }, 'Ticket closed.'), reopen: () => save({ status: 'in_progress', resolved_at: null }, 'Ticket reopened.'),
        item: async () => { const ok = await formModal({ title: 'Lost item status', values: { s: t.item_status ?? 'reported' }, fields: [{ name: 's', label: 'Status', type: 'select', required: true, noBlank: true, options: ['reported', 'found', 'returned', 'not_found'] }], onSubmit: (v) => update('support_tickets', id, { item_status: v.s }) }); if (ok) { changed = true; render(); } } };
      m.foot.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => act[b.dataset.do]().catch(showError); });
    } catch (e) { m.body.innerHTML = errorState(e); }
  }
  await render();
}
function ticketsPane(pane, fixed, emptyCfg) {
  const t = dataTable(pane, { search: { placeholder: 'Ticket ID or subject…' }, filters: [{ name: 'status', label: 'Open tickets', options: [{ value: 'all', label: 'All statuses' }, 'open', 'in_progress', 'waiting', 'resolved', 'closed'] }, { name: 'priority', label: 'Any priority', options: Object.keys(PRIO) }, ...(fixed.ticket_type ? [] : [{ name: 'ticket_type', label: 'All types', options: TYPES }]), { name: 'mine', label: 'Assigned to anyone', options: [{ value: 'me', label: 'Assigned to me' }, { value: 'none', label: 'Unassigned' }] }],
    toolbar: [{ label: 'New ticket', icon: 'fa-plus', primary: true, perm: 'support.manage', onClick: () => newTicket((tk) => { t.reload(); openTicket(tk.id, () => t.reload()); }, { ticket_type: Array.isArray(fixed.ticket_type) ? fixed.ticket_type[0] : fixed.ticket_type }) }],
    columns: [{ label: 'Ticket', render: (x) => `<div class="cell-main mono">${esc(x.ticket_code)}</div><div class="cell-sub">${esc(ago(x.created_at))}</div>` }, { label: 'Subject', render: (x) => `<div style="max-width:340px"><div class="cell-main">${esc(x.subject)}</div><div class="cell-sub">${esc(titleCase(x.ticket_type))}${x.ticket_type === 'lost_and_found' ? ` · item ${esc(titleCase(x.item_status ?? 'reported'))}` : ''}</div></div>` },
      { label: 'From', render: (x) => (x.customer ? personCell(x.customer, 'customer_code') : x.driver ? personCell(x.driver, 'driver_code') : esc(titleCase(x.raised_by_type))) }, { label: 'Priority', render: (x) => `<span class="badge ${PRIO[x.priority]}">${esc(titleCase(x.priority))}</span>` }, { label: 'Assigned', render: (x) => esc(x.staff?.full_name ?? 'Unassigned') }, { label: 'Status', render: (x) => badge(x.status) }],
    rowClass: (x) => (x.priority === 'urgent' && !['resolved', 'closed'].includes(x.status) ? 'row-danger' : ''),
    load: async (s) => { const { status, mine, ...f } = s.filters; const r = await list('support_tickets', { search: s.search, searchColumns: ['ticket_code', 'subject'], filters: { ...f, ...fixed }, page: s.page, pageSize: s.pageSize, apply: (q) => { if (status === '') q = q.in('status', ['open', 'in_progress', 'waiting']); else if (status !== 'all') q = q.eq('status', status); if (mine === 'me') q = q.eq('assigned_staff_id', me()?.id); if (mine === 'none') q = q.is('assigned_staff_id', null); return q; } });
      await Promise.all([attach(r.rows, 'customer_id', 'customer_directory', 'id,full_name,customer_code', 'customer'), attach(r.rows, 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver'), attach(r.rows, 'assigned_staff_id', 'staff_accounts', 'id,full_name', 'staff')]); return r; },
    onRowClick: (x) => openTicket(x.id, () => t.reload({ silent: true })), empty: emptyCfg });
  return subscribe('support-tickets', ['support_tickets'], debounce(() => t.reload({ silent: true }), 1500));
}

// ---------- safety incidents ----------
export async function openIncident(id, onChange) {
  let changed = false; const m = openModal({ title: 'Incident', drawer: true, body: loadingState(), footer: '', onClose: () => { if (changed) onChange?.(); } });
  const manage = can('safety.manage');
  async function render() {
    try {
      const i = await getOne('safety_incidents', id); if (!i) { m.body.innerHTML = emptyState({ icon: 'fa-lock', title: 'Incident not found' }); return; }
      await Promise.all([attach([i], 'customer_id', 'customer_directory', 'id,full_name,customer_code,phone', 'customer'), attach([i], 'driver_id', 'drivers', 'id,full_name,driver_code,phone', 'driver'), attach([i], 'booking_id', 'bookings', 'id,booking_code,status,pickup_address,drop_address', 'booking'), attach([i], 'vehicle_id', 'vehicles', 'id,registration_number', 'vehicle'), attach([i], 'assigned_staff_id', 'staff_accounts', 'id,full_name', 'staff')]);
      const loc = i.driver_id && can('tracking.view') ? (await select('driver_locations', 'lat,lng,received_at,speed_kmh', (q) => q.eq('driver_id', i.driver_id)))[0] : null;
      m.setTitle(i.incident_code); m.root.querySelector('.modal-head small')?.remove();
      m.root.querySelector('.modal-head h2').insertAdjacentHTML('afterend', `<small>${badge(i.status, ['open'].includes(i.status) ? 'danger' : null)} <span class="badge ${SEV[i.severity]}">${esc(titleCase(i.severity))}</span> ${esc(titleCase(i.incident_type))} · reported ${esc(ago(i.created_at))} by ${esc(titleCase(i.reported_by_type))}</small>`);
      m.body.innerHTML = `${i.status === 'open' ? notice('danger', 'Not acknowledged yet.', ' Acknowledge to show the team that someone is handling it, then contact the people involved.') : ''}
        <p style="white-space:pre-wrap">${esc(i.description ?? 'No description was given.')}</p>
        <div class="grid grid-2"><div>${dl([['Customer', i.customer ? `<a href="#/customers?id=${esc(i.customer.id)}">${esc(i.customer.full_name)}</a>` : '—'], ['Customer phone', i.customer?.phone ? `<a href="tel:${esc(i.customer.phone)}">${esc(i.customer.phone)}</a>` : '—'], ['Driver', i.driver ? `<a href="#/drivers?id=${esc(i.driver.id)}">${esc(i.driver.full_name)}</a>` : '—'], ['Driver phone', i.driver?.phone ? `<a href="tel:${esc(i.driver.phone)}">${esc(i.driver.phone)}</a>` : '—'], ['Vehicle', esc(i.vehicle?.registration_number ?? '—')]])}</div>
          <div>${dl([['Booking', i.booking ? `${rideLink(i.booking)} ${badge(i.booking.status)}` : '—'], ['Route', i.booking ? `${esc(i.booking.pickup_address)} → ${esc(i.booking.drop_address)}` : '—'], ['Handled by', esc(i.staff?.full_name ?? 'Nobody yet')], ['Acknowledged', esc(dateTime(i.acknowledged_at))], ['Resolved', esc(dateTime(i.resolved_at))]])}</div></div>
        <h4 style="margin:16px 0 10px">Location</h4><div class="map sm" data-map></div><p class="field-help" data-loc></p>
        ${i.investigation_notes ? `<h4 style="margin:16px 0 6px">Investigation notes</h4><p style="white-space:pre-wrap">${esc(i.investigation_notes)}</p>` : ''}${i.resolution ? `<h4 style="margin:16px 0 6px">Resolution</h4><p style="white-space:pre-wrap">${esc(i.resolution)}</p>` : ''}<div data-evidence></div>
        ${notice('info', 'Emergency services', ' This console does not call the police or an ambulance. In a real emergency dial 112.')}`;
      const at = i.lat !== null ? { lat: Number(i.lat), lng: Number(i.lng) } : null, now = loc ? { lat: Number(loc.lat), lng: Number(loc.lng) } : null; const note = m.body.querySelector('[data-loc]');
      note.textContent = [at ? `Reported at ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}` : 'No location was sent with the alert', now ? `driver’s last position ${ago(loc.received_at)}` : ''].filter(Boolean).join(' · ');
      if (at || now) { const map = await createMap(m.body.querySelector('[data-map]'), { center: now ?? at, zoom: 15 }); if (map) { const g = window.google.maps; if (at) new g.Marker({ map, position: at, icon: pinIcon(g, '#b91c1c', '!'), title: 'Where the alert was raised' }); if (now) new g.Marker({ map, position: now, icon: pinIcon(g, '#2563eb', 'D'), title: `Driver's last known position (${ago(loc.received_at)})` }); } } else m.body.querySelector('[data-map]').remove();
      evidenceBlock(m.body.querySelector('[data-evidence]'), { col: 'incident_id', id }, manage, `incidents/${id}`).catch(() => {});
      const A = []; const open = !['resolved', 'false_alarm'].includes(i.status);
      if (manage && open) { if (i.status === 'open') A.push(['ack', 'btn-danger', 'fa-hand', 'Acknowledge']); if (i.status !== 'investigating') A.push(['investigate', '', 'fa-magnifying-glass', 'Start investigation']); A.push(['note', '', 'fa-pen', 'Add investigation note'], ['severity', '', 'fa-flag', 'Severity'], ['resolve', 'btn-success', 'fa-check', 'Resolve'], ['false', '', 'fa-bell-slash', 'False alarm']); }
      if (i.driver_id && can('tracking.view')) A.push(['track', '', 'fa-location-crosshairs', 'Track driver']);
      m.foot.innerHTML = A.map((a) => `<button class="btn ${a[1]}" data-do="${a[0]}"><i class="fa-solid ${a[2]}"></i> ${a[3]}</button>`).join('') || '<span class="muted small">View only.</span>';
      const save = async (v, msg) => { await update('safety_incidents', id, v); toast('success', msg); changed = true; render(); };
      const closeWith = async (status, title) => { const ok = await formModal({ title, submitText: 'Save', fields: [{ name: 'r', label: status === 'resolved' ? 'What happened and what was done?' : 'Why is this a false alarm?', type: 'textarea', required: true, rules: [rules.minLen(10)] }], onSubmit: (v) => update('safety_incidents', id, { status, resolution: v.r, resolved_at: new Date().toISOString(), assigned_staff_id: i.assigned_staff_id ?? me()?.id }) }); if (ok) { toast('success', 'Incident closed.'); changed = true; render(); } };
      const act = { ack: () => save({ status: 'acknowledged', acknowledged_at: new Date().toISOString(), assigned_staff_id: i.assigned_staff_id ?? me()?.id }, 'Acknowledged. You are now handling this incident.'),
        investigate: () => save({ status: 'investigating', acknowledged_at: i.acknowledged_at ?? new Date().toISOString(), assigned_staff_id: i.assigned_staff_id ?? me()?.id }, 'Investigation started.'),
        note: async () => { const ok = await formModal({ title: 'Add investigation note', fields: [{ name: 'n', label: 'Note', type: 'textarea', required: true, rules: [rules.minLen(5)] }], onSubmit: (v) => update('safety_incidents', id, { investigation_notes: `${i.investigation_notes ? `${i.investigation_notes}\n\n` : ''}[${new Date().toLocaleString('en-IN')} — ${me()?.full_name ?? 'Staff'}]\n${v.n}` }) }); if (ok) { changed = true; render(); } },
        severity: async () => { const ok = await formModal({ title: 'Change severity', values: { s: i.severity }, fields: [{ name: 's', label: 'Severity', type: 'select', required: true, noBlank: true, options: Object.keys(SEV) }], onSubmit: (v) => update('safety_incidents', id, { severity: v.s }) }); if (ok) { changed = true; render(); } },
        resolve: () => closeWith('resolved', 'Resolve incident'), false: () => closeWith('false_alarm', 'Mark as false alarm'), track: async () => { m.close(); location.hash = `#/live-tracking?driver=${i.driver_id}`; } };
      m.foot.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => act[b.dataset.do]().catch(showError); });
    } catch (e) { m.body.innerHTML = errorState(e); }
  }
  await render();
}
function incidentsPane(pane) {
  const t = dataTable(pane, { search: { placeholder: 'Incident ID…' }, filters: [{ name: 'status', label: 'Open incidents', options: [{ value: 'all', label: 'All statuses' }, 'open', 'acknowledged', 'investigating', 'resolved', 'false_alarm'] }, { name: 'incident_type', label: 'All types', options: ['sos', 'accident', 'harassment', 'theft', 'medical', 'vehicle_breakdown', 'other'] }, { name: 'severity', label: 'Any severity', options: Object.keys(SEV) }],
    columns: [{ label: 'Incident', render: (i) => `<div class="cell-main mono">${esc(i.incident_code)}</div><div class="cell-sub">${esc(ago(i.created_at))}</div>` }, { label: 'Type', render: (i) => `${esc(titleCase(i.incident_type))}<div><span class="badge ${SEV[i.severity]}">${esc(titleCase(i.severity))}</span></div>` }, { label: 'Booking', render: (i) => rideLink(i.booking) }, { label: 'Driver', render: (i) => personCell(i.driver, 'driver_code') }, { label: 'Customer', render: (i) => personCell(i.customer, 'customer_code') }, { label: 'Handled by', render: (i) => esc(i.staff?.full_name ?? '—') }, { label: 'Status', render: (i) => badge(i.status, i.status === 'open' ? 'danger' : null) }],
    rowClass: (i) => (i.status === 'open' ? 'row-danger' : ''),
    load: async (s) => { const { status, ...f } = s.filters; const r = await list('safety_incidents', { search: s.search, searchColumns: ['incident_code'], filters: f, page: s.page, pageSize: s.pageSize, apply: (q) => (status === '' ? q.in('status', ['open', 'acknowledged', 'investigating']) : status === 'all' ? q : q.eq('status', status)) });
      await Promise.all([attach(r.rows, 'booking_id', 'bookings', 'id,booking_code', 'booking'), attach(r.rows, 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver'), attach(r.rows, 'customer_id', 'customer_directory', 'id,full_name,customer_code', 'customer'), attach(r.rows, 'assigned_staff_id', 'staff_accounts', 'id,full_name', 'staff')]); return r; },
    onRowClick: (i) => openIncident(i.id, () => t.reload({ silent: true })), empty: { icon: 'fa-shield-heart', title: 'No open incidents', text: 'SOS alerts from the Driver and Customer apps appear here immediately.' } });
  return subscribe('safety-incidents', ['safety_incidents'], debounce(() => t.reload({ silent: true }), 800));
}

export async function init(root, { params, setParams }) {
  const top = root.querySelector('#support-top'); top.className = 'stats'; let tb;
  async function stats() { try { const [openT, urgent, lost, openI] = await Promise.all([can('support.view') ? countOf('support_tickets', (q) => q.in('status', ['open', 'in_progress', 'waiting'])) : null, can('support.view') ? countOf('support_tickets', (q) => q.in('status', ['open', 'in_progress', 'waiting']).eq('priority', 'urgent')) : null, can('support.view') ? countOf('support_tickets', (q) => q.eq('ticket_type', 'lost_and_found').in('item_status', ['reported', 'found'])) : null, can('safety.view') ? countOf('safety_incidents', (q) => q.in('status', ['open', 'acknowledged', 'investigating'])) : null]);
    statCards(top, [openI !== null && { label: 'Open emergencies', value: number(openI), icon: 'fa-triangle-exclamation', tone: openI ? 'danger' : 'success' }, openT !== null && { label: 'Open tickets', value: number(openT), icon: 'fa-headset', tone: 'info' }, urgent !== null && { label: 'Urgent tickets', value: number(urgent), icon: 'fa-fire', tone: urgent ? 'danger' : 'neutral' }, lost !== null && { label: 'Lost items being traced', value: number(lost), icon: 'fa-box-open' }].filter(Boolean)); tb?.setCount('incidents', openI ?? 0, true); tb?.setCount('tickets', openT ?? 0); } catch { /* secondary */ } }
  tb = tabs(root.querySelector('#support-tabs'), [
    { id: 'tickets', label: 'All tickets', icon: 'fa-headset', perm: 'support.view', render: (p) => ticketsPane(p, {}, { icon: 'fa-headset', title: 'No open tickets', text: 'Tickets raised from the apps or created by staff appear here.' }) },
    { id: 'complaints', label: 'Complaints', icon: 'fa-comment-dots', perm: 'support.view', render: (p) => ticketsPane(p, { ticket_type: ['customer_complaint', 'driver_complaint'] }, { icon: 'fa-comment-dots', title: 'No open complaints' }) },
    { id: 'lost', label: 'Lost & found', icon: 'fa-box-open', perm: 'support.view', render: (p) => ticketsPane(p, { ticket_type: 'lost_and_found' }, { icon: 'fa-box-open', title: 'No lost-item reports' }) },
    { id: 'fraud', label: 'Fraud reports', icon: 'fa-user-secret', perm: 'support.view', render: (p) => ticketsPane(p, { ticket_type: 'fraud_report' }, { icon: 'fa-user-secret', title: 'No fraud reports' }) },
    { id: 'incidents', label: 'Emergencies (SOS)', icon: 'fa-triangle-exclamation', perm: 'safety.view', render: (p) => incidentsPane(p) },
  ], { initial: params.tab, onChange: (id) => setParams({ tab: id, id: null }) });
  stats(); const timer = setInterval(() => { if (!document.hidden) stats(); }, 30000);
  if (params.id) { const isIncident = params.tab === 'incidents' || (can('safety.view') && (await select('safety_incidents', 'id', (q) => q.eq('id', params.id)).catch(() => [])).length); (isIncident ? openIncident : openTicket)(params.id, () => tb.show(tb.current())); }
  return () => { clearInterval(timer); tb.destroy(); };
}
