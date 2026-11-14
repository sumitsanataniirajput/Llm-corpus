// Module 1 — Live vehicle tracking (Google Maps + Supabase Realtime, with honest freshness states).
import { rpc, cities, select, list } from '../api.js';
import { createTracker, roughEta } from '../tracking.js';
import { createMap, createClusterer, vehicleIcon, pinIcon, fitTo, drawZones, clearOverlays, mapsConfigured } from '../maps.js';
import { statCards, badge, emptyState, errorState, notice, toast, showError, loadingState, dl, openModal, simpleTable } from '../components.js';
import { esc, ago, km, debounce, titleCase, dateTime, number, isoDate, duration } from '../utilities.js';
import { can, applyPermissions } from '../permissions.js';
import { attach } from './shared.js';

const FRESH = { live: ['success', 'Live'], delayed: ['warning', 'Delayed'], stale: ['danger', 'Stale'], offline: ['', 'Offline'], not_sharing: ['danger', 'Sharing stopped'], no_data: ['', 'No location yet'] };
const fresh = (d) => { const [tone, label] = FRESH[d.freshness] ?? FRESH.no_data; return `<span class="badge ${tone}">${label}</span>`; };
const isProblem = (d) => ['stale', 'not_sharing'].includes(d.freshness) || (d.gps_status && d.gps_status !== 'ok') || (d.availability !== 'offline' && d.freshness === 'no_data');

export async function init(root, { params }) {
  applyPermissions(root);
  const $ = (s) => root.querySelector(s);
  let drivers = [], selected = params.driver ?? null, filter = 'all', firstFit = true, zoneOverlays = [], zones = [], rideOverlays = [], alive = true;
  const cityList = await cities().catch(() => []);
  $('#lt-city').insertAdjacentHTML('beforeend', cityList.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(''));

  const map = await createMap($('#lt-map'), { zoom: 12 });
  const maps = map ? window.google.maps : null;
  const cluster = map ? createClusterer(map, { onClick: (it) => choose(it.id, false) }) : null;
  if (!map) $('#lt-notice').innerHTML = notice('warning', mapsConfigured() ? 'The map could not be loaded.' : 'Google Maps is not configured.', ' The driver list below still shows real positions and freshness. Add GOOGLE_MAPS_API_KEY in js/config.js (see SETUP.md, step “Google Maps”).');

  async function loadZones() {
    zoneOverlays = clearOverlays(zoneOverlays); if (!map || !$('#lt-zones').checked) return;
    try { zones = await select('service_zones', 'id,name,zone_type,polygon,is_active,city_id', (q) => { q = q.eq('is_active', true); const c = $('#lt-city').value; return c ? q.eq('city_id', c) : q; });
      zoneOverlays = drawZones(map, zones); } catch { /* zones are optional */ }
  }
  const visible = () => drivers.filter((d) => filter === 'all' || (filter === 'problem' ? isProblem(d) : d.availability === filter));

  function renderList() {
    const rows = visible().sort((a, b) => (a.availability === 'on_ride' ? 0 : 1) - (b.availability === 'on_ride' ? 0 : 1) || a.full_name.localeCompare(b.full_name));
    $('#lt-list').innerHTML = rows.length ? rows.map((d) => `<div class="list-item ${d.driver_id === selected ? 'active' : ''}" data-id="${esc(d.driver_id)}" tabindex="0" role="button">
        <span class="avatar"><i class="fa-solid ${esc(d.category_icon || 'fa-car')}"></i></span>
        <div><div class="cell-main">${esc(d.full_name)}</div><div class="cell-sub">${esc(d.registration_number ?? 'No vehicle')} · ${d.booking_code ? `<span class="mono">${esc(d.booking_code)}</span>` : esc(titleCase(d.availability))}</div>
        <div class="cell-sub">${d.received_at ? `updated ${esc(ago(d.received_at))}` : 'no position received'}${d.gps_status && d.gps_status !== 'ok' ? ` · <span style="color:var(--danger)">GPS ${esc(titleCase(d.gps_status))}</span>` : ''}</div></div>${fresh(d)}</div>`).join('')
      : emptyState({ icon: 'fa-location-crosshairs', title: 'No drivers to show', text: drivers.length ? 'No driver matches this filter.' : 'Drivers appear here when they go online in the Driver App and share their location.' });
  }
  function renderMap() {
    if (!cluster) return;
    cluster.update(visible().filter((d) => d.lat !== null && d.lng !== null && d.freshness !== 'no_data').map((d) => ({ id: d.driver_id, lat: d.lat, lng: d.lng, zIndex: d.driver_id === selected ? 9 : d.availability === 'on_ride' ? 4 : 2,
      title: `${d.full_name} · ${d.registration_number ?? ''} · ${FRESH[d.freshness]?.[1] ?? ''}`, icon: vehicleIcon(maps, { freshness: d.freshness, heading: d.heading ?? 0, onRide: d.availability === 'on_ride', selected: d.driver_id === selected }) })));
    if (firstFit && drivers.some((d) => d.lat !== null)) { firstFit = false; fitTo(map, drivers.filter((d) => d.lat !== null)); }
  }
  function renderStats() {
    const n = (f) => drivers.filter(f).length;
    statCards($('#lt-stats'), [
      { label: 'Live now', value: number(n((d) => d.freshness === 'live')), icon: 'fa-signal', tone: 'success' },
      { label: 'On a ride', value: number(n((d) => d.availability === 'on_ride')), icon: 'fa-route', tone: 'info' },
      { label: 'Idle (online, waiting)', value: number(n((d) => d.availability === 'online')), icon: 'fa-mug-hot' },
      { label: 'Delayed / stale', value: number(n((d) => ['delayed', 'stale'].includes(d.freshness))), icon: 'fa-hourglass-half', tone: 'warning' },
      { label: 'GPS problems', value: number(n((d) => d.freshness === 'not_sharing' || (d.gps_status && d.gps_status !== 'ok'))), icon: 'fa-location-pin-lock', tone: 'danger' },
    ]);
  }
  function renderDetail() {
    rideOverlays = clearOverlays(rideOverlays);
    const d = drivers.find((x) => x.driver_id === selected);
    if (!d) { $('#lt-detail').innerHTML = ''; return; }
    const here = d.lat !== null ? { lat: d.lat, lng: d.lng } : null;
    const toPickup = ['DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER_ARRIVING'].includes(d.booking_status);
    const target = d.booking_id ? (toPickup ? { lat: Number(d.pickup_lat), lng: Number(d.pickup_lng) } : { lat: Number(d.drop_lat), lng: Number(d.drop_lng) }) : null;
    const eta = d.booking_id && ['live', 'delayed'].includes(d.freshness) ? roughEta(here, target, d.speed_kmh) : null;
    if (map && d.booking_id) {
      rideOverlays.push(new maps.Marker({ map, position: { lat: Number(d.pickup_lat), lng: Number(d.pickup_lng) }, icon: pinIcon(maps, '#15803d', 'P'), title: `Pickup: ${d.pickup_address}` }),
        new maps.Marker({ map, position: { lat: Number(d.drop_lat), lng: Number(d.drop_lng) }, icon: pinIcon(maps, '#b91c1c', 'D'), title: `Destination: ${d.drop_address}` }));
    }
    $('#lt-detail').innerHTML = `<section class="card"><div class="card-head"><h3><i class="fa-solid fa-id-card"></i>${esc(d.full_name)} <span class="cell-sub mono">${esc(d.driver_code)}</span></h3><div class="row">${fresh(d)}${badge(d.availability)}<button class="btn btn-sm btn-ghost" data-close title="Close"><i class="fa-solid fa-xmark"></i></button></div></div>
      <div class="card-body">${['stale', 'not_sharing', 'delayed'].includes(d.freshness) ? notice(d.freshness === 'delayed' ? 'warning' : 'danger', d.freshness === 'not_sharing' ? 'This driver has stopped sharing location.' : `Last position is ${ago(d.received_at)}.`, ' The marker shows the last known position, not where the vehicle is now.') : ''}
      <div class="grid grid-2">${dl([['Vehicle', `${esc(d.registration_number ?? '—')} · ${esc(d.category ?? '')}`], ['Speed', d.speed_kmh === null ? '—' : `${esc(Math.round(d.speed_kmh))} km/h`], ['GPS', badge(d.gps_status ?? 'unknown', d.gps_status === 'ok' ? 'success' : 'warning')], ['Accuracy', d.accuracy_m === null ? '—' : `± ${esc(Math.round(d.accuracy_m))} m`],
        ['Battery', d.battery_pct === null ? '—' : `${esc(d.battery_pct)}%`], ['Device time', esc(dateTime(d.recorded_at))], ['Server received', esc(dateTime(d.received_at))], ['Rating', `★ ${esc(Number(d.rating_avg ?? 0).toFixed(1))}`]])}
      ${d.booking_id ? dl([['Booking', `<a href="#/rides?id=${esc(d.booking_id)}" class="mono">${esc(d.booking_code)}</a> ${badge(d.booking_status)}`], ['Pickup', esc(d.pickup_address)], ['Destination', esc(d.drop_address)], ['Travelled / booked', `${km(d.travelled_km)} / ${km(d.booked_distance_km)}`],
        ['Rough ETA', eta ? `~${eta.minutes} min to ${toPickup ? 'pickup' : 'destination'} (${eta.km.toFixed(1)} km) <span class="cell-sub">estimate from straight-line distance</span>` : '<span class="muted">Not available without a fresh position</span>']]) : '<p class="muted">Not on a ride.</p>'}</div>
      <div class="row" style="margin-top:12px"><a class="btn btn-sm" href="#/drivers?id=${esc(d.driver_id)}"><i class="fa-solid fa-user"></i> Driver profile</a>
        ${can('tracking.history') ? '<button class="btn btn-sm" data-trail><i class="fa-solid fa-clock-rotate-left"></i> Location history</button>' : ''}${here && map ? '<button class="btn btn-sm" data-centre><i class="fa-solid fa-location-crosshairs"></i> Centre on map</button>' : ''}</div></div></section>`;
    $('#lt-detail [data-close]').onclick = () => { selected = null; renderAll(); };
    $('#lt-detail [data-centre]')?.addEventListener('click', () => { map.panTo(here); map.setZoom(Math.max(map.getZoom(), 15)); });
    $('#lt-detail [data-trail]')?.addEventListener('click', () => showTrail(d).catch(showError));
  }
  const renderAll = () => { renderStats(); renderList(); renderMap(); renderDetail(); };
  function choose(id, pan = true) { selected = id; renderAll(); const d = drivers.find((x) => x.driver_id === id); if (pan && map && d?.lat !== null && d) { map.panTo({ lat: d.lat, lng: d.lng }); if (map.getZoom() < 14) map.setZoom(14); } }

  async function showTrail(d) {
    const day = isoDate();
    const m = openModal({ title: `Location history — ${d.full_name}`, size: 'lg', footer: null, body: `<div class="row" style="margin-bottom:10px"><input type="date" data-day value="${day}" max="${day}" aria-label="Day"><span class="muted small" data-info></span></div><div class="map md" data-map></div>` });
    const tmap = await createMap(m.body.querySelector('[data-map]'), { center: d.lat !== null ? { lat: d.lat, lng: d.lng } : undefined, zoom: 13 }); let line = null;
    const load = async () => {
      const v = m.body.querySelector('[data-day]').value; const info = m.body.querySelector('[data-info]'); info.textContent = 'Loading…';
      try {
        const pts = await rpc('driver_location_trail', { p_driver_id: d.driver_id, p_from: new Date(`${v}T00:00:00`).toISOString(), p_to: new Date(`${v}T23:59:59.999`).toISOString() });
        info.textContent = pts?.length ? `${pts.length} recorded point(s) between ${dateTime(pts[0].recorded_at)} and ${dateTime(pts[pts.length - 1].recorded_at)}` : 'No location was recorded on this day.';
        line?.setMap(null);
        if (tmap && pts?.length) { const path = pts.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })); line = new window.google.maps.Polyline({ map: tmap, path, strokeColor: '#2563eb', strokeWeight: 4 }); fitTo(tmap, path); }
      } catch (e) { info.textContent = e.message; }
    };
    m.body.querySelector('[data-day]').onchange = load; load();
  }

  async function loadAlerts() {
    try {
      const r = await list('tracking_alerts', { pageSize: 15, apply: (q) => q.is('acknowledged_at', null) });
      await attach(r.rows, 'driver_id', 'drivers', 'id,full_name,driver_code', 'driver');
      $('#lt-alerts').innerHTML = r.rows.length ? r.rows.map((a) => `<div class="list-item" style="cursor:default"><span class="stat-ico ${['restricted_zone_entry', 'gps_disabled', 'location_sharing_stopped'].includes(a.alert_type) ? 'danger' : 'warning'}" style="width:32px;height:32px"><i class="fa-solid fa-triangle-exclamation"></i></span>
        <div><div class="cell-main">${esc(titleCase(a.alert_type))} — ${esc(a.driver?.full_name ?? 'Driver')}</div><div class="cell-sub">${esc(a.message)} · ${esc(ago(a.created_at))}</div></div>
        ${a.driver_id ? `<button class="btn btn-sm" data-show="${esc(a.driver_id)}">Show</button>` : ''}${can('tracking.view') ? `<button class="btn btn-sm" data-ack="${esc(a.id)}">Acknowledge</button>` : ''}</div>`).join('') + (r.count > r.rows.length ? `<p class="muted small" style="padding:10px 16px">${r.count - r.rows.length} more unacknowledged alert(s).</p>` : '')
        : emptyState({ icon: 'fa-circle-check', title: 'No open tracking alerts' });
    } catch (e) { $('#lt-alerts').innerHTML = errorState(e); }
  }
  $('#lt-alerts').addEventListener('click', async (e) => {
    const s = e.target.closest('[data-show]'); if (s) { choose(s.dataset.show); return; }
    const a = e.target.closest('[data-ack]'); if (!a) return;
    try { await rpc('acknowledge_tracking_alert', { p_alert_id: a.dataset.ack }); toast('success', 'Alert acknowledged.'); loadAlerts(); } catch (err) { showError(err); }
  });

  const tracker = createTracker({
    getFilters: () => ({ cityId: $('#lt-city').value, search: $('#lt-search').value.trim(), includeOffline: $('#lt-offline').checked }),
    onUpdate: (s) => {
      if (!alive) return; drivers = s.drivers;
      $('#lt-notice').querySelector('[data-conn]')?.remove();
      if (s.error) $('#lt-notice').insertAdjacentHTML('beforeend', `<div data-conn>${notice('danger', 'Could not refresh positions.', ` ${s.error.message} Showing the last received data.`)}</div>`);
      renderAll();
    },
    onStatus: (kind, v) => {
      if (kind === 'alert') { loadAlerts(); toast('warning', `Tracking alert: ${titleCase(v?.alert_type ?? '')}`); return; }
      const el = $('#lt-status'); if (!el) return;
      const ok = v === 'SUBSCRIBED'; el.className = `badge ${ok ? 'success' : 'warning'}`; el.textContent = ok ? 'Realtime connected' : 'Realtime reconnecting — refreshing every 15 s';
    },
  });
  $('#lt-list').addEventListener('click', (e) => { const it = e.target.closest('[data-id]'); if (it) choose(it.dataset.id); });
  $('#lt-list').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const it = e.target.closest('[data-id]'); if (it) choose(it.dataset.id); } });
  $('#lt-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; root.querySelectorAll('#lt-filter button').forEach((x) => x.classList.toggle('active', x === b)); renderAll(); });
  $('#lt-search').addEventListener('input', debounce(() => tracker.refresh(), 400));
  $('#lt-city').onchange = () => { firstFit = true; tracker.refresh(); loadZones(); };
  $('#lt-offline').onchange = () => tracker.refresh(); $('#lt-zones').onchange = loadZones;
  $('#lt-refresh').onclick = () => { tracker.refresh(); loadAlerts(); };
  $('#lt-fit').onclick = () => { if (map) fitTo(map, drivers.filter((d) => d.lat !== null)); };
  tracker.start(); loadZones(); loadAlerts();
  return () => { alive = false; tracker.stop(); cluster?.destroy(); clearOverlays(zoneOverlays); clearOverlays(rideOverlays); };
}
