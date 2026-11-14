// Module 15 — Locations: cities, operating / restricted / airport / surge zones drawn on the map, branches.
import { list, select, insert, update, remove, cities, branches, staffList, asOptions, nameMap, invalidate } from '../api.js';
import { dataTable, tabs, badge, formModal, confirmDialog, toast, showError, loadingState, errorState, notice, yesNo } from '../components.js';
import { esc, date, titleCase, bpToX } from '../utilities.js';
import { can } from '../permissions.js';
import { rules } from '../validation.js';
import { createMap, mapUnavailable, drawZones, polygonEditor, clearOverlays, fitTo, zoneColor } from '../maps.js';

const ZONE_TYPES = [['operating', 'Operating zone'], ['service_boundary', 'Service boundary (rides must start inside)'], ['restricted', 'Restricted (no pickups)'], ['airport', 'Airport'], ['railway', 'Railway station'], ['surge', 'Surge pricing zone']];
const zl = (t) => ZONE_TYPES.find((z) => z[0] === t)?.[1].replace(/ \(.*/, '') ?? titleCase(t);
const coord = (lo, hi) => [(v) => (v === null || v === '' || (Number(v) >= lo && Number(v) <= hi) ? null : `Must be between ${lo} and ${hi}`)];

function citiesPane(pane) {
  const F = [{ name: 'name', label: 'City name', required: true, rules: [rules.minLen(2)] }, { name: 'state', label: 'State', required: true }, { name: 'timezone', label: 'Time zone', required: true, value: 'Asia/Kolkata' },
    { name: 'center_lat', label: 'Centre latitude', type: 'number', step: 'any', required: true, rules: coord(-90, 90), help: 'In Google Maps, right-click the city centre and click the numbers to copy them.' }, { name: 'center_lng', label: 'Centre longitude', type: 'number', step: 'any', required: true, rules: coord(-180, 180) },
    { name: 'launched_at', label: 'Launch date', type: 'date' }, { name: 'is_active', label: 'Active (bookings allowed)', type: 'checkbox' }];
  const save = async (c) => { const ok = await formModal({ title: c ? `Edit ${c.name}` : 'Add city', size: 'lg', values: c ?? { timezone: 'Asia/Kolkata', is_active: true }, fields: F, onSubmit: (v) => (c ? update('cities', c.id, v) : insert('cities', v)) }); if (ok) { invalidate('cities'); toast('success', c ? 'City updated.' : 'City added. Next: draw its zones and add a pricing rule.', 7000); t.reload(); } };
  const t = dataTable(pane, { search: { placeholder: 'City or state…' }, toolbar: [{ label: 'Add city', icon: 'fa-plus', primary: true, perm: 'locations.manage', onClick: () => save(null) }],
    columns: [{ label: 'City', render: (c) => `<div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.state)}</div>` }, { label: 'Centre', render: (c) => `<span class="mono">${esc(c.center_lat ?? '—')}, ${esc(c.center_lng ?? '—')}</span>` }, { label: 'Time zone', render: (c) => esc(c.timezone) }, { label: 'Launched', render: (c) => esc(c.launched_at ? date(c.launched_at) : '—') }, { label: 'Active', render: (c) => yesNo(c.is_active) }],
    load: (s) => list('cities', { search: s.search, searchColumns: ['name', 'state'], order: 'name', ascending: true, page: s.page, pageSize: s.pageSize }),
    rowActions: (c) => [{ icon: 'fa-pen', title: 'Edit', perm: 'locations.manage', onClick: () => save(c) }, { icon: c.is_active ? 'fa-pause' : 'fa-play', title: c.is_active ? 'Stop bookings in this city' : 'Activate', perm: 'locations.manage', onClick: async () => { if (c.is_active && !(await confirmDialog({ title: `Deactivate ${c.name}?`, text: 'New bookings in this city are refused. Ongoing rides are not affected.', confirmText: 'Deactivate', danger: true }))) return; await update('cities', c.id, { is_active: !c.is_active }); invalidate('cities'); t.reload(); } }],
    empty: { icon: 'fa-city', title: 'No cities yet', text: 'Add the first city you operate in.' } });
}
async function zonesPane(pane) {
  const cityList = await cities(true);
  if (!cityList.length) { pane.innerHTML = notice('info', 'Add a city first.', ' Zones belong to a city.'); return; }
  const manage = can('locations.manage');
  pane.innerHTML = `<div class="grid grid-2-1"><section class="card"><div class="card-head"><h3><i class="fa-solid fa-draw-polygon"></i>Zones</h3><select class="select" data-city aria-label="City" style="max-width:220px">${cityList.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div><div class="card-body flush"><div class="map" data-map></div></div></section>
    <section class="card"><div class="card-head"><h3 data-ptitle>Zones in this city</h3>${manage ? '<button class="btn btn-sm btn-primary" data-new><i class="fa-solid fa-plus"></i> Draw zone</button>' : ''}</div><div class="card-body" data-panel></div></section></div>`;
  const mapEl = pane.querySelector('[data-map]'), panel = pane.querySelector('[data-panel]'), sel = pane.querySelector('[data-city]'), ptitle = pane.querySelector('[data-ptitle]');
  let map = null, polys = [], zones = [], editor = null;
  try { map = await createMap(mapEl, { zoom: 11 }); } catch (e) { mapEl.innerHTML = mapUnavailable(e); }
  const city = () => cityList.find((c) => c.id === sel.value);
  const stop = () => { editor?.destroy(); editor = null; };
  async function load(fit = true) {
    stop(); ptitle.textContent = 'Zones in this city'; panel.innerHTML = loadingState();
    try { zones = await select('service_zones', '*', (q) => q.eq('city_id', sel.value).order('name')); } catch (e) { panel.innerHTML = errorState(e); return; }
    if (map) { polys = clearOverlays(polys); polys = drawZones(map, zones, { onClick: (z) => manage && edit(z) }); const pts = zones.flatMap((z) => z.polygon ?? []); const c = city(); if (fit) { if (pts.length) fitTo(map, pts, 14); else if (c?.center_lat) { map.setCenter({ lat: Number(c.center_lat), lng: Number(c.center_lng) }); map.setZoom(11); } } }
    panel.innerHTML = zones.length ? zones.map((z) => `<div class="row" style="padding:9px 0;border-bottom:1px solid var(--border);gap:10px"><span style="width:12px;height:12px;border-radius:3px;background:${zoneColor(z.zone_type)};flex:none"></span><div style="flex:1;min-width:0"><div class="cell-main">${esc(z.name)} ${z.is_active ? '' : '<span class="badge">Off</span>'}</div><div class="cell-sub">${esc(zl(z.zone_type))}${z.zone_type === 'surge' ? ` · ${esc(bpToX(z.surge_multiplier_bp))}` : ''} · ${(z.polygon ?? []).length} points</div></div>${manage ? `<button class="btn btn-sm btn-icon" data-edit="${esc(z.id)}" title="Edit" aria-label="Edit ${esc(z.name)}"><i class="fa-solid fa-pen"></i></button><button class="btn btn-sm btn-icon" data-del="${esc(z.id)}" title="Delete" aria-label="Delete ${esc(z.name)}"><i class="fa-solid fa-trash"></i></button>` : ''}</div>`).join('')
      : `<div class="state"><i class="fa-solid fa-draw-polygon"></i><h4>No zones in ${esc(city()?.name ?? 'this city')}</h4><p>Without a service boundary, rides can start anywhere. Draw one to limit the service area.</p></div>`;
    panel.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => edit(zones.find((z) => z.id === b.dataset.edit)); });
    panel.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { const z = zones.find((x) => x.id === b.dataset.del); if (!(await confirmDialog({ title: `Delete zone “${z.name}”?`, text: 'Pricing rules attached to this zone stop applying. Past rides are not changed.', confirmText: 'Delete', danger: true }))) return; try { await remove('service_zones', z.id); toast('success', 'Zone deleted.'); load(false); } catch (e) { showError(e); } }; });
  }
  function edit(z) {
    if (!map) { toast('error', 'Zones can only be drawn when Google Maps is configured. See SETUP.md.'); return; }
    stop(); polys = clearOverlays(polys); polys = drawZones(map, zones.filter((x) => x.id !== z?.id)); ptitle.textContent = z ? `Edit ${z.name}` : 'New zone';
    panel.innerHTML = `${notice('info', 'How to draw:', ' click on the map to add each corner, drag a corner to move it, right-click a corner to remove it.')}
      <form novalidate class="form-grid" style="grid-template-columns:1fr"><div class="field"><label for="z-name">Zone name <span class="req">*</span></label><input class="input" id="z-name" name="name" maxlength="80" value="${esc(z?.name ?? '')}"></div>
      <div class="field"><label for="z-type">Type</label><select class="select" id="z-type" name="zone_type">${ZONE_TYPES.map(([v, l]) => `<option value="${v}" ${z?.zone_type === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field" data-surge><label for="z-surge">Surge multiplier (1.0 – 5.0)</label><input class="input" id="z-surge" name="surge" type="number" step="0.05" min="1" max="5" value="${((z?.surge_multiplier_bp ?? 15000) / 10000).toFixed(2)}"><div class="field-help">1.5 means fares are 1.5× while the pickup is inside this zone.</div></div>
      <div class="field"><label for="z-notes">Notes</label><textarea class="textarea" id="z-notes" name="notes" rows="2" maxlength="500">${esc(z?.notes ?? '')}</textarea></div>
      <label class="check"><input type="checkbox" name="is_active" ${z?.is_active === false ? '' : 'checked'}> Active</label></form>
      <div class="form-error" role="alert" hidden></div><div class="row" style="margin-top:12px;gap:8px"><button class="btn btn-primary" data-save><i class="fa-solid fa-floppy-disk"></i> Save zone</button><button class="btn" data-undo>Undo last point</button><button class="btn" data-clear>Clear</button><button class="btn" data-cancel>Cancel</button></div>`;
    const f = panel.querySelector('form'), err = panel.querySelector('.form-error'); const surge = () => { panel.querySelector('[data-surge]').hidden = f.zone_type.value !== 'surge'; }; surge();
    const start = () => { stop(); editor = polygonEditor(map, editor ? [] : (z?.polygon ?? []), zoneColor(f.zone_type.value)); };
    editor = polygonEditor(map, z?.polygon ?? [], zoneColor(f.zone_type.value)); if (z?.polygon?.length) fitTo(map, z.polygon, 15);
    f.zone_type.onchange = () => { surge(); const path = editor.getPath(); stop(); editor = polygonEditor(map, path, zoneColor(f.zone_type.value)); };
    panel.querySelector('[data-undo]').onclick = () => editor.undo(); panel.querySelector('[data-clear]').onclick = () => editor.clear(); panel.querySelector('[data-cancel]').onclick = () => load(false);
    panel.querySelector('[data-save]').onclick = async (ev) => {
      const btn = ev.currentTarget; err.hidden = true; const path = editor.getPath(); const name = f.name.value.trim(); const mult = Number(f.surge.value);
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      if (name.length < 2) return fail('Enter a zone name.'); if (path.length < 3) return fail('Click at least 3 points on the map to make an area.'); if (path.length > 500) return fail('Too many points (maximum 500). Simplify the shape.');
      if (f.zone_type.value === 'surge' && !(mult >= 1 && mult <= 5)) return fail('Surge multiplier must be between 1.0 and 5.0.');
      const row = { name, zone_type: f.zone_type.value, polygon: path, notes: f.notes.value.trim() || null, is_active: f.is_active.checked, surge_multiplier_bp: f.zone_type.value === 'surge' ? Math.round(mult * 10000) : 10000 };
      btn.disabled = true; try { if (z) await update('service_zones', z.id, row); else await insert('service_zones', { ...row, city_id: sel.value }); toast('success', 'Zone saved.'); load(false); } catch (e) { fail(e.message ?? 'Could not save the zone.'); btn.disabled = false; }
    };
  }
  sel.onchange = () => load(); pane.querySelector('[data-new]')?.addEventListener('click', () => edit(null)); await load();
  return () => { stop(); clearOverlays(polys); };
}
async function branchesPane(pane) {
  const [cityList, staff] = await Promise.all([cities(), staffList().catch(() => [])]);
  const F = (b) => [{ name: 'name', label: 'Branch name', required: true, rules: [rules.minLen(2)] }, { name: 'code', label: 'Short code', required: true, disabled: !!b, rules: [(v) => (/^[A-Z0-9-]{2,12}$/.test(v ?? '') ? null : '2–12 capital letters, digits or hyphens')], help: 'For example LKO-01.' }, { name: 'city_id', label: 'City', type: 'select', required: true, options: asOptions(cityList) },
    { name: 'phone', label: 'Phone', type: 'tel', rules: [rules.phone] }, { name: 'manager_staff_id', label: 'Branch manager', type: 'select', options: asOptions(staff.filter((s) => s.status === 'active'), 'full_name') }, { name: 'address', label: 'Address', type: 'textarea' }, { name: 'is_active', label: 'Active', type: 'checkbox' }];
  const save = async (b) => { const ok = await formModal({ title: b ? `Edit ${b.name}` : 'Add branch', size: 'lg', values: b ?? { is_active: true }, fields: F(b), onSubmit: ({ code, ...v }) => (b ? update('branches', b.id, v) : insert('branches', { ...v, code })) }); if (ok) { invalidate('branches'); toast('success', 'Branch saved.'); t.reload(); } };
  const t = dataTable(pane, { search: { placeholder: 'Branch name or code…' }, filters: [{ name: 'city_id', label: 'All cities', options: asOptions(cityList) }], toolbar: [{ label: 'Add branch', icon: 'fa-plus', primary: true, perm: 'settings.manage', onClick: () => save(null) }],
    columns: [{ label: 'Branch', render: (b) => `<div class="cell-main">${esc(b.name)}</div><div class="cell-sub mono">${esc(b.code)}</div>` }, { label: 'City', render: (b) => esc(nameMap(cityList)[b.city_id] ?? '—') }, { label: 'Manager', render: (b) => esc(nameMap(staff, 'full_name')[b.manager_staff_id] ?? '—') }, { label: 'Phone', render: (b) => esc(b.phone ?? '—') }, { label: 'Address', render: (b) => esc(b.address ?? '—') }, { label: 'Active', render: (b) => yesNo(b.is_active) }],
    load: (s) => list('branches', { search: s.search, searchColumns: ['name', 'code'], filters: s.filters, order: 'name', ascending: true, page: s.page, pageSize: s.pageSize }),
    rowActions: (b) => [{ icon: 'fa-pen', title: 'Edit', perm: 'settings.manage', onClick: () => save(b) }], empty: { icon: 'fa-building', title: 'No branches', text: 'Branches are optional. Use them to group staff, drivers and vehicles by office.' } });
}
export async function init(root, { params, setParams }) {
  const tb = tabs(root.querySelector('#locations-tabs'), [{ id: 'cities', label: 'Cities', icon: 'fa-city', render: citiesPane }, { id: 'zones', label: 'Zones', icon: 'fa-draw-polygon', render: zonesPane }, { id: 'branches', label: 'Branches', icon: 'fa-building', render: branchesPane }], { initial: params.tab, onChange: (id) => setParams({ tab: id }) });
  return () => tb.destroy();
}
