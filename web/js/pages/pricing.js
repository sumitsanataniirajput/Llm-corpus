// Module 7 — Pricing. Rules are versioned: a change creates a new version and closes the old one,
// so past and already-quoted bookings stay explainable.
import { rpc } from '../supabase-client.js';
import { list, select, insert, update, cities, categories, asOptions, nameMap } from '../api.js';
import { dataTable, tabs, badge, formModal, promptReason, confirmDialog, toast, showError, simpleTable, loadingState, errorState, notice, openModal, dl, formHtml, readFields, showFieldErrors, withBusy } from '../components.js';
import { esc, money, dateTime, titleCase, bpToPct, bpToX, km } from '../utilities.js';
import { can } from '../permissions.js';
import { rules, validate } from '../validation.js';
import { attach } from './shared.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const toBp = (x) => Math.round(Number(x) * 10000), pctToBp = (p) => Math.round(Number(p) * 100);
const mult = [rules.min(1), rules.max(5)];
const peakText = (w) => (w ?? []).map((p) => `${(p.days ?? [1, 2, 3, 4, 5, 6, 7]).map((d) => DAYS[d - 1]).join('/')} ${p.start}–${p.end} ×${(p.multiplier_bp / 10000).toFixed(2)}`).join('; ');
/** "Mon-Fri 08:00-11:00 1.25" per line → peak_windows JSON. Returns {value} or {error}. */
function parsePeaks(text) {
  const out = [];
  for (const [i, raw] of String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).entries()) {
    const m = /^([A-Za-z,\-\s]+?)\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s+(\d(?:\.\d+)?)$/.exec(raw);
    if (!m) return { error: `Line ${i + 1}: use the form “Mon-Fri 08:00-11:00 1.25”` };
    const days = new Set();
    for (const part of m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      const idx = (s) => DAYS.findIndex((d) => d.toLowerCase() === s.slice(0, 3));
      if (part === 'daily' || part === 'all') { for (let d = 1; d <= 7; d++) days.add(d); continue; }
      const [a, b] = part.split('-').map((s) => s.trim()); const ia = idx(a), ib = b ? idx(b) : ia;
      if (ia < 0 || ib < 0) return { error: `Line ${i + 1}: unknown day “${part}”` };
      for (let d = ia; ; d = (d + 1) % 7) { days.add(d + 1); if (d === ib) break; }
    }
    const pad = (t) => t.padStart(5, '0'); const start = pad(m[2]), end = pad(m[3]), x = Number(m[4]);
    if (start >= end) return { error: `Line ${i + 1}: the end time must be after the start time` };
    if (x < 1 || x > 5) return { error: `Line ${i + 1}: multiplier must be between 1 and 5` };
    out.push({ days: [...days].sort(), start, end, multiplier_bp: toBp(x) });
  }
  return { value: out };
}
const peaksToText = (w) => (w ?? []).map((p) => `${(p.days ?? [1, 2, 3, 4, 5, 6, 7]).map((d) => DAYS[d - 1]).join(',')} ${p.start}-${p.end} ${(p.multiplier_bp / 10000).toFixed(2)}`).join('\n');

function ruleFields(cats, cityList, zones, r) {
  return [
    { name: 'city_id', label: 'City', type: 'select', required: true, options: asOptions(cityList), disabled: !!r }, { name: 'category_id', label: 'Vehicle category', type: 'select', required: true, options: asOptions(cats), disabled: !!r },
    { name: 'zone_id', label: 'Zone (optional)', type: 'select', blank: 'Whole city', options: zones.map((z) => ({ value: z.id, label: `${z.name} (${titleCase(z.zone_type)})` })), disabled: !!r, help: 'A zone rule overrides the city rule for pickups inside that zone.' },
    { name: 'effective_from', label: 'Effective from', type: 'datetime', required: true, help: r ? 'The current version ends at this moment.' : '' },
    { type: 'section', label: 'Fare' },
    { name: 'base_fare_paise', label: 'Base fare (₹)', type: 'money', required: true }, { name: 'per_km_paise', label: 'Per kilometre (₹)', type: 'money', required: true }, { name: 'per_minute_paise', label: 'Per minute (₹)', type: 'money', required: true }, { name: 'minimum_fare_paise', label: 'Minimum fare (₹)', type: 'money', required: true },
    { name: 'free_waiting_minutes', label: 'Free waiting (minutes)', type: 'number', required: true, rules: [rules.integer, rules.min(0), rules.max(120)] }, { name: 'waiting_per_minute_paise', label: 'Waiting charge per minute (₹)', type: 'money', required: true }, { name: 'cancellation_fee_paise', label: 'Cancellation fee (₹)', type: 'money', required: true },
    { type: 'section', label: 'Night, peak and surge' },
    { name: 'night_start', label: 'Night starts', type: 'time', required: true }, { name: 'night_end', label: 'Night ends', type: 'time', required: true }, { name: 'night_x', label: 'Night multiplier (1 = none)', type: 'number', required: true, step: 0.05, rules: mult }, { name: 'surge_x', label: 'Surge multiplier (1 = none)', type: 'number', required: true, step: 0.05, rules: mult, help: 'Applies all day until you change it back to 1.' },
    { name: 'peaks', label: 'Peak hours (one per line)', type: 'textarea', placeholder: 'Mon-Fri 08:00-11:00 1.25\nMon-Fri 17:00-21:00 1.3', rules: [(v) => parsePeaks(v).error ?? null], help: 'Days, time window, multiplier. Night and peak do not stack — the higher one applies.' },
    { type: 'section', label: 'Commission and tax' },
    { name: 'commission_pct', label: 'Company commission (%)', type: 'number', required: true, step: 0.5, rules: [rules.min(0), rules.max(100)] }, { name: 'gst_pct', label: 'GST (%)', type: 'number', required: true, step: 0.5, rules: [rules.min(0), rules.max(100)], help: 'Confirm the correct rate with your accountant.' },
  ];
}
const toRow = (v) => ({ base_fare_paise: v.base_fare_paise, per_km_paise: v.per_km_paise, per_minute_paise: v.per_minute_paise, minimum_fare_paise: v.minimum_fare_paise, free_waiting_minutes: v.free_waiting_minutes, waiting_per_minute_paise: v.waiting_per_minute_paise, cancellation_fee_paise: v.cancellation_fee_paise,
  night_start: v.night_start, night_end: v.night_end, night_multiplier_bp: toBp(v.night_x), surge_multiplier_bp: toBp(v.surge_x), peak_windows: parsePeaks(v.peaks).value, commission_bp: pctToBp(v.commission_pct), gst_bp: pctToBp(v.gst_pct), effective_from: v.effective_from });

async function editRule(r, done) {
  const [cats, cityList, zones] = await Promise.all([categories(), cities(), select('service_zones', 'id,name,zone_type,city_id', (q) => q.eq('is_active', true).order('name'))]);
  const values = r ? { ...r, effective_from: new Date().toISOString(), night_x: r.night_multiplier_bp / 10000, surge_x: r.surge_multiplier_bp / 10000, peaks: peaksToText(r.peak_windows), commission_pct: r.commission_bp / 100, gst_pct: r.gst_bp / 100 }
    : { effective_from: new Date().toISOString(), per_minute_paise: 0, minimum_fare_paise: 0, free_waiting_minutes: 3, waiting_per_minute_paise: 0, cancellation_fee_paise: 0, night_start: '22:00', night_end: '06:00', night_x: 1, surge_x: 1, commission_pct: 20, gst_pct: 5 };
  const ok = await formModal({ title: r ? 'New price version' : 'Add pricing rule', subtitle: r ? 'Saving creates a new version. Bookings already made keep their quoted price.' : 'One rule per city and vehicle category (optionally per zone).', size: 'lg', values, fields: ruleFields(cats, cityList, zones, r), submitText: r ? 'Publish new version' : 'Create rule',
    onSubmit: async (v) => {
      const row = toRow(v);
      if (r) {
        if (new Date(row.effective_from) <= new Date(r.effective_from)) throw new Error('“Effective from” must be later than the current version’s start.');
        const created = await insert('pricing_rules', { ...row, city_id: r.city_id, category_id: r.category_id, zone_id: r.zone_id });
        try { await update('pricing_rules', r.id, { effective_to: row.effective_from }); } catch (e) { await update('pricing_rules', created.id, { is_active: false }).catch(() => {}); throw e; }
        return created;
      }
      const dup = await select('pricing_rules', 'id', (q) => { q = q.eq('city_id', v.city_id).eq('category_id', v.category_id).eq('is_active', true).is('effective_to', null); return v.zone_id ? q.eq('zone_id', v.zone_id) : q.is('zone_id', null); });
      if (dup.length) throw new Error('An active rule already exists for this city, category and zone. Open it and publish a new version instead.');
      return insert('pricing_rules', { ...row, city_id: v.city_id, category_id: v.category_id, zone_id: v.zone_id });
    } });
  if (ok) { toast('success', r ? 'New price version published.' : 'Pricing rule created.'); done?.(); }
}
function rulesPane(pane, cats, cityList) {
  const t = dataTable(pane, { search: false, filters: [{ name: 'city_id', label: 'All cities', options: asOptions(cityList) }, { name: 'category_id', label: 'All categories', options: asOptions(cats) }, { name: 'which', label: 'Current rules', options: [{ value: 'all', label: 'Include past versions' }] }],
    toolbar: [{ label: 'Add pricing rule', icon: 'fa-plus', primary: true, perm: 'pricing.manage', onClick: () => editRule(null, () => t.reload()) }],
    columns: [{ label: 'City / category', render: (r) => `<div class="cell-main">${esc(nameMap(cats)[r.category_id] ?? '—')}</div><div class="cell-sub">${esc(nameMap(cityList)[r.city_id] ?? '—')}${r.zone ? ` · zone: ${esc(r.zone.name)}` : ''}</div>` },
      { label: 'Base', cls: 'num', render: (r) => money(r.base_fare_paise) }, { label: 'Per km', cls: 'num', render: (r) => money(r.per_km_paise) }, { label: 'Per min', cls: 'num', render: (r) => money(r.per_minute_paise) }, { label: 'Minimum', cls: 'num', render: (r) => money(r.minimum_fare_paise) },
      { label: 'Night / surge', render: (r) => `${bpToX(r.night_multiplier_bp)} <span class="cell-sub">${esc(String(r.night_start).slice(0, 5))}–${esc(String(r.night_end).slice(0, 5))}</span><div class="cell-sub">surge ${bpToX(r.surge_multiplier_bp)}${r.peak_windows?.length ? ` · ${r.peak_windows.length} peak window(s)` : ''}</div>` },
      { label: 'Commission / GST', render: (r) => `${bpToPct(r.commission_bp)} / ${bpToPct(r.gst_bp)}` },
      { label: 'Validity', render: (r) => { const now = Date.now(), from = new Date(r.effective_from).getTime(), to = r.effective_to ? new Date(r.effective_to).getTime() : Infinity; const st = !r.is_active ? ['', 'Deactivated'] : from > now ? ['info', 'Scheduled'] : to <= now ? ['', 'Ended'] : ['success', 'In force']; return `<span class="badge ${st[0]}">${st[1]}</span><div class="cell-sub">from ${esc(dateTime(r.effective_from))}${r.effective_to ? `<br>to ${esc(dateTime(r.effective_to))}` : ''}</div>`; } }],
    load: async (s) => { const { which, ...f } = s.filters; const r = await list('pricing_rules', { filters: f, order: 'effective_from', page: s.page, pageSize: s.pageSize, apply: (q) => (which === 'all' ? q : q.eq('is_active', true).or(`effective_to.is.null,effective_to.gt.${new Date().toISOString()}`)) }); await attach(r.rows, 'zone_id', 'service_zones', 'id,name', 'zone'); return r; },
    rowActions: (r) => { const live = r.is_active && (!r.effective_to || new Date(r.effective_to) > new Date()); return [
      { icon: 'fa-eye', title: 'View details', onClick: () => openModal({ title: 'Pricing rule', footer: null, body: dl([['City', esc(nameMap(cityList)[r.city_id])], ['Category', esc(nameMap(cats)[r.category_id])], ['Zone', esc(r.zone?.name ?? 'Whole city')], ['Base fare', money(r.base_fare_paise)], ['Per km', money(r.per_km_paise)], ['Per minute', money(r.per_minute_paise)], ['Minimum fare', money(r.minimum_fare_paise)], ['Free waiting', `${esc(r.free_waiting_minutes)} min`], ['Waiting per minute', money(r.waiting_per_minute_paise)], ['Cancellation fee', money(r.cancellation_fee_paise)],
        ['Night', `${esc(String(r.night_start).slice(0, 5))}–${esc(String(r.night_end).slice(0, 5))} · ${bpToX(r.night_multiplier_bp)}`], ['Peak windows', esc(peakText(r.peak_windows) || 'None')], ['Surge', bpToX(r.surge_multiplier_bp)], ['Commission', bpToPct(r.commission_bp)], ['GST', bpToPct(r.gst_bp)], ['Effective', `${esc(dateTime(r.effective_from))} → ${r.effective_to ? esc(dateTime(r.effective_to)) : 'until changed'}`]]) }) },
      live && { icon: 'fa-pen', title: 'Change prices (new version)', perm: 'pricing.manage', onClick: () => editRule(r, () => t.reload()) },
      live && { icon: 'fa-power-off', title: 'Deactivate', perm: 'pricing.manage', onClick: async () => { if (await confirmDialog({ title: 'Deactivate this rule?', text: 'New bookings for this city and category will be refused until another rule is in force. Existing bookings are not affected.', confirmText: 'Deactivate', danger: true })) { await update('pricing_rules', r.id, { is_active: false }); toast('success', 'Rule deactivated.'); t.reload(); } } }]; },
    empty: { icon: 'fa-tags', title: 'No pricing rules', text: 'Bookings cannot be created for a city and category until a pricing rule exists.' } });
}
async function calculator(pane, cats, cityList) {
  const fields = [{ name: 'city_id', label: 'City', type: 'select', required: true, options: asOptions(cityList) }, { name: 'category_id', label: 'Vehicle category', type: 'select', required: true, options: asOptions(cats) }, { name: 'distance', label: 'Distance (km)', type: 'number', required: true, value: 10, rules: [rules.min(0.1), rules.max(2000)] }, { name: 'duration', label: 'Duration (minutes)', type: 'number', required: true, value: 30, rules: [rules.min(0), rules.max(3000)] },
    { name: 'waiting', label: 'Waiting (minutes)', type: 'number', value: 0, rules: [rules.min(0)] }, { name: 'at', label: 'Ride time', type: 'datetime', value: new Date().toISOString(), help: 'Night and peak multipliers depend on this time.' }];
  pane.innerHTML = `<div class="grid grid-2"><section class="card"><div class="card-head"><h3><i class="fa-solid fa-calculator"></i>Fare calculator</h3></div><div class="card-body"><form novalidate>${formHtml(fields)}</form><div class="row" style="margin-top:12px"><button class="btn btn-primary" data-go>Calculate</button></div></div></section><section class="card"><div class="card-head"><h3><i class="fa-solid fa-receipt"></i>Result</h3></div><div class="card-body" data-out><p class="muted">Uses exactly the same server function as real bookings.</p></div></section></div>`;
  const form = pane.querySelector('form'), out = pane.querySelector('[data-out]');
  pane.querySelector('[data-go]').onclick = (e) => withBusy(e.currentTarget, async () => {
    const v = readFields(form, fields); const res = validate(fields, v); showFieldErrors(form, res.errors); if (!res.ok) return;
    try { const f = await rpc('calculate_fare', { p_category_id: v.category_id, p_city_id: v.city_id, p_distance_km: v.distance, p_duration_min: Math.round(v.duration), p_at: v.at ?? new Date().toISOString(), p_waiting_min: Math.round(v.waiting ?? 0) });
      const row = (k, val, cls = '') => `<div class="kv ${cls}"><span>${k}</span><span>${val}</span></div>`;
      out.innerHTML = `${row('Base fare', money(f.base_fare_paise))}${row(`Distance (${km(v.distance)})`, money(f.distance_fare_paise))}${row(`Time (${esc(Math.round(v.duration))} min)`, money(f.time_fare_paise))}${row('Waiting', money(f.waiting_fare_paise))}${row('Night / peak / surge', money(f.surcharge_paise))}${f.minimum_fare_applied ? row('Minimum fare applied', '<span class="badge info">Yes</span>') : ''}${row('GST', money(f.tax_paise))}${row('Customer pays', money(f.total_fare_paise), 'total')}${row('Company commission', money(f.commission_paise))}${row('Driver earning', money(f.driver_earning_paise))}`;
    } catch (err) { out.innerHTML = errorState(err); }
  });
}
function historyPane(pane, cats, cityList) {
  dataTable(pane, { search: false, filters: [{ name: 'change_type', label: 'All changes', options: ['created', 'updated', 'deactivated', 'deleted'] }],
    columns: [{ label: 'When', render: (h) => esc(dateTime(h.created_at)) }, { label: 'Change', render: (h) => badge(h.change_type, h.change_type === 'created' ? 'success' : h.change_type === 'updated' ? 'info' : 'warning') }, { label: 'Rule', render: (h) => { const d = h.new_data ?? h.old_data ?? {}; return `${esc(nameMap(cats)[d.category_id] ?? '—')} · ${esc(nameMap(cityList)[d.city_id] ?? '—')}`; } },
      { label: 'What changed', render: (h) => { const o = h.old_data ?? {}, n = h.new_data ?? {}; const keys = Object.keys(n).filter((k) => !['updated_at', 'created_at', 'id', 'created_by'].includes(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k])); const show = (k, v) => (v === null || v === undefined ? '—' : /_paise$/.test(k) ? money(v) : /_bp$/.test(k) ? (k.includes('multiplier') ? bpToX(v) : bpToPct(v)) : typeof v === 'object' ? JSON.stringify(v) : String(v));
        return h.change_type === 'created' ? `<span class="cell-sub">Base ${money(n.base_fare_paise)} · ${money(n.per_km_paise)}/km · commission ${bpToPct(n.commission_bp)}</span>` : keys.length ? `<span class="cell-sub">${keys.slice(0, 6).map((k) => `${esc(titleCase(k.replace(/_paise|_bp/, '')))}: ${esc(show(k, o[k]))} → ${esc(show(k, n[k]))}`).join('<br>')}</span>` : '—'; } }, { label: 'By', render: (h) => esc(h.staff?.full_name ?? '—') }],
    load: async (s) => { const r = await list('pricing_history', { filters: s.filters, page: s.page, pageSize: s.pageSize }); await attach(r.rows, 'changed_by', 'staff_accounts', 'id,full_name', 'staff'); return r; },
    empty: { icon: 'fa-clock-rotate-left', title: 'No pricing changes recorded yet' } });
}
export async function init(root, { params, setParams }) {
  const [cats, cityList] = await Promise.all([categories(), cities()]);
  root.querySelector('#pricing-top').innerHTML = can('pricing.manage') ? '' : notice('info', 'View only.', ' Your role cannot change prices.');
  const tb = tabs(root.querySelector('#pricing-tabs'), [{ id: 'rules', label: 'Pricing rules', icon: 'fa-tags', render: (p) => rulesPane(p, cats, cityList) }, { id: 'calculator', label: 'Fare calculator', icon: 'fa-calculator', render: (p) => calculator(p, cats, cityList) }, { id: 'history', label: 'Change history', icon: 'fa-clock-rotate-left', render: (p) => historyPane(p, cats, cityList) }], { initial: params.tab, onChange: (id) => setParams({ tab: id }) });
  return () => tb.destroy();
}
