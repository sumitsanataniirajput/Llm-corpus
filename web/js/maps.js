// Google Maps loader and helpers. With no API key, or when Google rejects the key,
// map areas show a clear explanation instead of a fake or blank map.
import { config, AppError } from './supabase-client.js';
import { esc } from './utilities.js';

let loading = null, authFailed = false;
export const mapsConfigured = () => !!config.GOOGLE_MAPS_API_KEY;

export function loadMaps() {
  if (!mapsConfigured()) return Promise.reject(new AppError('MAPS_NOT_CONFIGURED', 'Google Maps API key is not set in js/config.js.'));
  if (authFailed) return Promise.reject(new AppError('MAPS_AUTH_FAILED', 'Google rejected the Maps API key (check billing, enabled APIs and website restrictions).'));
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  loading ??= new Promise((resolve, reject) => {
    window.gm_authFailure = () => { authFailed = true; window.dispatchEvent(new CustomEvent('rms:maps-auth-failed')); };
    window.__rmsMapsReady = () => resolve(window.google.maps);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.GOOGLE_MAPS_API_KEY)}&libraries=places,geometry&region=IN&language=en&v=weekly&loading=async&callback=__rmsMapsReady`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new AppError('MAPS_LOAD_FAILED', 'Google Maps could not be loaded. Check the internet connection or content blockers.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export const mapUnavailable = (e) => `<div class="state"><i class="fa-solid fa-map"></i><h4>Map unavailable</h4><p>${esc(e?.message ?? 'Google Maps is not configured.')}</p>
  <p class="small">The data on this page is still real and is listed in the tables. To enable the map, add <code>GOOGLE_MAPS_API_KEY</code> in <code>js/config.js</code> (see SETUP.md, step “Google Maps”).</p></div>`;

const DARK = [{ elementType: 'geometry', stylers: [{ color: '#1d2538' }] }, { elementType: 'labels.text.fill', stylers: [{ color: '#9aa7bd' }] }, { elementType: 'labels.text.stroke', stylers: [{ color: '#121a2b' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c3852' }] }, { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] }, { featureType: 'poi', stylers: [{ visibility: 'off' }] }];

/** Create a map inside `container`. On failure the container shows the reason and null is returned. */
export async function createMap(container, { center = { lat: 26.8467, lng: 80.9462 }, zoom = 12, ...rest } = {}) {
  try {
    const maps = await loadMaps();
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const map = new maps.Map(container, { center, zoom, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, gestureHandling: 'greedy', clickableIcons: false,
      ...(config.GOOGLE_MAPS_MAP_ID ? { mapId: config.GOOGLE_MAPS_MAP_ID } : { styles: dark ? DARK : [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }] }), ...rest });
    const onFail = () => { container.innerHTML = mapUnavailable(new AppError('MAPS_AUTH_FAILED', 'Google rejected the Maps API key (check billing, enabled APIs and website restrictions).')); };
    window.addEventListener('rms:maps-auth-failed', onFail, { once: true });
    return map;
  } catch (e) { container.innerHTML = mapUnavailable(e); return null; }
}

const COLORS = { live: '#15803d', delayed: '#d97706', stale: '#b91c1c', offline: '#64748b', not_sharing: '#64748b', no_data: '#64748b', on_ride: '#2563eb' };
/** Arrow that points in the direction of travel, coloured by data freshness. */
export function vehicleIcon(maps, { freshness = 'live', heading = 0, onRide = false, selected = false }) {
  const color = freshness === 'live' && onRide ? COLORS.on_ride : COLORS[freshness] ?? COLORS.offline;
  return { path: maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: selected ? 7.5 : 5.5, rotation: Number(heading) || 0, fillColor: color, fillOpacity: freshness === 'live' ? 1 : .65, strokeColor: '#ffffff', strokeWeight: 2 };
}
export const pinIcon = (maps, color, label = '') => ({ url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40"><path d="M15 0C6.7 0 0 6.6 0 14.8 0 25.9 15 40 15 40s15-14.1 15-25.2C30 6.6 23.3 0 15 0z" fill="${color}"/><circle cx="15" cy="15" r="9" fill="#fff"/><text x="15" y="19.5" font-size="12" font-family="Arial" font-weight="700" text-anchor="middle" fill="${color}">${label}</text></svg>`)}`, scaledSize: new maps.Size(30, 40), anchor: new maps.Point(15, 40) });

export function fitTo(map, points, maxZoom = 16) {
  const maps = window.google.maps; const pts = points.filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  if (!pts.length) return;
  if (pts.length === 1) { map.setCenter({ lat: Number(pts[0].lat), lng: Number(pts[0].lng) }); map.setZoom(Math.min(maxZoom, 15)); return; }
  const b = new maps.LatLngBounds(); pts.forEach((p) => b.extend({ lat: Number(p.lat), lng: Number(p.lng) }));
  map.fitBounds(b, 56);
  maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
}

/**
 * Grid clustering without an extra library: at low zoom, markers that fall into the same
 * screen cell are replaced by one counter bubble. Call update(items) whenever data changes.
 * items: [{ id, lat, lng, icon, title, zIndex, data }]
 */
export function createClusterer(map, { onClick, minClusterZoom = 13, cell = 64 } = {}) {
  const maps = window.google.maps; const markers = new Map(); const bubbles = []; let items = [];
  const project = (lat, lng, zoom) => { const s = 256 * 2 ** zoom; const siny = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999); return { x: s * (0.5 + lng / 360), y: s * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) }; };
  function draw() {
    bubbles.splice(0).forEach((b) => b.setMap(null));
    const zoom = map.getZoom() ?? 12; const cluster = zoom < minClusterZoom && items.length > 25;
    const groups = new Map(); const seen = new Set();
    for (const it of items) {
      const key = cluster ? (() => { const p = project(it.lat, it.lng, zoom); return `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`; })() : `single:${it.id}`;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it);
    }
    for (const group of groups.values()) {
      if (group.length === 1) {
        const it = group[0]; seen.add(it.id);
        let m = markers.get(it.id);
        if (!m) { m = new maps.Marker({ map, optimized: true }); m.addListener('click', () => onClick?.(m.__item)); markers.set(it.id, m); }
        m.__item = it; m.setPosition({ lat: it.lat, lng: it.lng }); m.setIcon(it.icon); m.setTitle(it.title ?? ''); m.setZIndex(it.zIndex ?? 1); if (!m.getMap()) m.setMap(map);
      } else {
        const lat = group.reduce((a, g) => a + g.lat, 0) / group.length, lng = group.reduce((a, g) => a + g.lng, 0) / group.length;
        const b = new maps.Marker({ map, position: { lat, lng }, label: { text: String(group.length), color: '#fff', fontWeight: '700', fontSize: '12px' }, zIndex: 5,
          icon: { path: maps.SymbolPath.CIRCLE, scale: Math.min(26, 13 + Math.log2(group.length) * 3), fillColor: '#2563eb', fillOpacity: .9, strokeColor: '#fff', strokeWeight: 3 }, title: `${group.length} vehicles — click to zoom` });
        b.addListener('click', () => fitTo(map, group, 15)); bubbles.push(b);
      }
    }
    for (const [id, m] of markers) if (!seen.has(id)) { m.setMap(null); if (!items.some((i) => i.id === id)) markers.delete(id); }
  }
  const listener = map.addListener('zoom_changed', draw);
  return { update(next) { items = next.filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lng)); draw(); },
    marker: (id) => markers.get(id), destroy() { listener.remove(); markers.forEach((m) => m.setMap(null)); markers.clear(); bubbles.forEach((b) => b.setMap(null)); } };
}

const ZONE_COLORS = { operating: '#2563eb', service_boundary: '#0f766e', restricted: '#b91c1c', airport: '#7c3aed', railway: '#b45309', surge: '#db2777', geofence: '#0369a1' };
export const zoneColor = (type) => ZONE_COLORS[type] ?? '#475569';
/** Draw zone polygons ([{id,name,zone_type,polygon:[{lat,lng}]}]). Returns the created polygons. */
export function drawZones(map, zones, { onClick } = {}) {
  const maps = window.google.maps;
  return zones.filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 3).map((z) => {
    const c = zoneColor(z.zone_type);
    const poly = new maps.Polygon({ map, paths: z.polygon.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })), strokeColor: c, strokeWeight: 2, strokeOpacity: z.is_active === false ? .35 : .9,
      fillColor: c, fillOpacity: z.zone_type === 'service_boundary' ? .03 : z.is_active === false ? .04 : .14, clickable: !!onClick, zIndex: z.zone_type === 'service_boundary' ? 1 : 2 });
    if (onClick) poly.addListener('click', () => onClick(z));
    return poly;
  });
}
/** Click-to-draw polygon editor. Returns { getPath(), clear(), destroy() }. */
export function polygonEditor(map, initial = [], color = '#2563eb') {
  const maps = window.google.maps;
  const poly = new maps.Polygon({ map, paths: initial.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })), editable: true, draggable: false, strokeColor: color, fillColor: color, fillOpacity: .18, strokeWeight: 2, zIndex: 10 });
  const click = map.addListener('click', (e) => poly.getPath().push(e.latLng));
  const remove = poly.addListener('rightclick', (e) => { if (e.vertex !== undefined && e.vertex !== null) poly.getPath().removeAt(e.vertex); });
  return { getPath: () => poly.getPath().getArray().map((p) => ({ lat: Number(p.lat().toFixed(6)), lng: Number(p.lng().toFixed(6)) })),
    clear: () => poly.getPath().clear(), undo: () => { const p = poly.getPath(); if (p.getLength()) p.pop(); },
    destroy: () => { click.remove(); remove.remove(); poly.setMap(null); } };
}
/** Demand heat cells drawn as translucent circles (no deprecated heatmap library needed). */
export function drawHeat(map, cells) {
  const maps = window.google.maps; const max = Math.max(1, ...cells.map((c) => Number(c.count)));
  return cells.map((c) => new maps.Circle({ map, center: { lat: Number(c.lat), lng: Number(c.lng) }, radius: 180 + 520 * Math.sqrt(Number(c.count) / max), strokeWeight: 0,
    fillColor: Number(c.count) / max > .66 ? '#dc2626' : Number(c.count) / max > .33 ? '#f59e0b' : '#2563eb', fillOpacity: .18 + .32 * (Number(c.count) / max), clickable: false }));
}
export const clearOverlays = (list) => { (list ?? []).forEach((o) => o?.setMap?.(null)); return []; };

/** Places autocomplete on an <input>; calls onPick({address, lat, lng}). Returns false when unavailable. */
export async function attachAutocomplete(input, onPick, bias = null) {
  try {
    const maps = await loadMaps();
    if (!maps.places?.Autocomplete) return false;
    const ac = new maps.places.Autocomplete(input, { componentRestrictions: { country: 'in' }, fields: ['formatted_address', 'geometry', 'name'] });
    if (bias) ac.setBounds(new maps.Circle({ center: bias, radius: 40000 }).getBounds());
    ac.addListener('place_changed', () => { const p = ac.getPlace(); if (p?.geometry?.location) onPick({ address: p.formatted_address || p.name, lat: Number(p.geometry.location.lat().toFixed(6)), lng: Number(p.geometry.location.lng().toFixed(6)) }); });
    return true;
  } catch { return false; }
}
