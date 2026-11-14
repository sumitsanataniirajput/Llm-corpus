// Module 14 — Staff, roles and permissions. Accounts are created by the staff-admin Edge Function
// (the service key never reaches the browser); role and status changes go through update_staff().
import { rpc, fn, toAppError, AppError } from '../supabase-client.js';
import { list, select, cities, branches, roles, asOptions, nameMap, invalidate } from '../api.js';
import { dataTable, tabs, badge, formModal, promptReason, confirmDialog, toast, showError, simpleTable, openModal, loadingState, errorState, emptyState, notice, dl, timeline } from '../components.js';
import { esc, dateTime, date, ago, titleCase, number } from '../utilities.js';
import { can, me, roleCode } from '../permissions.js';
import { rules, normalisePhone } from '../validation.js';
import { attach } from './shared.js';

const call = async (body) => { const r = await fn('staff-admin', body); if (r?.ok === false) throw new AppError(r.code, r.message); return r; };
const redirect = () => `${location.origin}${location.pathname}`;

async function addStaff(done) {
  const [roleList, cityList, branchList] = await Promise.all([roles(), cities(), branches()]); const myRank = roleList.find((r) => r.code === roleCode())?.rank ?? 99;
  const ok = await formModal({ title: 'Add staff member', size: 'lg', subtitle: 'They receive an e-mail invitation to set their own password. You never see or set it.', submitText: 'Send invitation',
    fields: [{ name: 'full_name', label: 'Full name', required: true, rules: [rules.minLen(3)] }, { name: 'email', label: 'Work e-mail', type: 'email', required: true, rules: [rules.email] }, { name: 'phone', label: 'Mobile', type: 'tel', rules: [rules.phone] },
      { name: 'role_code', label: 'Role', type: 'select', required: true, options: roleList.filter((r) => r.rank >= myRank).map((r) => ({ value: r.code, label: r.name })), help: 'You can only assign roles at or below your own level.' },
      { name: 'city_scope', label: 'Limit to cities', type: 'multiselect', options: asOptions(cityList), help: 'Leave empty for all cities. Hold Ctrl / Cmd to choose several.' }, { name: 'branch_id', label: 'Branch', type: 'select', options: asOptions(branchList) },
      { name: 'mfa_required', label: 'Require two-factor authentication (recommended)', type: 'checkbox', value: true, full: true }],
    onSubmit: (v) => call({ action: 'create', full_name: v.full_name, email: v.email.toLowerCase(), phone: v.phone ? normalisePhone(v.phone) : null, role_code: v.role_code, city_scope: v.city_scope?.length ? v.city_scope : null, branch_id: v.branch_id, mfa_required: v.mfa_required, redirect_to: redirect() }) });
  if (ok) { invalidate('staff'); toast('success', 'Invitation sent. The account becomes usable once they set a password.', 8000); done(); }
}
async function openStaff(s, done) {
  const [roleList, cityList, branchList] = await Promise.all([roles(), cities(), branches()]);
  const m = openModal({ title: s.full_name, subtitle: `${s.employee_code} · ${s.email}`, size: 'lg', body: loadingState(), footer: '' }); const manage = can('staff.manage'), self = s.id === me()?.id;
  const [au, acts, logins] = await Promise.all([select('admin_users', '*', (q) => q.eq('staff_id', s.id)).catch(() => []), select('staff_activity', '*', (q) => q.eq('staff_id', s.id).order('created_at', { ascending: false }).limit(40)).catch(() => []), select('admin_activity_logs', 'event,created_at,ip,device_label,is_suspicious', (q) => q.eq('staff_id', s.id).order('created_at', { ascending: false }).limit(15)).catch(() => [])]);
  const a = au[0] ?? {}; const locked = a.locked_until && new Date(a.locked_until) > new Date();
  m.body.innerHTML = `${s.status !== 'active' ? notice('warning', `${titleCase(s.status)}:`, ` ${s.suspended_reason ?? ''}`) : ''}${locked ? notice('danger', 'Locked after failed sign-ins', ` until ${dateTime(a.locked_until)}.`) : ''}
    <div class="grid grid-2"><div>${dl([['Role', esc(nameMap(roleList)[s.role_id] ?? '—')], ['Status', badge(s.status)], ['Mobile', esc(s.phone ?? '—')], ['Branch', esc(nameMap(branchList)[s.branch_id] ?? '—')], ['City access', s.city_scope?.length ? esc(s.city_scope.map((c) => nameMap(cityList)[c] ?? '?').join(', ')) : 'All cities']])}</div>
    <div>${dl([['Two-factor required', a.mfa_required ? '<span class="badge success">Yes</span>' : '<span class="badge warning">No</span>'], ['Session timeout', a.session_timeout_min ? `${esc(a.session_timeout_min)} min of inactivity` : '—'], ['Last sign-in', a.last_login_at ? `${esc(dateTime(a.last_login_at))}` : 'Never'], ['Failed sign-ins', esc(a.failed_login_count ?? 0)], ['Joined', esc(date(s.created_at))]])}</div></div>
    <div class="grid grid-2" style="margin-top:14px"><div><h4 style="margin-bottom:10px">Attendance and activity</h4>${timeline(acts.map((x) => ({ title: esc(x.activity_type === 'action' ? x.summary ?? 'Action' : titleCase(x.activity_type)), text: x.activity_type === 'action' ? esc(titleCase(x.entity_type ?? '')) : '', time: dateTime(x.created_at), tone: x.activity_type === 'check_in' ? 'success' : '' })), 'No activity recorded.')}</div>
    <div><h4 style="margin-bottom:10px">Recent sign-in events</h4>${simpleTable([{ label: 'Event', render: (l) => `${esc(titleCase(l.event))}${l.is_suspicious ? ' <span class="badge danger">Suspicious</span>' : ''}` }, { label: 'When', render: (l) => esc(dateTime(l.created_at)) }, { label: 'IP', render: (l) => `<span class="mono">${esc(l.ip ?? '—')}</span>` }], logins, { icon: 'fa-right-to-bracket', title: 'No sign-in events visible', text: 'Needs the security.view permission.' })}</div></div>`;
  const A = [];
  if (manage && !self) { A.push(['edit', '', 'fa-pen', 'Change role / access']); if (s.status === 'active') A.push(['suspend', '', 'fa-pause', 'Suspend'], ['deactivate', 'btn-danger', 'fa-user-slash', 'Deactivate']); else A.push(['activate', 'btn-success', 'fa-rotate-left', 'Reactivate']); if (locked) A.push(['unlock', '', 'fa-unlock', 'Unlock']); A.push(['reset', '', 'fa-key', 'Send password reset'], ['signout', '', 'fa-right-from-bracket', 'Force sign-out']); }
  if (manage && self) A.push(['editself', '', 'fa-pen', 'Session settings']);
  m.foot.innerHTML = A.map((x) => `<button class="btn ${x[1]}" data-do="${x[0]}"><i class="fa-solid ${x[2]}"></i> ${x[3]}</button>`).join('') || `<span class="muted small">${self ? 'This is your own account. Another administrator must change your role or status.' : 'View only.'}</span>`;
  const myRank = roleList.find((r) => r.code === roleCode())?.rank ?? 99; const fin = (msg) => { invalidate('staff'); toast('success', msg); m.close(); done(); };
  const status = async (st, title, danger) => { const reason = st === 'active' ? null : await promptReason({ title, text: 'Their open sessions are ended immediately.', confirmText: 'Confirm', danger }); if (st !== 'active' && !reason) return; if (st === 'active' && !(await confirmDialog({ title: 'Reactivate this account?', confirmText: 'Reactivate' }))) return; await rpc('update_staff', { p_staff_id: s.id, p_status: st, p_reason: reason }); if (st !== 'active') await call({ action: 'force_sign_out', staff_id: s.id }).catch(() => {}); fin(`Account ${st === 'active' ? 'reactivated' : titleCase(st)}.`); };
  const act = {
    edit: async () => { const cur = roleList.find((r) => r.id === s.role_id); const ok = await formModal({ title: `Change access — ${s.full_name}`, size: 'lg', values: { role_code: cur?.code, city_scope: s.city_scope ?? [], branch_id: s.branch_id, mfa_required: !!a.mfa_required, session_timeout_min: a.session_timeout_min ?? 30 },
      fields: [{ name: 'role_code', label: 'Role', type: 'select', required: true, noBlank: true, options: roleList.filter((r) => r.rank >= myRank || r.code === cur?.code).map((r) => ({ value: r.code, label: r.name })) }, { name: 'branch_id', label: 'Branch', type: 'select', options: asOptions(branchList) }, { name: 'city_scope', label: 'Limit to cities', type: 'multiselect', options: asOptions(cityList), help: 'No selection = all cities.' },
        { name: 'session_timeout_min', label: 'Sign out after inactivity (minutes)', type: 'number', required: true, rules: [rules.integer, rules.min(5), rules.max(720)] }, { name: 'mfa_required', label: 'Require two-factor authentication', type: 'checkbox', full: true }, { name: 'reason', label: 'Reason for the change', type: 'textarea', required: true, rules: [rules.minLen(5)] }],
      onSubmit: (v) => rpc('update_staff', { p_staff_id: s.id, p_role_code: v.role_code !== cur?.code ? v.role_code : null, p_reason: v.reason, p_city_scope: v.city_scope?.length ? v.city_scope : null, p_clear_city_scope: !v.city_scope?.length, p_branch_id: v.branch_id, p_mfa_required: v.mfa_required, p_session_timeout_min: v.session_timeout_min }) }); if (ok) fin('Access updated. It applies from their next request.'); },
    editself: async () => { const ok = await formModal({ title: 'Your session settings', values: { session_timeout_min: a.session_timeout_min ?? 30, mfa_required: !!a.mfa_required }, fields: [{ name: 'session_timeout_min', label: 'Sign out after inactivity (minutes)', type: 'number', required: true, rules: [rules.integer, rules.min(5), rules.max(720)] }, { name: 'mfa_required', label: 'Require two-factor authentication', type: 'checkbox', full: true }], onSubmit: (v) => rpc('update_staff', { p_staff_id: s.id, p_mfa_required: v.mfa_required, p_session_timeout_min: v.session_timeout_min }) }); if (ok) fin('Saved.'); },
    suspend: () => status('suspended', `Suspend ${s.full_name}?`, false), deactivate: () => status('deactivated', `Deactivate ${s.full_name}?`, true), activate: () => status('active'),
    unlock: async () => { await rpc('update_staff', { p_staff_id: s.id, p_unlock: true }); fin('Account unlocked.'); },
    reset: async () => { if (!(await confirmDialog({ title: 'Send a password reset e-mail?', text: `A reset link is e-mailed to ${s.email}.`, confirmText: 'Send e-mail' }))) return; await call({ action: 'send_password_reset', staff_id: s.id, redirect_to: redirect() }); toast('success', 'Password reset e-mail sent.'); },
    signout: async () => { if (!(await confirmDialog({ title: 'Sign this person out everywhere?', text: 'All of their sessions end now. They can sign in again unless the account is suspended.', confirmText: 'Force sign-out', danger: true }))) return; await call({ action: 'force_sign_out', staff_id: s.id }); toast('success', 'All sessions ended.'); } };
  m.foot.querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => act[b.dataset.do]().catch(showError); });
}
async function staffPane(pane) {
  const [roleList, branchList] = await Promise.all([roles(), branches()]);
  const t = dataTable(pane, { search: { placeholder: 'Name, employee ID or e-mail…' }, filters: [{ name: 'role_id', label: 'All roles', options: asOptions(roleList) }, { name: 'status', label: 'All statuses', options: ['active', 'suspended', 'deactivated'] }, { name: 'branch_id', label: 'All branches', options: asOptions(branchList) }],
    toolbar: [{ label: 'Add staff member', icon: 'fa-user-plus', primary: true, perm: 'staff.manage', onClick: () => addStaff(() => t.reload()) }],
    columns: [{ label: 'Staff member', sort: 'full_name', render: (s) => `<div class="cell-main">${esc(s.full_name)}${s.id === me()?.id ? ' <span class="badge info">You</span>' : ''}</div><div class="cell-sub mono">${esc(s.employee_code)}</div>` }, { label: 'E-mail', render: (s) => esc(s.email) }, { label: 'Role', render: (s) => esc(nameMap(roleList)[s.role_id] ?? '—') }, { label: 'Branch', render: (s) => esc(nameMap(branchList)[s.branch_id] ?? '—') },
      { label: 'Two-factor', render: (s) => (s.au?.mfa_required ? '<span class="badge success">Required</span>' : '<span class="badge warning">Optional</span>') }, { label: 'Last sign-in', render: (s) => (s.au?.last_login_at ? esc(ago(s.au.last_login_at)) : '<span class="muted">Never</span>') }, { label: 'Status', render: (s) => badge(s.status) + (s.au?.locked_until && new Date(s.au.locked_until) > new Date() ? ' <span class="badge danger">Locked</span>' : '') }],
    load: async (s) => { const r = await list('staff_accounts', { search: s.search, searchColumns: ['full_name', 'employee_code', 'email'], filters: s.filters, order: s.sort ?? 'full_name', ascending: s.sort ? s.ascending : true, page: s.page, pageSize: s.pageSize }); await attach(r.rows, 'id', 'admin_users', 'staff_id,mfa_required,last_login_at,locked_until', 'au', 'staff_id'); return r; },
    onRowClick: (s) => openStaff(s, () => t.reload()), empty: { icon: 'fa-user-tie', title: 'No staff accounts' } });
}
async function rolesPane(pane) {
  const render = async () => {
    pane.innerHTML = loadingState();
    try {
      const [roleList, perms, rp] = await Promise.all([roles(true), select('permissions', '*', (q) => q.order('module').order('code')), select('role_permissions', 'role_id,permission_code')]);
      const has = new Set(rp.map((x) => `${x.role_id}:${x.permission_code}`)); const myRank = roleList.find((r) => r.code === roleCode())?.rank ?? 99; const canEdit = can('staff.roles');
      const editable = (r) => canEdit && r.code !== 'super_admin' && r.rank > myRank; const modules = [...new Set(perms.map((p) => p.module))];
      pane.innerHTML = `${notice('info', 'Permission matrix', ' A tick grants that ability to everyone with the role. Changes apply immediately and are written to the audit log. Super Admin always has every permission. You can only change roles below your own level.')}
        <section class="card"><div class="table-wrap"><table class="table matrix"><thead><tr><th>Permission</th>${roleList.map((r) => `<th title="${esc(r.description ?? '')}">${esc(r.name)}</th>`).join('')}</tr></thead><tbody>
        ${modules.map((mod) => `<tr class="group"><td colspan="${roleList.length + 1}"><strong>${esc(titleCase(mod))}</strong></td></tr>${perms.filter((p) => p.module === mod).map((p) => `<tr><td><div class="cell-main">${esc(p.description ?? p.code)} ${p.is_sensitive ? '<span class="badge warning" title="Sensitive: money, personal data or security">Sensitive</span>' : ''}</div><div class="cell-sub mono">${esc(p.code)}</div></td>${roleList.map((r) => `<td style="text-align:center"><input type="checkbox" aria-label="${esc(r.name)}: ${esc(p.code)}" data-role="${esc(r.code)}" data-perm-code="${esc(p.code)}" ${r.code === 'super_admin' || has.has(`${r.id}:${p.code}`) ? 'checked' : ''} ${editable(r) ? '' : 'disabled'}></td>`).join('')}</tr>`).join('')}`).join('')}</tbody></table></div></section>`;
      pane.querySelectorAll('input[data-role]').forEach((cb) => { cb.onchange = async () => { const grant = cb.checked; const p = perms.find((x) => x.code === cb.dataset.permCode); cb.disabled = true;
        try { if (grant && p?.is_sensitive && !(await confirmDialog({ title: 'Grant a sensitive permission?', text: `“${p.description ?? p.code}” will be available to every ${roleList.find((r) => r.code === cb.dataset.role)?.name}.`, confirmText: 'Grant' }))) { cb.checked = false; return; }
          await rpc('set_role_permission', { p_role_code: cb.dataset.role, p_permission: cb.dataset.permCode, p_grant: grant }); toast('success', `Permission ${grant ? 'granted' : 'removed'}.`, 2500); } catch (e) { cb.checked = !grant; showError(e); } finally { cb.disabled = false; } }; });
    } catch (e) { pane.innerHTML = errorState(e); }
  };
  await render();
}
function attendancePane(pane) {
  dataTable(pane, { search: false, filters: [{ name: 'activity_type', label: 'Check-in and check-out', options: [{ value: 'check_in', label: 'Check-in only' }, { value: 'check_out', label: 'Check-out only' }, { value: 'action', label: 'Recorded actions' }] }, { name: 'from', label: 'From date', type: 'date' }, { name: 'to', label: 'To date', type: 'date' }],
    columns: [{ label: 'When', render: (a) => esc(dateTime(a.created_at)) }, { label: 'Staff member', render: (a) => esc(a.staff?.full_name ?? '—') }, { label: 'Activity', render: (a) => badge(a.activity_type, a.activity_type === 'check_in' ? 'success' : a.activity_type === 'check_out' ? '' : 'info') }, { label: 'Details', render: (a) => esc(a.summary ?? '—') }],
    load: async (s) => { const { from, to, activity_type } = s.filters; const r = await list('staff_activity', { page: s.page, pageSize: s.pageSize, apply: (q) => { q = activity_type ? q.eq('activity_type', activity_type) : q.in('activity_type', ['check_in', 'check_out']); if (from) q = q.gte('created_at', `${from}T00:00:00`); if (to) q = q.lte('created_at', `${to}T23:59:59.999`); return q; } }); await attach(r.rows, 'staff_id', 'staff_accounts', 'id,full_name', 'staff'); return r; },
    empty: { icon: 'fa-calendar-check', title: 'No attendance recorded', text: 'Staff check in and out from the profile menu at the top right.' } });
}
export async function init(root, { params, setParams }) {
  const tb = tabs(root.querySelector('#staff-tabs'), [{ id: 'staff', label: 'Staff', icon: 'fa-user-tie', render: staffPane }, { id: 'roles', label: 'Roles & permissions', icon: 'fa-user-shield', render: rolesPane }, { id: 'attendance', label: 'Attendance & activity', icon: 'fa-calendar-check', render: attendancePane }], { initial: params.tab, onChange: (id) => setParams({ tab: id }) });
  return () => tb.destroy();
}
