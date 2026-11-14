// Module 8 — Vehicle service categories and per-city availability.
import { select, insert, update, remove, cities, categories, invalidate, countOf } from '../api.js';
import { sb, toAppError } from '../supabase-client.js';
import { formModal, confirmDialog, toast, showError, loadingState, errorState, emptyState, notice, badge } from '../components.js';
import { esc, number } from '../utilities.js';
import { can } from '../permissions.js';
import { rules } from '../validation.js';

const ICONS = ['fa-motorcycle', 'fa-car-side', 'fa-car', 'fa-taxi', 'fa-van-shuttle', 'fa-bus', 'fa-truck-pickup', 'fa-truck', 'fa-truck-medical', 'fa-shuttle-van', 'fa-charging-station', 'fa-wheelchair'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const scheduleText = (s) => (!s?.length ? 'Always available' : s.map((w) => `${(w.days ?? [1, 2, 3, 4, 5, 6, 7]).length === 7 ? 'Daily' : (w.days ?? []).map((d) => DAYS[d - 1]).join(', ')} ${w.start}–${w.end}`).join('; '));

async function editCategory(c, done) {
  const sch = c?.schedule?.[0];
  const ok = await formModal({ title: c ? `Edit ${c.name}` : 'Add vehicle category', subtitle: c ? '' : 'For example: E-Rickshaw, Tempo Traveller, Luxury.', values: c ? { ...c, limited: !!sch, start: sch?.start, end: sch?.end, days: (sch?.days ?? [1, 2, 3, 4, 5, 6, 7]).map(String) } : { capacity: 4, icon: 'fa-car', sort_order: 50, days: ['1', '2', '3', '4', '5', '6', '7'] },
    fields: [{ name: 'name', label: 'Name', required: true, rules: [rules.minLen(2), rules.maxLen(40)] }, { name: 'code', label: 'Code', required: true, disabled: !!c?.id && !c.is_custom, rules: [(v) => (/^[a-z][a-z0-9_]{1,29}$/.test(v ?? '') ? null : 'Lower-case letters, digits and underscores, e.g. e_rickshaw')], help: 'Used in imports and reports. Cannot contain spaces.' },
      { name: 'capacity', label: 'Passenger capacity', type: 'number', required: true, rules: [rules.integer, rules.min(1), rules.max(60)] }, { name: 'icon', label: 'Icon', type: 'select', noBlank: true, options: ICONS.map((i) => ({ value: i, label: i.replace('fa-', '').replace(/-/g, ' ') })) },
      { name: 'sort_order', label: 'Display order', type: 'number', rules: [rules.integer, rules.min(0)] }, { name: 'description', label: 'Description', full: true, rules: [rules.maxLen(200)] },
      { type: 'section', label: 'Service hours' }, { name: 'limited', label: 'Limit to certain hours', type: 'checkbox', full: true },
      { name: 'start', label: 'From', type: 'time', showIf: (v) => v.limited, rules: [(v, a) => (!a.limited || v ? null : 'Required')] }, { name: 'end', label: 'Until', type: 'time', showIf: (v) => v.limited, rules: [(v, a) => (!a.limited || (v && v > a.start) ? null : 'Must be after the start time')] },
      { name: 'days', label: 'Days', type: 'multiselect', showIf: (v) => v.limited, options: DAYS.map((d, i) => ({ value: String(i + 1), label: d })), help: 'Hold Ctrl / Cmd to choose several.' }],
    onSubmit: async (v) => { const row = { name: v.name, capacity: v.capacity, icon: v.icon, sort_order: v.sort_order ?? 50, description: v.description, schedule: v.limited ? [{ days: (v.days?.length ? v.days : ['1', '2', '3', '4', '5', '6', '7']).map(Number), start: v.start, end: v.end }] : [] };
      return c ? update('vehicle_categories', c.id, c.is_custom ? { ...row, code: v.code } : row) : insert('vehicle_categories', { ...row, code: v.code, is_custom: true }); } });
  if (ok) { invalidate('categories'); toast('success', c ? 'Category updated.' : 'Category added. Enable it for a city and add a pricing rule to start taking bookings.'); done(); }
}

export async function init(root) {
  const manage = can('services.manage');
  root.querySelector('#services-actions').innerHTML = manage ? '<button class="btn btn-primary" id="svc-new"><i class="fa-solid fa-plus"></i> Add category</button>' : '';
  const box = root.querySelector('#services-tabs');
  async function render() {
    box.innerHTML = loadingState();
    try {
      const [cats, cityList, avail, vehicles, rulesRows] = await Promise.all([categories(true), cities(), select('category_city_availability', 'category_id,city_id,is_enabled'), select('vehicles', 'category_id', (q) => q.eq('status', 'active')).catch(() => []), select('pricing_rules', 'category_id,city_id', (q) => q.eq('is_active', true).is('effective_to', null)).catch(() => [])]);
      const activeCities = cityList.filter((c) => c.is_active);
      const on = (cat, city) => avail.find((a) => a.category_id === cat && a.city_id === city)?.is_enabled === true;
      const priced = (cat, city) => rulesRows.some((r) => r.category_id === cat && r.city_id === city);
      const vcount = (cat) => vehicles.filter((v) => v.category_id === cat).length;
      box.innerHTML = `${cats.length ? `<div class="grid grid-3">${cats.map((c) => `<section class="card" data-cat="${esc(c.id)}"><div class="card-head"><h3><i class="fa-solid ${esc(c.icon || 'fa-car')}"></i>${esc(c.name)}</h3><div class="row">${c.is_active ? '<span class="badge success">Enabled</span>' : '<span class="badge">Disabled</span>'}${c.is_custom ? '<span class="badge violet">Custom</span>' : ''}</div></div>
        <div class="card-body"><p class="muted small" style="margin:0 0 8px">${esc(c.description ?? '')}</p><div class="kv"><span>Capacity</span><span>${esc(c.capacity)} passenger(s)</span></div><div class="kv"><span>Active vehicles</span><span>${number(vcount(c.id))}</span></div><div class="kv"><span>Hours</span><span>${esc(scheduleText(c.schedule))}</span></div>
        <h4 style="margin:12px 0 6px">Cities</h4>${activeCities.length ? activeCities.map((ct) => `<label class="check" style="display:flex;justify-content:space-between;padding:4px 0"><span><input type="checkbox" data-city="${esc(ct.id)}" ${on(c.id, ct.id) ? 'checked' : ''} ${manage ? '' : 'disabled'}> ${esc(ct.name)}</span>${on(c.id, ct.id) && !priced(c.id, ct.id) ? '<a class="badge warning" href="#/pricing" title="Bookings are refused until a pricing rule exists">No pricing rule</a>' : ''}</label>`).join('') : '<p class="muted small">No active city. Add one under Locations.</p>'}
        ${manage ? `<div class="row" style="margin-top:12px"><button class="btn btn-sm" data-edit><i class="fa-solid fa-pen"></i> Edit</button><button class="btn btn-sm" data-toggle>${c.is_active ? 'Disable' : 'Enable'}</button></div>` : ''}</div></section>`).join('')}</div>`
        : emptyState({ icon: 'fa-layer-group', title: 'No vehicle categories', text: 'Run the reference seed migration or add a category.' })}
        <p class="field-help" style="margin-top:12px">A category is bookable in a city when it is enabled, ticked for that city, and has a pricing rule in force.</p>`;
      box.querySelectorAll('[data-cat]').forEach((card) => { const c = cats.find((x) => x.id === card.dataset.cat);
        card.querySelector('[data-edit]')?.addEventListener('click', () => editCategory(c, render).catch(showError));
        card.querySelector('[data-toggle]')?.addEventListener('click', async () => { try { if (c.is_active && !(await confirmDialog({ title: `Disable ${c.name}?`, text: 'Customers will no longer be able to book this category in any city. Rides in progress are not affected.', confirmText: 'Disable', danger: true }))) return; await update('vehicle_categories', c.id, { is_active: !c.is_active }); invalidate('categories'); toast('success', `${c.name} ${c.is_active ? 'disabled' : 'enabled'}.`); render(); } catch (e) { showError(e); } });
        card.querySelectorAll('[data-city]').forEach((cb) => { cb.onchange = async () => { cb.disabled = true; try { const { error } = await sb.from('category_city_availability').upsert({ category_id: c.id, city_id: cb.dataset.city, is_enabled: cb.checked }, { onConflict: 'category_id,city_id' }); if (error) throw toAppError(error); toast('success', `${c.name} ${cb.checked ? 'enabled' : 'disabled'} for this city.`); render(); } catch (e) { cb.checked = !cb.checked; cb.disabled = false; showError(e); } }; }); });
    } catch (e) { box.innerHTML = errorState(e); }
  }
  root.querySelector('#svc-new')?.addEventListener('click', () => editCategory(null, render).catch(showError));
  await render();
}
