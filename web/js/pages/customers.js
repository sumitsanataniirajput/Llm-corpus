// Module 4 — Customer management. Phone/e-mail are masked unless the role has customers.view_pii.
import { rpc } from '../supabase-client.js';
import { list, listAll, select, getOne, insert, update, cities, asOptions, nameMap, countOf } from '../api.js';
import { dataTable, tabs, badge, openModal, formModal, promptReason, confirmDialog, toast, showError, dl, timeline, simpleTable, loadingState, errorState, emptyState, notice, statCards } from '../components.js';
import { esc, money, dateTime, date, titleCase, number, idempotencyKey } from '../utilities.js';
import { can } from '../permissions.js';
import { rules, normalisePhone } from '../validation.js';
import { attach, rideLink } from './shared.js';
import { importCsv } from './drivers.js';

const pii = () => can('customers.view_pii');
async function editCustomer(c, done) {
  const cityList = await cities();
  const ok = await formModal({ title: c ? `Edit ${c.full_name}` : 'Add customer', subtitle: c ? c.customer_code : 'Customers normally register in the Customer App. Add one here for phone bookings.', values: c ?? {},
    fields: [{ name: 'full_name', label: 'Full name', required: true, rules: [rules.minLen(2), rules.maxLen(120)] }, { name: 'phone', label: 'Mobile number', type: 'tel', required: true, rules: [rules.phone] }, { name: 'email', label: 'E-mail', type: 'email', rules: [rules.email] }, { name: 'city_id', label: 'City', type: 'select', options: asOptions(cityList) },
      ...(c ? [{ name: 'loyalty_tier', label: 'Loyalty tier', type: 'select', noBlank: true, options: ['standard', 'silver', 'gold', 'platinum'] }] : [])],
    onSubmit: (v) => { const x = { ...v, phone: normalisePhone(v.phone) }; return c ? update('customers', c.id, x) : insert('customers', x); } });
  if (ok) { toast('success', c ? 'Customer updated.' : 'Customer added.'); done?.(ok); }
}

export async function openCustomer(id, onChange) {
  let changed = false;
  const m = openModal({ title: 'Customer', drawer: true, body: loadingState(), footer: '', onClose: () => { if (changed) onChange?.(); } });
  const done = () => { changed = true; render(); };
  async function render() {
    try {
      const c = await getOne('customer_directory', id);
      if (!c) { m.body.innerHTML = emptyState({ icon: 'fa-lock', title: 'Customer not found', text: 'The record does not exist or is outside your city scope.' }); return; }
      const cityList = await cities();
      m.setTitle(c.full_name); m.root.querySelector('.modal-head small')?.remove();
      m.root.querySelector('.modal-head h2').insertAdjacentHTML('afterend', `<small><span class="mono">${esc(c.customer_code)}</span> ${badge(c.status)} ${c.is_suspicious ? '<span class="badge danger">Suspicious</span>' : ''} ${badge(c.loyalty_tier, 'violet')}</small>`);
      m.body.innerHTML = '<div data-tabs></div>';
      tabs(m.body.querySelector('[data-tabs]'), [
        { id: 'profile', label: 'Profile', render: (p) => { p.innerHTML = `${c.status === 'blocked' ? notice('danger', 'Blocked:', ` ${c.status_reason ?? ''}`) : ''}${c.is_suspicious ? notice('warning', 'Flagged as suspicious:', ` ${c.suspicious_reason ?? ''}`) : ''}${c.status === 'deletion_requested' ? notice('warning', 'Account deletion requested', ` on ${dateTime(c.deletion_requested_at)}. Review it under “Deletion requests”.`) : ''}
          ${pii() ? '' : notice('info', 'Contact details are masked.', ' Your role does not include customers.view_pii.')}
          <div class="stats"><div class="stat"><div><div class="stat-label">Bookings</div><div class="stat-value">${number(c.total_bookings)}</div></div></div><div class="stat"><div><div class="stat-label">Total spent</div><div class="stat-value">${money(c.total_spent_paise)}</div></div></div><div class="stat"><div><div class="stat-label">Wallet</div><div class="stat-value">${money(c.wallet_balance_paise)}</div></div></div><div class="stat"><div><div class="stat-label">Loyalty points</div><div class="stat-value">${number(c.loyalty_points)}</div></div></div></div>
          ${dl([['Mobile', `${esc(c.phone ?? '—')} ${c.phone_verified ? '<span class="badge success">Verified</span>' : '<span class="badge">Unverified</span>'}`], ['E-mail', `${esc(c.email ?? '—')}`], ['City', esc(nameMap(cityList)[c.city_id] ?? '—')], ['Rating (from drivers)', c.rating_count ? `★ ${esc(Number(c.rating_avg).toFixed(1))} (${esc(c.rating_count)})` : '—'], ['Joined', esc(dateTime(c.created_at))]])}`; } },
        { id: 'bookings', label: 'Bookings', perm: 'rides.view', render: (p) => dataTable(p, { search: false, pageSize: 10, filters: [{ name: 'status', label: 'All statuses', options: ['PAYMENT_COMPLETED', 'PAYMENT_PENDING', 'CANCELLED', 'DISPUTED'].map((s) => ({ value: s, label: titleCase(s) })) }],
          columns: [{ label: 'Booking', render: (b) => rideLink(b) }, { label: 'Date', render: (b) => esc(dateTime(b.created_at)) }, { label: 'Route', render: (b) => `<span class="cell-sub">${esc(b.pickup_address)} → ${esc(b.drop_address)}</span>` }, { label: 'Status', render: (b) => badge(b.status) }, { label: 'Fare', cls: 'num', render: (b) => money(b.total_fare_paise ?? b.estimated_fare_paise) }, { label: 'Payment', render: (b) => badge(b.payment_status) }],
          load: (s) => list('bookings', { select: 'id,booking_code,created_at,pickup_address,drop_address,status,total_fare_paise,estimated_fare_paise,payment_status', filters: { customer_id: c.id, status: s.filters.status }, page: s.page, pageSize: 10 }), empty: { icon: 'fa-route', title: 'No bookings yet' } }) },
        { id: 'wallet', label: 'Wallet & payments', perm: 'finance.view', render: (p) => walletTab(p, c, done) },
        { id: 'support', label: 'Complaints & reviews', render: (p) => supportTab(p, c) },
        { id: 'notes', label: 'Notes', perm: 'customers.notes', render: (p) => notesTab(p, c) },
      ]);
      const A = [];
      if (can('customers.manage') && pii() && !['deleted'].includes(c.status)) A.push(['edit', '', 'fa-pen', 'Edit']);
      if (can('customers.manage')) { if (c.status === 'active') A.push(['block', 'btn-danger', 'fa-ban', 'Block']); if (c.status === 'blocked') A.push(['unblock', 'btn-success', 'fa-unlock', 'Unblock']); A.push(['flag', '', 'fa-flag', c.is_suspicious ? 'Clear suspicious flag' : 'Flag as suspicious']); }
      m.foot.innerHTML = A.map((a) => `<button class="btn ${a[1]}" data-do="${a[0]}"><i class="fa-solid ${a[2]}"></i> ${a[3]}</button>`).join('') || '<span class="muted small">View only.</span>';
      const act = { edit: async () => editCustomer(await getOne('customers', c.id), done),
        block: async () => { const r = await promptReason({ title: `Block ${c.full_name}?`, text: 'The customer cannot create new bookings.', confirmText: 'Block customer', danger: true }); if (!r) return; await rpc('set_customer_status', { p_customer_id: c.id, p_status: 'blocked', p_reason: r }); toast('success', 'Customer blocked.'); done(); },
        unblock: async () => { const r = await promptReason({ title: `Unblock ${c.full_name}?`, confirmText: 'Unblock' }); if (!r) return; await rpc('set_customer_status', { p_customer_id: c.id, p_status: 'active', p_reason: r }); toast('success', 'Customer unblocked.'); done(); },
        flag: async () => { const r = await promptReason({ title: c.is_suspicious ? 'Clear the suspicious flag?' : 'Flag as suspicious?', text: c.is_suspicious ? '' : 'A flag does not block the customer; it warns staff.', confirmText: 'Save' }); if (!r) return; await rpc('flag_customer', { p_customer_id: c.id, p_suspicious: !c.is_suspicious, p_reason: r }); toast('success', 'Flag updated.'); done(); } };
      m.foot.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => act[b.dataset.do]().catch(showError); });
    } catch (e) { m.body.innerHTML = errorState(e); }
  }
  await render();
}
async function walletTab(p, c, done) {
  const [tx, pays] = await Promise.all([select('wallet_transactions', '*', (q) => q.eq('customer_id', c.id).order('created_at', { ascending: false }).limit(50)), select('payments', 'id,txn_code,amount_paise,refunded_paise,status,method,captured_at,created_at,booking_id', (q) => q.eq('customer_id', c.id).order('created_at', { ascending: false }).limit(30))]);
  p.innerHTML = `<div class="row" style="margin-bottom:12px"><strong>Wallet balance: ${money(c.wallet_balance_paise)}</strong>${can('finance.wallet_adjust') ? '<button class="btn" data-adjust><i class="fa-solid fa-sliders"></i> Adjust wallet</button>' : ''}</div>
    <h4 style="margin:6px 0 10px">Wallet ledger</h4>${simpleTable([{ label: 'When', render: (x) => esc(dateTime(x.created_at)) }, { label: 'Entry', render: (x) => `${esc(titleCase(x.reason))}<div class="cell-sub">${esc(x.reference ?? '')}</div>` }, { label: 'Amount', cls: 'num', render: (x) => `<span style="color:var(--${x.direction === 'credit' ? 'success' : 'danger'})">${x.direction === 'credit' ? '+' : '−'} ${money(x.amount_paise)}</span>` }, { label: 'Balance after', cls: 'num', render: (x) => money(x.balance_after_paise) }], tx, { icon: 'fa-wallet', title: 'No wallet entries' })}
    <h4 style="margin:16px 0 10px">Payments</h4>${simpleTable([{ label: 'Transaction', render: (x) => `<span class="mono">${esc(x.txn_code)}</span>` }, { label: 'Date', render: (x) => esc(dateTime(x.captured_at ?? x.created_at)) }, { label: 'Amount', cls: 'num', render: (x) => money(x.amount_paise) }, { label: 'Refunded', cls: 'num', render: (x) => money(x.refunded_paise) }, { label: 'Method', render: (x) => esc(titleCase(x.method ?? '—')) }, { label: 'Status', render: (x) => badge(x.status) }, { label: '', render: (x) => `<a class="btn btn-sm" href="#/rides?id=${esc(x.booking_id)}">Ride</a>` }], pays, { icon: 'fa-receipt', title: 'No payments' })}`;
  p.querySelector('[data-adjust]')?.addEventListener('click', async () => { const key = idempotencyKey('cwallet'); const ok = await formModal({ title: 'Adjust customer wallet', subtitle: `${c.full_name} · current balance ${money(c.wallet_balance_paise)}`, danger: true, submitText: 'Apply adjustment',
    fields: [{ name: 'direction', label: 'Direction', type: 'select', required: true, noBlank: true, options: [{ value: 'credit', label: 'Credit (add money)' }, { value: 'debit', label: 'Debit (remove money)' }] }, { name: 'amount', label: 'Amount (₹)', type: 'money', required: true, rules: [rules.min(1)] }, { name: 'reason', label: 'Reason', type: 'textarea', required: true, rules: [rules.minLen(5)] }],
    onSubmit: (v) => rpc('adjust_customer_wallet', { p_customer_id: c.id, p_direction: v.direction, p_amount_paise: v.amount, p_reason: v.reason, p_idempotency_key: key }) }); if (ok) { toast('success', 'Wallet adjusted.'); done(); } });
}
async function supportTab(p, c) {
  const [tickets, reviews] = await Promise.all([can('support.view') ? select('support_tickets', 'id,ticket_code,subject,status,priority,created_at,ticket_type', (q) => q.eq('customer_id', c.id).order('created_at', { ascending: false }).limit(30)) : null, can('rides.view') ? select('reviews', '*', (q) => q.eq('customer_id', c.id).order('created_at', { ascending: false }).limit(30)) : null]);
  p.innerHTML = `<h4 style="margin-bottom:10px">Complaints and tickets</h4>${tickets ? simpleTable([{ label: 'Ticket', render: (t) => `<a class="mono" href="#/support?id=${esc(t.id)}">${esc(t.ticket_code)}</a>` }, { label: 'Type', render: (t) => esc(titleCase(t.ticket_type)) }, { label: 'Subject', render: (t) => esc(t.subject) }, { label: 'Priority', render: (t) => badge(t.priority) }, { label: 'Status', render: (t) => badge(t.status) }, { label: 'Opened', render: (t) => esc(date(t.created_at)) }], tickets, { icon: 'fa-headset', title: 'No tickets' }) : '<p class="muted">Needs the support.view permission.</p>'}
    <h4 style="margin:16px 0 10px">Reviews</h4>${reviews ? simpleTable([{ label: 'By', render: (r) => esc(r.reviewer_type === 'customer' ? 'Customer → driver' : 'Driver → customer') }, { label: 'Rating', render: (r) => `★ ${esc(r.rating)}` }, { label: 'Comment', render: (r) => esc(r.comment ?? '—') }, { label: 'Date', render: (r) => esc(date(r.created_at)) }], reviews, { icon: 'fa-star', title: 'No reviews' }) : ''}`;
}
async function notesTab(p, c) {
  const render = async () => { const notes = await select('customer_notes', '*', (q) => q.eq('customer_id', c.id).order('created_at', { ascending: false }).limit(100)); await attach(notes, 'staff_id', 'staff_accounts', 'id,full_name', 'staff');
    p.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="btn btn-primary" data-add><i class="fa-solid fa-plus"></i> Add note</button></div>${timeline(notes.map((n) => ({ title: esc(n.staff?.full_name ?? 'Staff'), text: esc(n.body), time: dateTime(n.created_at) })), 'No notes yet.')}`;
    p.querySelector('[data-add]').onclick = async () => { const ok = await formModal({ title: 'Add note', subtitle: 'Internal only. Notes cannot be edited after saving.', fields: [{ name: 'body', label: 'Note', type: 'textarea', required: true, rules: [rules.minLen(5)] }], onSubmit: (v) => insert('customer_notes', { customer_id: c.id, body: v.body }) }); if (ok) render(); }; };
  await render();
}

export async function init(root, { params, setParams }) {
  const cityList = await cities();
  root.querySelector('#customers-actions').innerHTML = `${can('settings.import') ? '<button class="btn" id="cus-import"><i class="fa-solid fa-file-import"></i> Import CSV</button>' : ''}${can('customers.manage') && pii() ? '<button class="btn btn-primary" id="cus-new"><i class="fa-solid fa-plus"></i> Add customer</button>' : ''}`;
  let tb;
  async function stats() { try { const c = (f) => countOf('customer_directory', f); const [total, blocked, susp, del] = await Promise.all([c((q) => q.neq('status', 'deleted')), c((q) => q.eq('status', 'blocked')), c((q) => q.eq('is_suspicious', true)), c((q) => q.eq('status', 'deletion_requested'))]);
    statCards(root.querySelector('#customers-stats'), [{ label: 'Customers', value: number(total), icon: 'fa-users' }, { label: 'Blocked', value: number(blocked), icon: 'fa-ban', tone: 'danger' }, { label: 'Flagged suspicious', value: number(susp), icon: 'fa-flag', tone: 'warning' }, { label: 'Deletion requests', value: number(del), icon: 'fa-user-xmark', tone: del ? 'warning' : 'neutral' }]); tb?.setCount('deletion', del, true); } catch { /* secondary */ } }
  const reload = () => { tb.show(tb.current()); stats(); };
  const search = () => ['full_name', 'customer_code', ...(pii() ? ['phone', 'email'] : [])];
  const table = (pane, fixed, extra = {}) => { const t = dataTable(pane, {
    search: { placeholder: pii() ? 'Name, customer ID, mobile, e-mail…' : 'Name or customer ID…' }, filters: [...(fixed.status || fixed.is_suspicious ? [] : [{ name: 'status', label: 'All statuses', options: ['active', 'blocked', 'deletion_requested', 'deleted'] }]), { name: 'city_id', label: 'All cities', options: asOptions(cityList) }, { name: 'loyalty_tier', label: 'Any tier', options: ['standard', 'silver', 'gold', 'platinum'] }],
    columns: [{ label: 'Customer', sort: 'full_name', render: (c) => `<div class="cell-main">${esc(c.full_name)} ${c.is_suspicious ? '<i class="fa-solid fa-flag" style="color:var(--warning)" title="Flagged suspicious"></i>' : ''}</div><div class="cell-sub mono">${esc(c.customer_code)}</div>` }, { label: 'Mobile', render: (c) => `<span class="mono">${esc(c.phone ?? '—')}</span>` }, { label: 'City', render: (c) => esc(nameMap(cityList)[c.city_id] ?? '—') },
      { label: 'Bookings', cls: 'num', sort: 'total_bookings', render: (c) => number(c.total_bookings) }, { label: 'Spent', cls: 'num', sort: 'total_spent_paise', render: (c) => money(c.total_spent_paise) }, { label: 'Wallet', cls: 'num', render: (c) => money(c.wallet_balance_paise) }, { label: 'Tier', render: (c) => badge(c.loyalty_tier, 'violet') }, { label: 'Status', render: (c) => badge(c.status) }, ...(extra.columns ?? [])],
    load: (s) => list('customer_directory', { search: s.search, searchColumns: search(), filters: { ...s.filters, ...fixed }, order: s.sort ?? 'created_at', ascending: s.sort ? s.ascending : false, page: s.page, pageSize: s.pageSize }),
    onRowClick: (c) => openCustomer(c.id, () => { t.reload({ silent: true }); stats(); }), rowActions: extra.rowActions ? (c) => extra.rowActions(c, () => { t.reload(); stats(); }) : undefined,
    export: { perm: 'analytics.export', filename: 'customers', loadAll: (s) => listAll('customer_directory', { search: s.search, searchColumns: search(), filters: { ...s.filters, ...fixed } }), columns: [{ label: 'Customer ID', key: 'customer_code' }, { label: 'Name', key: 'full_name' }, { label: pii() ? 'Mobile' : 'Mobile (masked)', key: 'phone' }, { label: 'City', value: (c) => nameMap(cityList)[c.city_id] ?? '' }, { label: 'Bookings', key: 'total_bookings' }, { label: 'Spent (INR)', value: (c) => (Number(c.total_spent_paise ?? 0) / 100).toFixed(2) }, { label: 'Tier', key: 'loyalty_tier' }, { label: 'Status', key: 'status' }] },
    empty: extra.empty ?? { icon: 'fa-users', title: 'No customers yet', text: 'Customers appear here when they register in the Customer App.' } }); };
  const decide = async (c, approve, done) => { const r = await promptReason({ title: approve ? `Delete ${c.full_name}'s personal data?` : 'Reject the deletion request?', text: approve ? 'Name, phone and e-mail are permanently anonymised. Ride and payment records are kept without personal details, as the law requires for financial records. This cannot be undone.' : 'The account returns to active.', confirmText: approve ? 'Anonymise account' : 'Reject request', danger: approve, min: 5 });
    if (!r) return; await rpc('process_deletion_request', { p_customer_id: c.id, p_approve: approve, p_reason: r }); toast('success', approve ? 'Account anonymised.' : 'Request rejected.'); done(); };
  tb = tabs(root.querySelector('#customers-tabs'), [
    { id: 'all', label: 'All customers', icon: 'fa-users', render: (p) => table(p, {}) },
    { id: 'blocked', label: 'Blocked', icon: 'fa-ban', render: (p) => table(p, { status: 'blocked' }, { empty: { icon: 'fa-circle-check', title: 'No blocked customers' } }) },
    { id: 'suspicious', label: 'Suspicious', icon: 'fa-flag', render: (p) => table(p, { is_suspicious: true }, { empty: { icon: 'fa-circle-check', title: 'No flagged customers', text: 'Customers are flagged by staff or by the automatic check (many cancellations or failed payments).' } }) },
    { id: 'deletion', label: 'Deletion requests', icon: 'fa-user-xmark', perm: 'customers.delete', render: (p) => table(p, { status: 'deletion_requested' }, { empty: { icon: 'fa-circle-check', title: 'No pending deletion requests' },
      rowActions: (c, done) => [{ icon: 'fa-user-xmark', title: 'Approve — anonymise', onClick: () => decide(c, true, done) }, { icon: 'fa-rotate-left', title: 'Reject request', onClick: () => decide(c, false, done) }] }) },
  ], { initial: params.tab, onChange: (id) => setParams({ tab: id, id: null }) });
  root.querySelector('#cus-new')?.addEventListener('click', () => editCustomer(null, reload).catch(showError));
  root.querySelector('#cus-import')?.addEventListener('click', () => importCsv('customers', 'full_name, phone, email, city', 'full_name,phone,email,city\nAnita Sharma,9876543210,anita@example.com,Lucknow\n', reload).catch(showError));
  stats(); if (params.id) openCustomer(params.id, reload);
  return () => tb.destroy();
}
