// Module 18 — Settings. Every value is stored in system_settings and changed through update_setting(),
// which checks permission, keeps the value type and writes settings_history. Secrets are never stored here:
// provider keys live in Supabase Edge Function secrets, and this page only shows whether they are present.
import { rpc, fn, toAppError } from '../supabase-client.js';
import { list, select, update, uploadFile, publicUrl, staffList, nameMap } from '../api.js';
import { dataTable, tabs, badge, confirmDialog, toast, showError, loadingState, errorState, notice, withBusy, yesNo } from '../components.js';
import { esc, dateTime, ago, titleCase, number } from '../utilities.js';
import { can } from '../permissions.js';
import { validateFile } from '../validation.js';
import { DRIVER_DOCS, docLabel } from './shared.js';

// Friendly labels, units and safe ranges. Keys not listed here still appear, using their database description.
const META = {
  'brand.app_name': { label: 'Application name', max: 40 }, 'brand.logo_url': { label: 'Logo', kind: 'logo' }, 'brand.primary_color': { label: 'Brand colour', kind: 'color' }, 'brand.support_phone': { label: 'Support phone number', max: 20 },
  'system.maintenance_mode': { label: 'Maintenance mode', danger: 'Drivers and customers will see a maintenance notice and cannot book rides.' }, 'system.maintenance_message': { label: 'Maintenance message', kind: 'textarea', max: 300 }, 'system.global_announcement': { label: 'Console banner (empty = none)', kind: 'textarea', max: 300 },
  'otp.length': { label: 'OTP digits', min: 4, max: 8, int: true }, 'otp.expiry_seconds': { label: 'OTP valid for', unit: 'seconds', min: 60, max: 1800, int: true }, 'otp.max_attempts': { label: 'Wrong attempts before lockout', min: 3, max: 10, int: true }, 'otp.lockout_minutes': { label: 'Lockout length', unit: 'minutes', min: 1, max: 1440, int: true },
  'otp.max_resends': { label: 'Maximum resends per ride', min: 0, max: 10, int: true }, 'otp.resend_gap_seconds': { label: 'Wait between resends', unit: 'seconds', min: 10, max: 600, int: true }, 'otp.distance_tolerance_km': { label: 'Distance confirmation tolerance', unit: 'km', min: 0, max: 5 },
  'otp.block_on_distance_mismatch': { label: 'Block OTP when the confirmed distance does not match' }, 'otp.max_overrides_per_staff_per_day': { label: 'Manager overrides per person per day', min: 0, max: 50, int: true },
  'rides.road_distance_factor': { label: 'Road distance factor (fallback estimate)', min: 1, max: 2.5 }, 'rides.max_distance_km': { label: 'Longest bookable trip', unit: 'km', min: 1, max: 3000 }, 'rides.billing_distance_policy': { label: 'Distance used for the final fare', options: [['actual', 'Distance actually travelled (GPS)'], ['booked', 'Distance quoted at booking'], ['max', 'Whichever is greater']] }, 'rides.distance_discrepancy_pct': { label: 'Flag a discrepancy above', unit: '% difference', min: 1, max: 200 },
  'tracking.live_seconds': { label: 'Position counts as live for', unit: 'seconds', min: 10, max: 600, int: true }, 'tracking.stale_seconds': { label: 'Position counts as stale after', unit: 'seconds', min: 30, max: 3600, int: true }, 'tracking.interval_on_ride_seconds': { label: 'GPS interval during a ride', unit: 'seconds', min: 3, max: 60, int: true }, 'tracking.interval_idle_seconds': { label: 'GPS interval while waiting', unit: 'seconds', min: 5, max: 300, int: true }, 'tracking.overspeed_kmh': { label: 'Overspeed alert above', unit: 'km/h', min: 30, max: 200 },
  'security.max_failed_logins': { label: 'Failed sign-ins before lock', min: 3, max: 20, int: true }, 'security.lockout_minutes': { label: 'Console lockout length', unit: 'minutes', min: 1, max: 1440, int: true },
  'finance.allow_self_approval': { label: 'Allow one person to create and approve the same payout', danger: 'Turning this on removes the two-person check on driver payouts.' },
  'fraud.customer_cancellations_7d': { label: 'Customer cancellations in 7 days', min: 1, max: 100, int: true }, 'fraud.customer_failed_payments_7d': { label: 'Customer failed payments in 7 days', min: 1, max: 100, int: true }, 'fraud.driver_cash_dues_alert_paise': { label: 'Driver cash dues alert', kind: 'money' },
  'feature.ai_assistant': { label: 'AI assistant (optional, needs an AI key)' }, 'feature.auto_assignment': { label: 'One-click automatic driver allocation' }, 'feature.wallet_payments': { label: 'Customer wallet payments' }, 'feature.scheduled_rides': { label: 'Scheduled rides (book for later)' },
  'privacy.policy_version': { label: 'Privacy policy version', max: 20 }, 'drivers.required_documents': { label: 'Documents required before a driver can be approved', kind: 'docs' },
};
const GROUPS = { general: [['branding', 'Branding'], ['system', 'System'], ['privacy', 'Privacy']], rides: [['rides', 'Rides and billing'], ['otp', 'Ride OTP'], ['tracking', 'Live tracking']], drivers: [['drivers', 'Driver onboarding']], finance: [['finance', 'Finance controls'], ['fraud', 'Fraud thresholds']], security: [['security', 'Console sign-in']], features: [['feature', 'Feature switches']] };
const SECRET_HELP = { sms: 'SMS_PROVIDER plus that provider’s keys (see SETUP.md)', payment: 'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET', maps: 'GOOGLE_MAPS_SERVER_KEY (and GOOGLE_MAPS_API_KEY in web/js/config.js)', push: 'FIREBASE_SERVICE_ACCOUNT', email: 'RESEND_API_KEY, EMAIL_FROM', whatsapp: 'WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID', ai: 'AI_API_KEY (optional AI_BASE_URL, AI_MODEL)', cache: 'UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN' };

function control(s, ro) {
  const m = META[s.key] ?? {}, v = s.value, id = `set-${s.key.replace(/\W/g, '-')}`, dis = ro ? 'disabled' : '';
  if (m.kind === 'docs') return DRIVER_DOCS.map((d) => `<label class="check"><input type="checkbox" data-key="${esc(s.key)}" data-doc="${esc(d)}" ${Array.isArray(v) && v.includes(d) ? 'checked' : ''} ${dis}> ${esc(docLabel(d))}</label>`).join('');
  if (typeof v === 'boolean') return `<label class="check"><input type="checkbox" id="${id}" data-key="${esc(s.key)}" ${v ? 'checked' : ''} ${dis}> Enabled</label>`;
  if (m.options) return `<select class="select" id="${id}" data-key="${esc(s.key)}" ${dis}>${m.options.map(([val, l]) => `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  if (m.kind === 'money') return `<div class="row" style="gap:8px"><input class="input" id="${id}" data-key="${esc(s.key)}" type="number" min="0" step="1" value="${esc(Math.round(Number(v) / 100))}" ${dis} style="max-width:180px"><span class="muted">rupees</span></div>`;
  if (typeof v === 'number') return `<div class="row" style="gap:8px"><input class="input" id="${id}" data-key="${esc(s.key)}" type="number" step="${m.int ? 1 : 'any'}" ${m.min !== undefined ? `min="${m.min}"` : ''} ${m.max !== undefined ? `max="${m.max}"` : ''} value="${esc(v)}" ${dis} style="max-width:180px"><span class="muted">${esc(m.unit ?? '')}</span></div>`;
  if (m.kind === 'color') return `<input id="${id}" data-key="${esc(s.key)}" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(v) ? v : '#2563eb')}" ${dis} style="width:64px;height:36px;padding:2px;border:1px solid var(--border);border-radius:8px;background:transparent">`;
  if (m.kind === 'logo') return `<div class="row" style="gap:12px;align-items:center">${v ? `<img src="${esc(v)}" alt="Current logo" style="height:40px;max-width:160px;object-fit:contain;border:1px solid var(--border);border-radius:8px;padding:4px;background:#fff">` : '<span class="muted">No logo uploaded</span>'}<input type="hidden" data-key="${esc(s.key)}" value="${esc(v ?? '')}">${ro ? '' : `<input type="file" data-logo accept="image/png,image/jpeg,image/webp,image/svg+xml" aria-label="Upload logo">${v ? '<button type="button" class="btn btn-sm" data-logo-clear>Remove</button>' : ''}`}</div><div class="field-help">PNG, JPG, WebP or SVG up to 2 MB.</div>`;
  if (typeof v === 'string') return m.kind === 'textarea' ? `<textarea class="textarea" id="${id}" data-key="${esc(s.key)}" rows="2" maxlength="${m.max ?? 500}" ${dis}>${esc(v)}</textarea>` : `<input class="input" id="${id}" data-key="${esc(s.key)}" maxlength="${m.max ?? 200}" value="${esc(v)}" ${dis}>`;
  return `<textarea class="textarea mono" id="${id}" data-key="${esc(s.key)}" data-json rows="3" ${dis}>${esc(JSON.stringify(v))}</textarea>`;
}
/** Read one setting's new value from the pane; throws a readable Error when invalid. */
function readValue(pane, s) {
  const m = META[s.key] ?? {}, label = m.label ?? s.key;
  if (m.kind === 'docs') return [...pane.querySelectorAll(`[data-key="${s.key}"][data-doc]:checked`)].map((c) => c.dataset.doc);
  const el = pane.querySelector(`[data-key="${s.key}"]`); if (!el) return s.value;
  if (typeof s.value === 'boolean') return el.checked;
  if (m.kind === 'money') { const n = Number(el.value); if (el.value === '' || !(n >= 0) || !Number.isInteger(n)) throw new Error(`${label}: enter a whole rupee amount.`); return n * 100; }
  if (typeof s.value === 'number') { const n = Number(el.value); if (el.value === '' || !Number.isFinite(n)) throw new Error(`${label}: enter a number.`); if (m.int && !Number.isInteger(n)) throw new Error(`${label}: must be a whole number.`); if (m.min !== undefined && n < m.min) throw new Error(`${label}: must be ${m.min} or more.`); if (m.max !== undefined && n > m.max) throw new Error(`${label}: must be ${m.max} or less.`); return n; }
  if (el.dataset.json !== undefined) { try { return JSON.parse(el.value); } catch { throw new Error(`${label}: not valid JSON.`); } }
  return String(el.value).trim();
}
const groupPane = (group) => async (pane) => {
  const cats = GROUPS[group];
  const render = async () => {
    pane.innerHTML = loadingState(); let rows;
    try { rows = await select('system_settings', '*', (q) => q.in('category', cats.map((c) => c[0])).order('key')); } catch (e) { pane.innerHTML = errorState(e); return; }
    const editable = (s) => can('settings.manage') && (s.category !== 'security' || can('security.manage')); const any = rows.some(editable);
    pane.innerHTML = `${any ? '' : notice('info', 'View only.', ' Your role cannot change these settings.')}${group === 'security' ? notice('info', 'More security controls', ' — sessions, IP rules, API keys and the audit trail — are on the <a href="#/security">Security</a> page. Two-factor authentication is set per staff member on the <a href="#/staff">Staff</a> page.') : ''}
      ${group === 'features' ? notice('info', 'Feature switches', ' only turn a capability on or off. The AI assistant also needs an AI key in Supabase secrets, and wallet payments need a payment gateway — see the Integrations tab.') : ''}
      ${cats.map(([cat, title]) => { const list_ = rows.filter((s) => s.category === cat); return list_.length ? `<section class="card" style="margin-bottom:16px"><div class="card-head"><h3>${esc(title)}</h3></div><div class="card-body">${list_.map((s) => `<div class="field" style="margin-bottom:14px"><label for="set-${esc(s.key.replace(/\W/g, '-'))}">${esc(META[s.key]?.label ?? titleCase(s.key.split('.').pop()))}</label>${control(s, !editable(s))}${META[s.key]?.kind === 'logo' ? '' : `<div class="field-help">${esc(s.description ?? '')}</div>`}</div>`).join('')}</div></section>` : ''; }).join('')}
      ${any ? `<div class="card"><div class="card-body"><div class="field"><label for="set-reason-${group}">Reason for the change (recorded in the history)</label><input class="input" id="set-reason-${group}" data-reason maxlength="200"></div><div class="form-error" role="alert" hidden></div><div class="row" style="margin-top:10px"><button class="btn btn-primary" data-save><i class="fa-solid fa-floppy-disk"></i> Save changes</button></div></div></div>` : ''}`;
    const err = pane.querySelector('.form-error');
    pane.querySelector('[data-logo-clear]')?.addEventListener('click', () => { pane.querySelector('[data-key="brand.logo_url"]').value = ''; toast('info', 'Logo will be removed when you save.'); });
    pane.querySelector('[data-logo]')?.addEventListener('change', async (e) => { const file = e.target.files[0]; if (!file) return; const bad = validateFile(file, { maxMb: 2, types: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] }); if (bad) { toast('error', bad); e.target.value = ''; return; }
      try { const path = await uploadFile('branding', 'logo', file); pane.querySelector('[data-key="brand.logo_url"]').value = publicUrl('branding', path); toast('info', 'Logo uploaded. Click “Save changes” to use it.'); } catch (ex) { showError(ex); e.target.value = ''; } });
    pane.querySelector('[data-save]')?.addEventListener('click', (ev) => withBusy(ev.currentTarget, async () => {
      err.hidden = true; const changes = [];
      try { for (const s of rows.filter(editable)) { const nv = readValue(pane, s); if (JSON.stringify(nv) !== JSON.stringify(s.value)) changes.push([s, nv]); } } catch (e) { err.textContent = e.message; err.hidden = false; return; }
      if (!changes.length) { toast('info', 'Nothing was changed.'); return; }
      const get = (k) => changes.find((c) => c[0].key === k)?.[1] ?? rows.find((r) => r.key === k)?.value;
      if (group === 'rides' && Number(get('tracking.stale_seconds')) <= Number(get('tracking.live_seconds'))) { err.textContent = '“Stale after” must be longer than “live for”.'; err.hidden = false; return; }
      const docs = changes.find((c) => c[0].key === 'drivers.required_documents'); if (docs && !docs[1].length && !(await confirmDialog({ title: 'Require no documents?', text: 'Drivers could then be approved without any verified document.', confirmText: 'Save anyway', danger: true }))) return;
      for (const [s, nv] of changes) { const d = META[s.key]?.danger; if (d && nv === true && !(await confirmDialog({ title: `Turn on “${META[s.key].label}”?`, text: d, confirmText: 'Turn on', danger: true }))) return; }
      const reason = pane.querySelector('[data-reason]').value.trim() || null; let done = 0;
      try { for (const [s, nv] of changes) { await rpc('update_setting', { p_key: s.key, p_value: nv, p_reason: reason }); done += 1; } toast('success', `${done} setting(s) saved.${group === 'general' ? ' Reload the page to see branding changes.' : ''}`); render(); }
      catch (e) { err.textContent = `${done} of ${changes.length} saved, then: ${toAppError(e).message}`; err.hidden = false; }
    }));
  };
  await render();
};
async function integrationsPane(pane) {
  const manage = can('integrations.manage');
  const render = async (checked) => {
    let rows; try { rows = await select('integration_settings', '*', (q) => q.order('kind')); } catch (e) { pane.innerHTML = errorState(e); return; }
    const miss = Object.fromEntries((checked ?? []).map((c) => [`${c.kind}:${c.provider}`, c]));
    pane.innerHTML = `${notice('info', 'Where do the keys go?', ' Provider keys are never typed into this console. Add them in the Supabase dashboard under Edge Functions → Secrets (or <span class="mono">supabase secrets set NAME=value</span>), then click “Check now”. SETUP.md lists every secret step by step.')}
      <div class="row" style="margin-bottom:12px"><span class="spacer" style="flex:1"></span>${manage ? '<button class="btn" data-check="0"><i class="fa-solid fa-list-check"></i> Check secrets</button><button class="btn btn-primary" data-check="1"><i class="fa-solid fa-plug-circle-check"></i> Check now (live test)</button>' : ''}</div>
      <div class="grid grid-2">${rows.map((i) => { const c = miss[`${i.kind}:${i.provider}`]; return `<section class="card"><div class="card-head"><h3>${esc(titleCase(i.kind))} <span class="muted small">${esc(i.provider)}</span></h3>${badge(i.status, { healthy: 'success', configured: 'info', error: 'danger', not_configured: 'warning' }[i.status])}</div><div class="card-body">
        <p class="muted" style="margin-bottom:8px">${esc(i.public_config?.note ?? '')}</p><div class="kv"><span>Secrets needed</span><span class="mono small" style="text-align:right">${esc(SECRET_HELP[i.kind] ?? '—')}</span></div>${c?.missing?.length ? `<div class="kv"><span>Missing</span><span class="mono small" style="color:var(--danger);text-align:right">${esc(c.missing.join(', '))}</span></div>` : ''}
        <div class="kv"><span>Last check</span><span>${i.last_checked_at ? esc(ago(i.last_checked_at)) : 'Never'}</span></div>${i.last_error ? `<div class="notice danger" style="margin-top:8px">${esc(i.last_error)}</div>` : ''}
        <div class="row" style="margin-top:12px;gap:16px"><label class="check"><input type="checkbox" data-en="${esc(i.id)}" ${i.is_enabled ? 'checked' : ''} ${manage ? '' : 'disabled'}> Enabled</label><label class="row" style="gap:6px">Mode <select class="select" data-mode="${esc(i.id)}" ${manage ? '' : 'disabled'} style="width:auto"><option value="test" ${i.mode === 'test' ? 'selected' : ''}>Test</option><option value="live" ${i.mode === 'live' ? 'selected' : ''}>Live</option></select></label></div></div></section>`; }).join('')}</div>`;
    pane.querySelectorAll('[data-check]').forEach((b) => { b.onclick = () => withBusy(b, async () => { try { const r = await fn('integration-status', { live_check: b.dataset.check === '1' }); toast('success', 'Integration check finished.'); await render(r?.integrations ?? []); } catch (e) { showError(e); } }); });
    pane.querySelectorAll('[data-en]').forEach((c) => { c.onchange = async () => { try { await update('integration_settings', c.dataset.en, { is_enabled: c.checked }); toast('success', c.checked ? 'Enabled.' : 'Disabled.', 2500); } catch (e) { c.checked = !c.checked; showError(e); } }; });
    pane.querySelectorAll('[data-mode]').forEach((sEl) => { sEl.onchange = async () => { const row = rows.find((r) => r.id === sEl.dataset.mode);
      if (sEl.value === 'live' && !(await confirmDialog({ title: 'Switch to live mode?', text: 'This only records the mode shown in the console. Real money and real messages depend on which keys (test or live) are stored in Supabase secrets — make sure they match.', confirmText: 'Switch to live' }))) { sEl.value = row.mode; return; }
      try { await update('integration_settings', row.id, { mode: sEl.value }); row.mode = sEl.value; toast('success', 'Mode saved.', 2500); } catch (e) { sEl.value = row.mode; showError(e); } }; });
  };
  pane.innerHTML = loadingState(); await render();
}
async function historyPane(pane) {
  const staff = await staffList().catch(() => []); const names = nameMap(staff, 'full_name'); const show = (v) => `<span class="mono small">${esc(JSON.stringify(v))}</span>`;
  dataTable(pane, { search: { placeholder: 'Setting key…' }, columns: [{ label: 'When', render: (h) => esc(dateTime(h.created_at)) }, { label: 'Setting', render: (h) => `<div class="cell-main">${esc(META[h.key]?.label ?? h.key)}</div><div class="cell-sub mono">${esc(h.key)}</div>` }, { label: 'Before', render: (h) => show(h.old_value) }, { label: 'After', render: (h) => show(h.new_value) }, { label: 'Changed by', render: (h) => esc(names[h.changed_by] ?? '—') }, { label: 'Reason', render: (h) => esc(h.reason ?? '—') }],
    load: (s) => list('settings_history', { search: s.search, searchColumns: ['key'], page: s.page, pageSize: s.pageSize }), empty: { icon: 'fa-clock-rotate-left', title: 'No setting has been changed yet' } });
}
async function importsPane(pane) {
  const staff = await staffList().catch(() => []); const names = nameMap(staff, 'full_name');
  pane.innerHTML = `${notice('info', 'Importing data', ' is started from the page it belongs to: Drivers → Import CSV, Vehicles → Import CSV, Customers → Import CSV. Every import is listed here with its result.')}<div data-t></div>`;
  dataTable(pane.querySelector('[data-t]'), { search: false, filters: [{ name: 'entity', label: 'All types', options: ['drivers', 'vehicles', 'customers'] }],
    columns: [{ label: 'When', render: (j) => esc(dateTime(j.created_at)) }, { label: 'Type', render: (j) => esc(titleCase(j.entity)) }, { label: 'File', render: (j) => esc(j.file_name ?? '—') }, { label: 'Rows', cls: 'num', render: (j) => number(j.total_rows) }, { label: 'Imported', cls: 'num', render: (j) => number(j.imported_rows) }, { label: 'Failed', cls: 'num', render: (j) => (Number(j.failed_rows) ? `<span class="badge danger">${number(j.failed_rows)}</span>` : '0') }, { label: 'By', render: (j) => esc(names[j.created_by] ?? '—') }],
    load: (s) => list('data_import_jobs', { filters: s.filters, page: s.page, pageSize: s.pageSize }),
    onRowClick: async (j) => { const { openModal, simpleTable } = await import('../components.js'); openModal({ title: `Import of ${j.file_name ?? j.entity}`, subtitle: `${number(j.imported_rows)} imported, ${number(j.failed_rows)} failed`, footer: null, body: simpleTable([{ label: 'Row', render: (e) => esc(e.row) }, { label: 'Problem', render: (e) => esc(e.error) }], j.errors ?? [], { icon: 'fa-circle-check', title: 'No errors', text: 'Every row was imported.' }) }); },
    empty: { icon: 'fa-file-import', title: 'No imports yet' } });
}
export async function init(root, { params, setParams }) {
  const g = (id, label, icon) => ({ id, label, icon, render: groupPane(id) });
  const tb = tabs(root.querySelector('#settings-tabs'), [g('general', 'General', 'fa-sliders'), g('rides', 'Rides, OTP & tracking', 'fa-route'), g('drivers', 'Drivers', 'fa-id-card'), g('finance', 'Finance & fraud', 'fa-indian-rupee-sign'), g('security', 'Security', 'fa-shield-halved'), g('features', 'Features', 'fa-toggle-on'),
    { id: 'integrations', label: 'Integrations', icon: 'fa-plug', render: integrationsPane }, { id: 'imports', label: 'Imports', icon: 'fa-file-import', render: importsPane }, { id: 'history', label: 'Change history', icon: 'fa-clock-rotate-left', render: historyPane }], { initial: params.tab, onChange: (id) => setParams({ tab: id }) });
  return () => tb.destroy();
}
