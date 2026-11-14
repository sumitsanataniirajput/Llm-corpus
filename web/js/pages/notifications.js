// Module 13 — Notifications: compose, history with delivery results, templates.
import { rpc, fn, toAppError } from '../supabase-client.js';
import { list, select, insert, update, remove, cities, asOptions, nameMap, staffList } from '../api.js';
import { dataTable, tabs, badge, formModal, confirmDialog, toast, showError, simpleTable, openModal, loadingState, errorState, notice, formHtml, readFields, showFieldErrors, withBusy, dl } from '../components.js';
import { esc, dateTime, titleCase, number } from '../utilities.js';
import { can } from '../permissions.js';
import { rules, validate } from '../validation.js';
import { pickDriver, pickCustomer, attach } from './shared.js';
import { pushSupported, pushConfigured, enablePush } from '../notifications.js';

const AUD = [['all_drivers', 'All drivers'], ['all_customers', 'All customers'], ['all_staff', 'All staff'], ['driver', 'One driver'], ['customer', 'One customer'], ['staff', 'One staff member']];
const CATS = ['announcement', 'booking', 'payment', 'document', 'approval', 'otp', 'tracking', 'system', 'support', 'security', 'emergency'];
const DSTAT = { pending: 'warning', dispatched: 'success', partial: 'warning', failed: 'danger', in_app_only: 'info' };

async function composePane(pane) {
  const [cityList, templates, staff] = await Promise.all([cities(), select('notification_templates', '*', (q) => q.eq('is_active', true).order('code')).catch(() => []), staffList().catch(() => [])]);
  const canSend = can('notifications.send'), canEmergency = can('notifications.emergency'); let recipient = null;
  if (!canSend && !canEmergency) { pane.innerHTML = notice('info', 'View only.', ' Your role cannot send notifications.'); return; }
  const fields = [{ name: 'template', label: 'Start from a template (optional)', type: 'select', blank: 'No template', options: templates.map((t) => ({ value: t.id, label: `${t.code} (${t.channel})` })), full: true },
    { name: 'audience', label: 'Send to', type: 'select', required: true, noBlank: true, options: AUD.map(([value, label]) => ({ value, label })) }, { name: 'staff_id', label: 'Staff member', type: 'select', showIf: (v) => v.audience === 'staff', options: asOptions(staff.filter((s) => s.status === 'active'), 'full_name') },
    { name: 'city_id', label: 'Only in city', type: 'select', blank: 'All cities', options: asOptions(cityList), showIf: (v) => ['all_drivers', 'all_customers'].includes(v.audience) },
    { name: 'category', label: 'Category', type: 'select', required: true, noBlank: true, options: CATS, value: 'announcement' }, { name: 'priority', label: 'Priority', type: 'select', required: true, noBlank: true, options: [{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }, ...(canEmergency ? [{ value: 'emergency', label: 'EMERGENCY' }] : [])] },
    { name: 'title', label: 'Title', required: true, full: true, rules: [rules.minLen(3), rules.maxLen(100)] }, { name: 'body', label: 'Message', type: 'textarea', required: true, rules: [rules.minLen(3), rules.maxLen(1000)] },
    { name: 'ch_push', label: 'Push notification (phone / browser)', type: 'checkbox', value: true }, { name: 'ch_sms', label: 'SMS (costs money per message)', type: 'checkbox' }];
  pane.innerHTML = `<div class="grid grid-2-1"><section class="card"><div class="card-head"><h3><i class="fa-solid fa-paper-plane"></i>Send a notification</h3></div><div class="card-body"><form novalidate>${formHtml(fields)}</form>
    <div class="row" data-rec hidden style="margin-top:8px"><button type="button" class="btn btn-sm" data-pick>Choose recipient</button><span data-recname class="muted">None chosen</span></div><div class="form-error" role="alert" hidden></div><div class="row" style="margin-top:14px"><button class="btn btn-primary" data-send><i class="fa-solid fa-paper-plane"></i> Send</button></div></div></section>
    <section class="card"><div class="card-head"><h3><i class="fa-solid fa-circle-info"></i>How delivery works</h3></div><div class="card-body"><ul class="muted" style="padding-left:18px;margin:0;line-height:1.7"><li>Every message is saved and shown inside the apps (in-app).</li><li><strong>Push</strong> needs Firebase to be configured on the server, and the person must have the app installed with notifications allowed.</li><li><strong>SMS</strong> needs an SMS provider and an approved DLT template. Bulk SMS is not sent from here.</li><li>The History tab shows the real result for each channel — including “not configured”.</li></ul>
      <hr style="border:0;border-top:1px solid var(--border);margin:14px 0"><h4 style="margin-bottom:6px">Alerts in this browser</h4><p class="muted small" data-pushinfo></p><button class="btn btn-sm" data-enable hidden>Enable browser alerts</button></div></section></div>`;
  const form = pane.querySelector('form'), err = pane.querySelector('.form-error'), rec = pane.querySelector('[data-rec]');
  const sync = () => { const v = readFields(form, fields); for (const f of fields) if (f.showIf) form.querySelector(`.field[data-field="${f.name}"]`).hidden = !f.showIf(v); rec.hidden = !['driver', 'customer'].includes(v.audience); };
  form.addEventListener('change', (e) => { if (e.target.name === 'audience') { recipient = null; pane.querySelector('[data-recname]').textContent = 'None chosen'; } if (e.target.name === 'template') { const t = templates.find((x) => x.id === e.target.value); if (t) { form.querySelector('[name="title"]').value = t.title ?? ''; form.querySelector('[name="body"]').value = t.body; } } sync(); }); sync();
  pane.querySelector('[data-pick]').onclick = async () => { const a = form.querySelector('[name="audience"]').value; const r = a === 'driver' ? await pickDriver() : await pickCustomer(); if (r) { recipient = r; pane.querySelector('[data-recname]').innerHTML = `<strong>${esc(r.full_name)}</strong>`; } };
  const info = pane.querySelector('[data-pushinfo]'), en = pane.querySelector('[data-enable]');
  if (!pushSupported()) info.textContent = 'This browser does not support push notifications. Alerts still appear in the bell menu while the console is open.';
  else if (!pushConfigured()) info.textContent = 'Browser push is not configured (FIREBASE settings are empty in js/config.js). Alerts still appear in the bell menu while the console is open.';
  else if (Notification.permission === 'granted') info.textContent = 'Browser alerts are enabled on this device.';
  else { info.textContent = 'Get emergency and booking alerts on this device even when the console tab is in the background.'; en.hidden = false; en.onclick = () => withBusy(en, async () => { try { await enablePush(); info.textContent = 'Browser alerts are enabled on this device.'; en.hidden = true; } catch (e) { showError(e); } }); }
  pane.querySelector('[data-send]').onclick = (e) => withBusy(e.currentTarget, async () => {
    err.hidden = true; const v = readFields(form, fields); const res = validate(fields, v); showFieldErrors(form, res.errors); if (!res.ok) return;
    const single = ['driver', 'customer', 'staff'].includes(v.audience); const rid = v.audience === 'staff' ? v.staff_id : recipient?.id;
    if (single && !rid) { err.textContent = 'Choose who should receive this message.'; err.hidden = false; return; }
    if (v.priority === 'emergency' && !canEmergency) { err.textContent = 'Your role cannot send emergency notifications.'; err.hidden = false; return; }
    if (v.ch_sms && !single) { err.textContent = 'SMS can only be sent to one person from here. Untick SMS for broadcasts.'; err.hidden = false; return; }
    const who = single ? (v.audience === 'staff' ? 'the selected staff member' : recipient.full_name) : AUD.find((a) => a[0] === v.audience)[1].toLowerCase();
    if (!(await confirmDialog({ title: v.priority === 'emergency' ? 'Send EMERGENCY notification?' : 'Send notification?', text: `“${v.title}” will be sent to ${who}. It cannot be recalled.`, confirmText: 'Send now', danger: v.priority === 'emergency' }))) return;
    try {
      const channels = ['in_app', ...(v.ch_push ? ['push'] : []), ...(v.ch_sms ? ['sms'] : [])];
      const id = await rpc('send_notification', { p_audience: v.audience, p_title: v.title, p_body: v.body, p_category: v.category, p_priority: v.priority, p_channels: channels, p_recipient_id: single ? rid : null, p_city_id: single ? null : v.city_id });
      let note = 'Saved and visible in the app.';
      if (channels.length > 1) { try { const r = await fn('notify', { notification_id: id }); note = r?.dispatch_status === 'dispatched' ? 'Delivered to the push/SMS provider.' : `Saved in-app. Other channels: ${titleCase(r?.dispatch_status ?? 'pending')} — see History for details.`; } catch (ex) { note = `Saved in-app. Push/SMS was not sent: ${toAppError(ex).message}`; } }
      toast('success', note, 8000); form.querySelector('[name="title"]').value = ''; form.querySelector('[name="body"]').value = '';
    } catch (ex) { err.textContent = toAppError(ex).message; err.hidden = false; }
  });
}
function historyPane(pane) {
  const t = dataTable(pane, { search: { placeholder: 'Title or message…' }, filters: [{ name: 'audience', label: 'All audiences', options: AUD.map(([value, label]) => ({ value, label })) }, { name: 'category', label: 'All categories', options: CATS }, { name: 'priority', label: 'Any priority', options: ['normal', 'high', 'emergency'] }, { name: 'dispatch_status', label: 'Any delivery', options: Object.keys(DSTAT) }],
    columns: [{ label: 'Sent', render: (n) => esc(dateTime(n.created_at)) }, { label: 'Message', render: (n) => `<div style="max-width:420px"><div class="cell-main">${n.priority === 'emergency' ? '<span class="badge solid-danger">Emergency</span> ' : ''}${esc(n.title)}</div><div class="cell-sub">${esc(n.body)}</div></div>` }, { label: 'To', render: (n) => esc(AUD.find((a) => a[0] === n.audience)?.[1] ?? titleCase(n.audience)) }, { label: 'Category', render: (n) => badge(n.category, 'info') },
      { label: 'Channels', render: (n) => (n.channels ?? []).map((c) => `<span class="badge">${esc(titleCase(c))}</span>`).join(' ') }, { label: 'Delivery', render: (n) => `<span class="badge ${DSTAT[n.dispatch_status] ?? ''}">${esc(n.dispatch_status === 'in_app_only' ? 'In-app only' : titleCase(n.dispatch_status))}</span>` }],
    load: (s) => list('notifications', { search: s.search, searchColumns: ['title', 'body'], filters: s.filters, page: s.page, pageSize: s.pageSize }),
    rowActions: (n) => [{ icon: 'fa-list-check', title: 'Delivery details', onClick: async () => { const m = openModal({ title: 'Delivery details', subtitle: n.title, footer: null, body: loadingState() }); try { const logs = await select('notification_delivery_logs', '*', (q) => q.eq('notification_id', n.id).order('created_at'));
        m.body.innerHTML = simpleTable([{ label: 'Channel', render: (l) => esc(titleCase(l.channel)) }, { label: 'Provider', render: (l) => esc(l.provider ?? '—') }, { label: 'Result', render: (l) => badge(l.status, l.status === 'not_configured' ? 'warning' : null) }, { label: 'Recipients', cls: 'num', render: (l) => number(l.recipients_count) }, { label: 'Detail', render: (l) => esc(l.error ?? '—') }, { label: 'When', render: (l) => esc(dateTime(l.created_at)) }], logs, { icon: 'fa-inbox', title: 'In-app only', text: 'No push or SMS delivery was attempted for this message.' }); } catch (e) { m.body.innerHTML = errorState(e); } } },
      n.dispatch_status === 'pending' && { icon: 'fa-paper-plane', title: 'Dispatch now', perm: 'notifications.send', onClick: async () => { const r = await fn('notify', { notification_id: n.id }); toast('info', `Delivery: ${titleCase(r?.dispatch_status ?? 'unknown')}`); t.reload(); } }],
    empty: { icon: 'fa-bell', title: 'No notifications sent yet' } });
}
function templatesPane(pane) {
  const F = (t) => [{ name: 'code', label: 'Code', required: true, disabled: !!t, rules: [(v) => (/^[a-z][a-z0-9_]{2,40}$/.test(v ?? '') ? null : 'Lower-case letters, digits, underscores')] }, { name: 'channel', label: 'Channel', type: 'select', required: true, noBlank: true, options: ['push', 'sms', 'in_app', 'email', 'whatsapp'] }, { name: 'title', label: 'Title', full: true, rules: [rules.maxLen(100)] },
    { name: 'body', label: 'Message', type: 'textarea', required: true, rules: [rules.minLen(3), rules.maxLen(1000)], help: 'Placeholders such as {{name}} or {{otp}} are filled in by the server.' }, { name: 'dlt_template_id', label: 'DLT template ID (SMS in India)', help: 'Required by Indian telecom rules for SMS. Get it from your SMS provider.' }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const t = dataTable(pane, { search: { placeholder: 'Template code…' }, filters: [{ name: 'channel', label: 'All channels', options: ['push', 'sms', 'in_app', 'email', 'whatsapp'] }],
    toolbar: [{ label: 'New template', icon: 'fa-plus', primary: true, perm: 'notifications.templates', onClick: async () => { if (await formModal({ title: 'New template', size: 'lg', values: { channel: 'push', is_active: true }, fields: F(null), onSubmit: (v) => insert('notification_templates', v) })) { toast('success', 'Template saved.'); t.reload(); } } }],
    columns: [{ label: 'Code', render: (x) => `<span class="mono cell-main">${esc(x.code)}</span>` }, { label: 'Channel', render: (x) => badge(x.channel, 'info') }, { label: 'Content', render: (x) => `<div style="max-width:480px"><div class="cell-main">${esc(x.title ?? '')}</div><div class="cell-sub">${esc(x.body)}</div></div>` }, { label: 'DLT ID', render: (x) => `<span class="mono">${esc(x.dlt_template_id ?? '—')}</span>` }, { label: 'Active', render: (x) => (x.is_active ? '<span class="badge success">Yes</span>' : '<span class="badge">No</span>') }],
    load: (s) => list('notification_templates', { search: s.search, searchColumns: ['code', 'title', 'body'], filters: s.filters, order: 'code', ascending: true, page: s.page, pageSize: s.pageSize }),
    rowActions: (x) => [{ icon: 'fa-pen', title: 'Edit', perm: 'notifications.templates', onClick: async () => { if (await formModal({ title: `Edit ${x.code}`, size: 'lg', values: x, fields: F(x), onSubmit: ({ code, ...v }) => update('notification_templates', x.id, v) })) { toast('success', 'Template updated.'); t.reload(); } } }, { icon: 'fa-trash', title: 'Delete', perm: 'notifications.templates', onClick: async () => { if (await confirmDialog({ title: `Delete template ${x.code}?`, confirmText: 'Delete', danger: true })) { await remove('notification_templates', x.id); t.reload(); } } }],
    empty: { icon: 'fa-file-lines', title: 'No templates', text: 'Templates save typing for messages you send often.' } });
}
export async function init(root, { params, setParams }) {
  const tb = tabs(root.querySelector('#notifications-tabs'), [{ id: 'compose', label: 'Send', icon: 'fa-paper-plane', render: composePane }, { id: 'history', label: 'History', icon: 'fa-clock-rotate-left', render: historyPane }, { id: 'templates', label: 'Templates', icon: 'fa-file-lines', render: templatesPane }], { initial: params.tab, onChange: (id) => setParams({ tab: id }) });
  return () => tb.destroy();
}
