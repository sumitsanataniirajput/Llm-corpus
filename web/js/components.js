// UI building blocks shared by every page: toasts, dialogs, forms, tables, tabs.
// All database text is escaped with esc() before it is placed into HTML.
import { esc, titleCase, toCsv, download, debounce, rupeesToPaise, paiseToRupeesText, toLocalInput, isoDate, toExcelHtml } from './utilities.js';
import { validate } from './validation.js';
import { can } from './permissions.js';
import { toAppError } from './supabase-client.js';

const $ = (sel, root = document) => root.querySelector(sel);
export const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------- feedback ----------
const ICON = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
export function toast(type, message, ms = type === 'error' ? 8000 : 4500) {
  const node = el(`<div class="toast ${esc(type)}" role="${type === 'error' ? 'alert' : 'status'}"><i class="fa-solid ${ICON[type] ?? ICON.info}"></i><div>${esc(message)}</div><button aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button></div>`);
  node.querySelector('button').onclick = () => node.remove();
  $('#toast-region').appendChild(node);
  if (ms) setTimeout(() => node.remove(), ms);
  return node;
}
/** Show a failure exactly as the server reported it. */
export function showError(e, prefix = '') {
  const err = toAppError(e);
  if (err.code === 'NOT_AUTHENTICATED') window.dispatchEvent(new CustomEvent('rms:session-expired'));
  toast('error', `${prefix}${err.message}`);
  return err;
}
export async function confirmDialog({ title, text = '', confirmText = 'Confirm', danger = false, html = null }) {
  const r = await window.Swal.fire({ title, ...(html ? { html } : { text }), icon: danger ? 'warning' : 'question', showCancelButton: true, confirmButtonText: confirmText,
    cancelButtonText: 'Cancel', reverseButtons: true, focusCancel: danger, customClass: { confirmButton: danger ? 'danger' : '' } });
  return r.isConfirmed === true;
}
/** Ask for a mandatory reason. Resolves to the text, or null when cancelled. */
export async function promptReason({ title, text = '', label = 'Reason', min = 5, confirmText = 'Confirm', danger = false, placeholder = '' }) {
  const r = await window.Swal.fire({ title, text, input: 'textarea', inputLabel: `${label} (required, at least ${min} characters)`, inputPlaceholder: placeholder,
    inputAttributes: { maxlength: '1000', 'aria-label': label }, showCancelButton: true, confirmButtonText: confirmText, reverseButtons: true,
    customClass: { confirmButton: danger ? 'danger' : '' },
    inputValidator: (v) => (!v || v.trim().length < min ? `Please enter at least ${min} characters` : undefined) });
  return r.isConfirmed ? String(r.value).trim() : null;
}
/** Disable a button while an async action runs; prevents double submission. */
export async function withBusy(btn, action) {
  if (!btn || btn.getAttribute('aria-busy') === 'true') return undefined;
  const html = btn.innerHTML; btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>' + (btn.classList.contains('btn-icon') ? '' : ' Working…');
  try { return await action(); } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; btn.innerHTML = html; }
}

// ---------- states ----------
export const loadingState = (text = 'Loading…') => `<div class="state" role="status"><div class="spinner" style="margin:0 auto 12px"></div><p>${esc(text)}</p></div>`;
export const emptyState = ({ icon = 'fa-inbox', title = 'Nothing here yet', text = '' } = {}) => `<div class="state"><i class="fa-solid ${esc(icon)}"></i><h4>${esc(title)}</h4>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
export const errorState = (e, retry = false) => { const err = toAppError(e); return `<div class="state error" role="alert"><i class="fa-solid fa-triangle-exclamation"></i><h4>Could not load</h4><p>${esc(err.message)}</p>${retry ? '<button class="btn btn-sm" data-retry><i class="fa-solid fa-rotate"></i> Try again</button>' : ''}</div>`; };
export const notice = (tone, title, text = '', icon = null) => `<div class="notice ${esc(tone)}"><i class="fa-solid ${icon ?? ICON[tone === 'danger' ? 'error' : tone] ?? ICON.info}"></i><div><strong>${esc(title)}</strong>${text ? esc(text) : ''}</div></div>`;

// ---------- badges ----------
const TONE = {
  success: ['active', 'approved', 'verified', 'completed', 'paid', 'captured', 'delivered', 'resolved', 'online', 'healthy', 'processed', 'sent', 'dispatched', 'rewarded', 'credited', 'live', 'payment_completed', 'otp_verified', 'returned', 'found', 'configured', 'enabled', 'yes', 'closed', 'ok', 'qualified', 'granted'],
  warning: ['pending', 'under_review', 'maintenance', 'payment_pending', 'otp_pending', 'processing', 'waiting', 'partial', 'partially_refunded', 'expired', 'delayed', 'in_progress', 'investigating', 'acknowledged', 'draft', 'paused', 'deletion_requested', 'driver_searching', 'medium', 'high', 'reported', 'created', 'test', 'in_app_only', 'received'],
  danger: ['rejected', 'suspended', 'blacklisted', 'blocked', 'failed', 'cancelled', 'locked', 'stale', 'error', 'disputed', 'critical', 'urgent', 'emergency', 'deactivated', 'deleted', 'open', 'not_found', 'retired', 'invalidated', 'incorrect', 'revoked', 'no'],
  info: ['driver_assigned', 'driver_accepted', 'driver_arriving', 'driver_at_pickup', 'ride_started', 'on_ride', 'ride_completed', 'refunded', 'overridden', 'normal', 'low', 'booking_created', 'ended', 'false_alarm', 'skipped', 'ignored'],
  violet: ['manual', 'override', 'manager_override'],
};
const toneOf = (v) => { const k = String(v ?? '').toLowerCase(); for (const [tone, list] of Object.entries(TONE)) if (list.includes(k)) return tone; return ''; };
export function badge(value, tone = null, label = null) {
  if (value === null || value === undefined || value === '') return '<span class="muted">—</span>';
  return `<span class="badge ${esc(tone ?? toneOf(value))}">${esc(label ?? titleCase(value))}</span>`;
}
export const yesNo = (v) => badge(v ? 'yes' : 'no', v ? 'success' : '', v ? 'Yes' : 'No');

// ---------- small layout helpers ----------
export function statCards(container, items) {
  container.innerHTML = items.filter(Boolean).map((s) => {
    const inner = `<div class="stat-ico ${esc(s.tone ?? '')}"><i class="fa-solid ${esc(s.icon ?? 'fa-chart-simple')}"></i></div><div><div class="stat-label" title="${esc(s.label)}">${esc(s.label)}</div><div class="stat-value">${esc(s.value ?? '—')}</div>${s.hint ? `<div class="stat-hint">${esc(s.hint)}</div>` : ''}</div>`;
    return s.href ? `<a class="stat" href="${esc(s.href)}">${inner}</a>` : `<div class="stat">${inner}</div>`;
  }).join('');
}
/** Definition list from [label, htmlValue] pairs. Values must already be escaped/HTML. */
export const dl = (pairs) => `<dl class="dl">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v === null || v === undefined || v === '' ? '—' : v}</dd>`).join('')}</dl>`;
export const card = (title, bodyHtml, { icon = null, actions = '', flush = false } = {}) => `<section class="card"><div class="card-head"><h3>${icon ? `<i class="fa-solid ${esc(icon)}"></i>` : ''}${esc(title)}</h3><div class="row">${actions}</div></div><div class="card-body${flush ? ' flush' : ''}">${bodyHtml}</div></section>`;
export const pageHead = (title, subtitle, actionsHtml = '') => `<div class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><div class="page-actions">${actionsHtml}</div></div>`;
export function timeline(items, empty = 'No history yet.') {
  if (!items?.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<ul class="timeline">${items.map((i) => `<li class="${esc(i.tone ?? '')}"><strong>${i.title}</strong>${i.text ? `<small>${i.text}</small><br>` : ''}<time>${esc(i.time ?? '')}</time></li>`).join('')}</ul>`;
}
/** Simple read-only table from rows. columns: [{label, render(row), cls}] */
export function simpleTable(columns, rows, empty = { title: 'No records' }) {
  if (!rows?.length) return emptyState(empty);
  return `<div class="table-wrap"><table class="table responsive"><thead><tr>${columns.map((c) => `<th class="${esc(c.cls ?? '')}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${esc(c.cls ?? '')}" data-label="${esc(c.label)}">${c.render(r) ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- modal / drawer ----------
export function openModal({ title, subtitle = '', body = '', size = '', footer = '', drawer = false, onClose = null }) {
  const previous = document.activeElement;
  const root = el(`<div class="modal-backdrop ${drawer ? 'drawer-backdrop' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal ${esc(size)} ${drawer ? 'drawer' : ''}">
      <div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</div><button class="btn-icon" data-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body"></div>${footer !== null ? '<div class="modal-foot"></div>' : ''}
    </div></div>`);
  const bodyEl = $('.modal-body', root), foot = $('.modal-foot', root);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (foot && footer) foot.innerHTML = footer;   // footer: '' keeps an empty bar that the caller fills in later; null = no bar
  let closed = false;
  const close = (result) => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); root.remove(); previous?.focus?.(); onClose?.(result); };
  const onKey = (e) => { if (e.key === 'Escape' && root === $('#modal-root').lastElementChild) close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $('[data-close]', root).onclick = () => close();
  $('#modal-root').appendChild(root);
  setTimeout(() => (bodyEl.querySelector('input:not([type=hidden]),select,textarea,button') ?? $('[data-close]', root))?.focus(), 30);
  return { root, body: bodyEl, foot: $('.modal-foot', root), close, setTitle: (t) => { $('.modal-head h2', root).textContent = t; } };
}

// ---------- forms ----------
const inputType = { text: 'text', email: 'email', tel: 'tel', password: 'password', number: 'number', date: 'date', time: 'time', datetime: 'datetime-local', url: 'url', money: 'text' };
export function fieldHtml(f, value) {
  if (f.type === 'section') return `<div class="form-section">${esc(f.label)}</div>`;
  if (f.type === 'static') return `<div class="field full">${f.html}</div>`;
  const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
  const req = f.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
  const common = `id="${id}" name="${esc(f.name)}" ${f.required ? 'required' : ''} ${f.disabled ? 'disabled' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}`;
  let control;
  const v = value ?? f.value ?? '';
  if (f.type === 'select' || f.type === 'multiselect') {
    const multi = f.type === 'multiselect'; const sel = multi ? (Array.isArray(v) ? v.map(String) : []) : [String(v)];
    control = `<select ${common} ${multi ? 'multiple' : ''}>${multi || f.noBlank ? '' : `<option value="">${esc(f.blank ?? 'Select…')}</option>`}${(f.options ?? []).map((o) => {
      const ov = typeof o === 'object' ? o.value : o, ol = typeof o === 'object' ? o.label : titleCase(o);
      return `<option value="${esc(ov)}" ${sel.includes(String(ov)) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
  } else if (f.type === 'textarea') {
    control = `<textarea ${common} rows="${f.rows ?? 3}" maxlength="${f.maxLength ?? 2000}">${esc(v)}</textarea>`;
  } else if (f.type === 'checkbox') {
    return `<div class="field ${f.full ? 'full' : ''}" data-field="${esc(f.name)}"><label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}" ${v === true || v === 'true' ? 'checked' : ''} ${f.disabled ? 'disabled' : ''}> ${esc(f.label)}</label>${f.help ? `<span class="field-help">${esc(f.help)}</span>` : ''}</div>`;
  } else if (f.type === 'file') {
    control = `<input type="file" ${common} accept="${esc(f.accept ?? 'image/jpeg,image/png,image/webp,application/pdf')}">`;
  } else {
    let val = v;
    if (f.type === 'money') val = v === '' || v === null ? '' : paiseToRupeesText(v);
    if (f.type === 'datetime') val = toLocalInput(v);
    if (f.type === 'date' && v) val = String(v).slice(0, 10);
    if (f.type === 'time' && v) val = String(v).slice(0, 5);
    const extra = [f.min !== undefined ? `min="${esc(f.min)}"` : '', f.max !== undefined ? `max="${esc(f.max)}"` : '', f.step !== undefined ? `step="${esc(f.step)}"` : f.type === 'number' ? 'step="any"' : '',
      f.maxLength ? `maxlength="${esc(f.maxLength)}"` : '', f.type === 'money' ? 'inputmode="decimal"' : '', f.autocomplete ? `autocomplete="${esc(f.autocomplete)}"` : 'autocomplete="off"'].join(' ');
    control = `<input type="${inputType[f.type] ?? 'text'}" ${common} value="${esc(val)}" ${extra}>`;
  }
  return `<div class="field ${f.full || f.type === 'textarea' ? 'full' : ''}" data-field="${esc(f.name)}"><label for="${id}">${esc(f.label)}${req}</label>${control}${f.help ? `<span class="field-help">${esc(f.help)}</span>` : ''}<span class="field-error" hidden></span></div>`;
}
export const formHtml = (fields, values = {}) => `<div class="form-grid">${fields.map((f) => fieldHtml(f, values[f.name])).join('')}</div>`;
/** Read typed values from a rendered form. Empty text becomes null. */
export function readFields(root, fields) {
  const out = {};
  for (const f of fields) {
    if (!f.name || f.type === 'section' || f.type === 'static') continue;
    const input = root.querySelector(`[name="${CSS.escape(f.name)}"]`);
    if (!input) continue;
    if (f.type === 'checkbox') out[f.name] = input.checked;
    else if (f.type === 'file') out[f.name] = input.files?.[0] ?? null;
    else if (f.type === 'multiselect') out[f.name] = [...input.selectedOptions].map((o) => o.value);
    else {
      const raw = input.value.trim();
      if (raw === '') out[f.name] = null;
      else if (f.type === 'number') out[f.name] = Number(raw);
      else if (f.type === 'money') out[f.name] = rupeesToPaise(raw) ?? raw;
      else if (f.type === 'datetime') out[f.name] = new Date(raw).toISOString();
      else out[f.name] = f.upper ? raw.toUpperCase() : raw;
    }
  }
  return out;
}
export function showFieldErrors(root, errors) {
  root.querySelectorAll('.field').forEach((w) => { w.classList.remove('invalid'); const e = w.querySelector('.field-error'); if (e) e.hidden = true; });
  let first = null;
  for (const [name, msg] of Object.entries(errors)) {
    const w = root.querySelector(`.field[data-field="${CSS.escape(name)}"]`); if (!w) continue;
    w.classList.add('invalid'); const e = w.querySelector('.field-error'); if (e) { e.textContent = msg; e.hidden = false; }
    first ??= w.querySelector('input,select,textarea');
  }
  first?.focus();
}
/**
 * Modal form. onSubmit(values) does the work; the modal stays open (with the error shown)
 * if it throws, and closes when it resolves. Resolves to onSubmit's result, or undefined if cancelled.
 */
export function formModal({ title, subtitle = '', intro = '', fields, values = {}, submitText = 'Save', size = '', danger = false, onSubmit, onRender = null }) {
  return new Promise((resolve) => {
    let result;
    const m = openModal({ title, subtitle, size, body: `${intro}<form novalidate>${formHtml(fields, values)}<div class="form-error" role="alert" hidden></div></form>`,
      footer: `<button class="btn" data-cancel type="button">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-submit type="button">${esc(submitText)}</button>`,
      onClose: () => resolve(result) });
    const form = m.body.querySelector('form'), errBox = form.querySelector('.form-error'), submit = m.foot.querySelector('[data-submit]');
    m.foot.querySelector('[data-cancel]').onclick = () => m.close();
    const applyShowIf = () => { const vals = readFields(form, fields); for (const f of fields) if (f.showIf) { const w = form.querySelector(`.field[data-field="${CSS.escape(f.name)}"]`); if (w) w.hidden = !f.showIf(vals); } };
    form.addEventListener('change', applyShowIf); applyShowIf();
    onRender?.(form, m);
    const go = () => withBusy(submit, async () => {
      errBox.hidden = true;
      const vals = readFields(form, fields);
      const v = validate(fields.map((f) => (f.type === 'money' ? { ...f, rules: [...(f.rules ?? []), (x) => (x === null || Number.isInteger(x) ? null : 'Enter an amount such as 120 or 120.50')] } : f)), vals);
      showFieldErrors(form, v.errors);
      if (!v.ok) return;
      try { result = (await onSubmit(vals, m)) ?? true; m.close(); }
      catch (e) { const err = toAppError(e); errBox.textContent = err.message; errBox.hidden = false; if (err.code === 'NOT_AUTHENTICATED') window.dispatchEvent(new CustomEvent('rms:session-expired')); }
    });
    submit.onclick = go;
    form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); go(); } });
  });
}

// ---------- tabs ----------
/** defs: [{id, label, icon, perm, count, render(pane) }]. Returns {show(id), pane}. Panes render lazily and re-render on each visit. */
export function tabs(container, defs, { initial = null, onChange = null } = {}) {
  const allowed = defs.filter((d) => d && can(d.perm));
  container.innerHTML = `<div class="tabs" role="tablist">${allowed.map((d) => `<button class="tab" role="tab" data-tab="${esc(d.id)}">${d.icon ? `<i class="fa-solid ${esc(d.icon)}"></i>` : ''}${esc(d.label)}<span class="count" data-count="${esc(d.id)}" hidden></span></button>`).join('')}</div><div class="tab-pane"></div>`;
  const pane = container.querySelector('.tab-pane'); let current = null; let cleanup = null;
  const show = async (id) => {
    const def = allowed.find((d) => d.id === id) ?? allowed[0];
    if (!def) { pane.innerHTML = emptyState({ icon: 'fa-lock', title: 'No access', text: 'Your role has no permission for this section.' }); return; }
    if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } } cleanup = null;
    current = def.id;
    container.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === def.id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    pane.innerHTML = loadingState(); onChange?.(def.id);
    try { const c = await def.render(pane); if (current === def.id) cleanup = c; else if (typeof c === 'function') c(); }
    catch (e) { if (current === def.id) pane.innerHTML = errorState(e); }
  };
  container.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) show(b.dataset.tab); });
  show(initial && allowed.some((d) => d.id === initial) ? initial : allowed[0]?.id);
  return { show, pane, current: () => current, destroy: () => { if (typeof cleanup === 'function') cleanup(); },
    setCount: (id, n, alert = false) => { const c = container.querySelector(`[data-count="${CSS.escape(id)}"]`); if (c) { c.hidden = !n; c.textContent = n; c.classList.toggle('alert', alert && n > 0); } } };
}

// ---------- data table ----------
/**
 * Server-paged table with search, filters, sorting, row actions and CSV/Excel export.
 * cfg.load(state) -> { rows, count }.  state = { page, pageSize, search, filters, sort, ascending }
 */
export function dataTable(container, cfg) {
  const state = { page: 1, pageSize: cfg.pageSize ?? 25, search: '', filters: Object.fromEntries((cfg.filters ?? []).map((f) => [f.name, f.value ?? ''])), sort: cfg.sort ?? null, ascending: cfg.ascending ?? false };
  const tools = (cfg.toolbar ?? []).filter((t) => t && can(t.perm));
  container.innerHTML = `<section class="card">
    ${cfg.title ? `<div class="card-head"><h3>${cfg.icon ? `<i class="fa-solid ${esc(cfg.icon)}"></i>` : ''}${esc(cfg.title)}</h3></div>` : ''}
    <div class="table-toolbar">
      ${cfg.search !== false ? `<div class="tb-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="${esc(cfg.search?.placeholder ?? 'Search…')}" aria-label="Search" data-search></div>` : ''}
      ${(cfg.filters ?? []).map((f) => f.type === 'date' ? `<input type="date" data-filter="${esc(f.name)}" aria-label="${esc(f.label)}" title="${esc(f.label)}" value="${esc(f.value ?? '')}">`
        : `<select data-filter="${esc(f.name)}" aria-label="${esc(f.label)}"><option value="">${esc(f.label)}</option>${f.options.map((o) => { const ov = typeof o === 'object' ? o.value : o, ol = typeof o === 'object' ? o.label : titleCase(o); return `<option value="${esc(ov)}" ${String(f.value ?? '') === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`).join('')}
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" data-refresh title="Refresh"><i class="fa-solid fa-rotate"></i></button>
      ${cfg.export && can(cfg.export.perm) ? '<button class="btn btn-sm" data-export="csv" title="Download CSV"><i class="fa-solid fa-file-csv"></i> CSV</button><button class="btn btn-sm" data-export="xls" title="Download Excel"><i class="fa-solid fa-file-excel"></i> Excel</button>' : ''}
      ${tools.map((t, i) => `<button class="btn btn-sm ${t.primary ? 'btn-primary' : ''}" data-tool="${i}"><i class="fa-solid ${esc(t.icon ?? 'fa-plus')}"></i> ${esc(t.label)}</button>`).join('')}
    </div>
    <div class="table-body"></div>
    <div class="table-foot" hidden><span data-summary></span><div class="pager"><button class="btn btn-sm" data-prev><i class="fa-solid fa-chevron-left"></i> Prev</button><span data-page></span><button class="btn btn-sm" data-next>Next <i class="fa-solid fa-chevron-right"></i></button></div></div>
  </section>`;
  const body = $('.table-body', container), foot = $('.table-foot', container);
  let rows = [], total = 0, seq = 0;
  const hasActions = typeof cfg.rowActions === 'function';

  async function reload({ keepPage = true, silent = false } = {}) {
    if (!keepPage) state.page = 1;
    const mine = ++seq;
    if (!silent) body.innerHTML = loadingState();
    try {
      const r = await cfg.load(state);
      if (mine !== seq || !container.isConnected) return;
      rows = r.rows ?? []; total = r.count ?? rows.length;
      render();
    } catch (e) {
      if (mine !== seq) return;
      body.innerHTML = errorState(e, true); foot.hidden = true;
      body.querySelector('[data-retry]')?.addEventListener('click', () => reload());
    }
  }
  function render() {
    if (!rows.length) {
      const filtered = state.search || Object.values(state.filters).some(Boolean);
      body.innerHTML = filtered ? emptyState({ icon: 'fa-filter-circle-xmark', title: 'No matches', text: 'Try a different search or clear the filters.' }) : emptyState(cfg.empty ?? {});
      foot.hidden = true; return;
    }
    const cols = cfg.columns.filter((c) => !c.perm || can(c.perm));
    body.innerHTML = `<div class="table-wrap"><table class="table responsive"><thead><tr>${cols.map((c) => `<th class="${esc(c.cls ?? '')} ${c.sort ? 'sortable' : ''}" ${c.sort ? `data-sort="${esc(c.sort)}"` : ''}>${esc(c.label)}${c.sort && state.sort === c.sort ? ` <i class="fa-solid fa-arrow-${state.ascending ? 'up' : 'down'}-long"></i>` : ''}</th>`).join('')}${hasActions ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map((r, i) => {
        const acts = hasActions ? cfg.rowActions(r).filter((a) => a && can(a.perm)) : [];
        return `<tr data-i="${i}" class="${cfg.onRowClick ? 'clickable' : ''} ${esc(cfg.rowClass?.(r) ?? '')}">${cols.map((c) => `<td class="${esc(c.cls ?? '')}" data-label="${esc(c.label)}">${(c.render ? c.render(r) : esc(r[c.key])) ?? '—'}</td>`).join('')}${hasActions ? `<td class="actions" data-label="">${acts.map((a, j) => `<button class="btn-icon ${a.danger ? 'danger' : ''}" data-act="${j}" title="${esc(a.title)}" aria-label="${esc(a.title)}"><i class="fa-solid ${esc(a.icon)}"></i></button>`).join('')}</td>` : ''}</tr>`; }).join('')}</tbody></table></div>`;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    foot.hidden = false;
    $('[data-summary]', foot).textContent = `${(state.page - 1) * state.pageSize + 1}–${Math.min(total, state.page * state.pageSize)} of ${total}`;
    $('[data-page]', foot).textContent = `Page ${state.page} / ${pages}`;
    $('[data-prev]', foot).disabled = state.page <= 1; $('[data-next]', foot).disabled = state.page >= pages;
  }
  body.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) { if (state.sort === th.dataset.sort) state.ascending = !state.ascending; else { state.sort = th.dataset.sort; state.ascending = true; } reload({ keepPage: false }); return; }
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const row = rows[Number(tr.dataset.i)];
    const btn = e.target.closest('[data-act]');
    if (btn) { e.stopPropagation(); const a = cfg.rowActions(row).filter((x) => x && can(x.perm))[Number(btn.dataset.act)]; if (a) Promise.resolve(withBusy(btn, () => a.onClick(row))).catch(showError); return; }
    if (e.target.closest('a,button,input,select,label')) return;
    cfg.onRowClick?.(row);
  });
  $('[data-search]', container)?.addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); reload({ keepPage: false }); }, 350));
  container.querySelectorAll('[data-filter]').forEach((s) => s.addEventListener('change', () => { state.filters[s.dataset.filter] = s.value; reload({ keepPage: false }); }));
  $('[data-refresh]', container).onclick = () => reload();
  $('[data-prev]', foot).onclick = () => { state.page--; reload(); };
  $('[data-next]', foot).onclick = () => { state.page++; reload(); };
  container.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => Promise.resolve(tools[Number(b.dataset.tool)].onClick()).catch(showError); });
  container.querySelectorAll('[data-export]').forEach((b) => { b.onclick = () => withBusy(b, async () => {
    try {
      const all = await cfg.export.loadAll(state);
      if (!all.length) { toast('info', 'There is nothing to export for the current filters.'); return; }
      exportRows(cfg.export.filename, cfg.export.columns, all, b.dataset.export);
      toast('success', `Exported ${all.length} row(s).`);
    } catch (e) { showError(e, 'Export failed: '); }
  }); });
  reload();
  return { reload: (o) => reload(o), state, rows: () => rows };
}
/** kind: 'csv' | 'xls' */
export function exportRows(name, columns, rows, kind = 'csv') {
  const stamp = isoDate();
  if (kind === 'xls') download(`${name}-${stamp}.xls`, toExcelHtml(name, columns, rows), 'application/vnd.ms-excel;charset=utf-8');
  else download(`${name}-${stamp}.csv`, toCsv(columns, rows));
}
/** Print-friendly report: the browser's "Save as PDF" produces the PDF export. */
export function printReport(title, innerHtml) {
  const w = window.open('', '_blank');
  if (!w) { toast('warning', 'Allow pop-ups for this site to create the PDF.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font-family:Inter,system-ui,sans-serif;color:#0f172a;margin:28px;font-size:12.5px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px}
    .muted{color:#64748b}table{width:100%;border-collapse:collapse;margin-top:6px}th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}th{background:#f1f5f9}
    td.num,th.num{text-align:right}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}.kpi{border:1px solid #cbd5e1;border-radius:6px;padding:8px}.kpi b{display:block;font-size:16px}
    @media print{button{display:none}}</style></head><body><button id="print-btn" style="float:right;padding:8px 14px">Print / Save as PDF</button>
    <h1>${esc(title)}</h1>${innerHtml}</body></html>`);
  w.document.close();
  // Attached from here (not as an inline onclick) so it works under the Content-Security-Policy.
  const btn = w.document.getElementById('print-btn'); if (btn) btn.addEventListener('click', () => w.print());
  w.focus();
}
