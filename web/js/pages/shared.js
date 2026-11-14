// Domain helpers shared by several pages.
import { sb, toAppError } from '../supabase-client.js';
import { list, signedUrl } from '../api.js';
import { esc, debounce, titleCase } from '../utilities.js';
import { openModal, loadingState, emptyState, errorState, badge } from '../components.js';
import { can } from '../permissions.js';

export const ACTIVE_RIDE = ['DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'OTP_PENDING', 'OTP_VERIFIED', 'RIDE_STARTED'];
export const ONGOING = ['DRIVER_SEARCHING', ...ACTIVE_RIDE];
export const ALL_STATUSES = ['BOOKING_CREATED', 'DRIVER_SEARCHING', ...ACTIVE_RIDE, 'RIDE_COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CANCELLED', 'DISPUTED'];
export const DRIVER_DOCS = ['aadhaar', 'pan', 'driving_licence', 'photo', 'police_verification', 'address_proof', 'bank_proof'];
export const VEHICLE_DOCS = ['rc', 'insurance', 'pollution', 'fitness', 'permit', 'photo'];

/**
 * Attach related rows fetched in one extra query (works for views and respects RLS):
 *   await attach(rows, 'customer_id', 'customer_directory', 'id,full_name,customer_code', 'customer')
 * Rows the user may not read simply stay without the related object.
 */
export async function attach(rows, fk, table, columns, as, key = 'id') {
  const ids = [...new Set(rows.map((r) => r[fk]).filter(Boolean))];
  if (!ids.length) return rows;
  const map = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from(table).select(columns).in(key, ids.slice(i, i + 200));
    if (error) { if (/permission denied|row-level/i.test(error.message)) return rows; throw toAppError(error); }
    for (const r of data ?? []) map.set(r[key], r);
  }
  for (const r of rows) r[as] = map.get(r[fk]) ?? null;
  return rows;
}
/** Customer table access depends on permission: the masked view is always available to customers.view. */
export const CUSTOMER_SOURCE = 'customer_directory';
export const personCell = (p, codeKey) => (p ? `<div class="cell-main">${esc(p.full_name)}</div><div class="cell-sub mono">${esc(p[codeKey] ?? '')}</div>` : '<span class="muted">—</span>');
export const rideLink = (b) => (b ? `<a href="#/rides?id=${esc(b.id)}" class="mono">${esc(b.booking_code)}</a>` : '<span class="muted">—</span>');

/** Search-and-pick dialog. Resolves to the chosen row or null. */
export function pickEntity({ title, table, columns, searchColumns, filters = {}, render, order = 'full_name', apply = null, hint = '' }) {
  return new Promise((resolve) => {
    let chosen = null;
    const m = openModal({ title, body: `<div class="field"><input type="search" placeholder="Type to search…" aria-label="Search" data-q></div>${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}<div data-results class="card" style="max-height:52vh;overflow:auto"></div>`, footer: null, onClose: () => resolve(chosen) });
    const box = m.body.querySelector('[data-results]'); let rows = [], seq = 0;
    const load = async (q) => {
      const mine = ++seq; box.innerHTML = loadingState('Searching…');
      try {
        const r = await list(table, { select: columns, search: q, searchColumns, filters, order, ascending: true, pageSize: 25, apply, count: 'planned' });
        if (mine !== seq) return; rows = r.rows;
        box.innerHTML = rows.length ? rows.map((x, i) => `<div class="list-item" data-i="${i}" tabindex="0" role="button">${render(x)}</div>`).join('') : emptyState({ icon: 'fa-magnifying-glass', title: 'No matches', text: 'Nothing matches in the records you can access.' });
      } catch (e) { if (mine === seq) box.innerHTML = errorState(e); }
    };
    const pick = (e) => { const it = e.target.closest('[data-i]'); if (it) { chosen = rows[Number(it.dataset.i)]; m.close(); } };
    box.addEventListener('click', pick); box.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(e); });
    m.body.querySelector('[data-q]').addEventListener('input', debounce((e) => load(e.target.value.trim()), 300));
    load('');
  });
}
export const pickCustomer = (opts = {}) => pickEntity({ title: 'Choose customer', table: 'customer_directory', columns: 'id,customer_code,full_name,phone,status,city_id', searchColumns: ['full_name', 'customer_code', ...(can('customers.view_pii') ? ['phone'] : [])],
  filters: { status: 'active' }, render: (c) => `<div><div class="cell-main">${esc(c.full_name)}</div><div class="cell-sub">${esc(c.customer_code)} · ${esc(c.phone ?? '')}</div></div>`, ...opts });
export const pickDriver = (opts = {}) => pickEntity({ title: 'Choose driver', table: 'drivers', columns: 'id,driver_code,full_name,phone,status,availability,city_id', searchColumns: ['full_name', 'driver_code', 'phone'],
  render: (d) => `<div><div class="cell-main">${esc(d.full_name)}</div><div class="cell-sub">${esc(d.driver_code)} · ${esc(d.phone ?? '')}</div></div>${badge(d.status)}${d.status === 'approved' ? badge(d.availability) : ''}`, ...opts });
export const pickVehicle = (opts = {}) => pickEntity({ title: 'Choose vehicle', table: 'vehicles', columns: 'id,vehicle_code,registration_number,manufacturer,model,status', searchColumns: ['registration_number', 'vehicle_code', 'model'], order: 'registration_number',
  render: (v) => `<div><div class="cell-main">${esc(v.registration_number)}</div><div class="cell-sub">${esc(v.vehicle_code)} · ${esc(v.manufacturer ?? '')} ${esc(v.model ?? '')}</div></div>${badge(v.status)}`, ...opts });

/** Open a private document through a 2-minute signed URL. Images are shown inline, PDFs in a frame. */
export async function viewDocument(bucket, path, title = 'Document') {
  const m = openModal({ title, size: 'lg', body: loadingState('Requesting a secure link…'), footer: null });
  try {
    const url = await signedUrl(bucket, path);
    const isPdf = /\.pdf$/i.test(path);
    m.body.innerHTML = `${isPdf ? `<iframe src="${esc(url)}" title="${esc(title)}" style="width:100%;height:68vh;border:0;border-radius:10px;background:#fff"></iframe>` : `<img class="thumb" src="${esc(url)}" alt="${esc(title)}">`}
      <p class="muted small" style="margin-top:10px"><i class="fa-solid fa-lock"></i> Private file. This link expires in 2 minutes and every signed link is created with your account.</p>`;
  } catch (e) { m.body.innerHTML = errorState(e); }
}
export const docLabel = (t) => ({ rc: 'Registration Certificate (RC)', pollution: 'Pollution Certificate (PUC)', fitness: 'Fitness Certificate', permit: 'Permit', insurance: 'Insurance', pan: 'PAN', aadhaar: 'Aadhaar', driving_licence: 'Driving Licence', photo: 'Photograph' }[t] ?? titleCase(t));
/** Expiry badge for documents. */
export function expiryBadge(dateStr) {
  if (!dateStr) return '<span class="muted">No expiry</span>';
  const days = Math.round((new Date(`${dateStr}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);
  const text = new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  if (days < 0) return `<span class="badge danger">Expired ${esc(text)}</span>`;
  if (days <= 30) return `<span class="badge warning">${esc(text)} · ${days} d left</span>`;
  return esc(text);
}
