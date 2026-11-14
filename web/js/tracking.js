// Live tracking data source. Combines:
//   1. tracking_snapshot() — an authoritative snapshot (freshness is judged by the SERVER clock);
//   2. Supabase Realtime on driver_locations — position updates between snapshots.
// The age of every position keeps counting locally, so a driver who stops sending
// turns "delayed" and then "stale" on screen without waiting for the next snapshot.
import { rpc, subscribe } from './api.js';

export function createTracker({ onUpdate, onStatus, getFilters = () => ({}), pollMs = 15000 }) {
  let drivers = new Map(), liveSeconds = 45, staleSeconds = 180, clockOffset = 0;
  let poll = null, tick = null, unsub = null, stopped = false, lastError = null, lastSnapshotAt = null, inflight = false;

  const classify = (d) => {
    if (d.freshness === 'no_data' || !d.received_at) return 'no_data';
    if (d.availability === 'offline') return 'offline';
    if (d.is_sharing === false) return 'not_sharing';
    const age = Math.max(0, Math.round((Date.now() + clockOffset - new Date(d.received_at).getTime()) / 1000));
    d.age_seconds = age;
    return age <= liveSeconds ? 'live' : age <= staleSeconds ? 'delayed' : 'stale';
  };
  const emit = () => { if (!stopped) onUpdate({ drivers: [...drivers.values()], liveSeconds, staleSeconds, lastSnapshotAt, error: lastError }); };

  async function refresh() {
    if (inflight || stopped) return;
    inflight = true;
    try {
      const f = getFilters();
      const snap = await rpc('tracking_snapshot', { p_city_id: f.cityId || null, p_search: f.search || null, p_include_offline: !!f.includeOffline });
      if (stopped) return;
      clockOffset = new Date(snap.server_time).getTime() - Date.now();
      liveSeconds = snap.live_seconds; staleSeconds = snap.stale_seconds;
      drivers = new Map((snap.drivers ?? []).map((d) => [d.driver_id, { ...d, lat: d.lat === null ? null : Number(d.lat), lng: d.lng === null ? null : Number(d.lng) }]));
      lastSnapshotAt = new Date(); lastError = null;
    } catch (e) { lastError = e; }
    finally { inflight = false; emit(); }
  }

  function start() {
    stopped = false;
    refresh();
    poll = setInterval(() => { if (!document.hidden) refresh(); }, pollMs);
    // Re-classify ages every 5 s so "live" can never outlive the data.
    tick = setInterval(() => { let changed = false; for (const d of drivers.values()) { const f = classify(d); if (f !== d.freshness) { d.freshness = f; changed = true; } } emit(changed); }, 5000);
    unsub = subscribe('tracking', [{ table: 'driver_locations' }, { table: 'tracking_alerts', event: 'INSERT' }], (p) => {
      if (p.table === 'tracking_alerts') { onStatus?.('alert', p.new); return; }
      const row = p.new; const d = row && drivers.get(row.driver_id);
      if (!d) { if (row && p.eventType === 'INSERT') refresh(); return; }
      Object.assign(d, { lat: Number(row.lat), lng: Number(row.lng), speed_kmh: row.speed_kmh, heading: row.heading, accuracy_m: row.accuracy_m, battery_pct: row.battery_pct,
        is_sharing: row.is_sharing, gps_status: row.gps_status, recorded_at: row.recorded_at, received_at: row.received_at });
      d.freshness = classify(d); d.is_idle = d.availability === 'online' && Number(row.speed_kmh ?? 0) < 3;
      emit();
    }, (s) => onStatus?.('realtime', s));
    document.addEventListener('visibilitychange', onVisible);
  }
  const onVisible = () => { if (!document.hidden) refresh(); };
  function stop() { stopped = true; clearInterval(poll); clearInterval(tick); unsub?.(); document.removeEventListener('visibilitychange', onVisible); }

  return { start, stop, refresh, get: (id) => drivers.get(id) };
}

/** Rough ETA from straight-line distance and current speed. Clearly an estimate. */
export function roughEta(from, to, speedKmh) {
  if (!from || !to || [from.lat, from.lng, to.lat, to.lng].some((v) => v === null || v === undefined)) return null;
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat), dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const straight = 2 * R * Math.asin(Math.sqrt(a)); const road = straight * 1.3;
  const speed = Math.max(15, Math.min(60, Number(speedKmh) || 25));
  return { km: road, minutes: Math.max(1, Math.round((road / speed) * 60)) };
}
