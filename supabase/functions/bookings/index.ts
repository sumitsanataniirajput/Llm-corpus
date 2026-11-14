// Booking creation / fare quote with a ROAD distance from Google Routes.
// The distance and fare are computed here and in the database — the caller cannot supply them.
// Without GOOGLE_MAPS_SERVER_KEY the database falls back to a straight-line estimate and
// labels the booking distance_source = "haversine_estimate".
import { admin, call, env, HttpError, logIntegration, requireStaff, requireUser, serve, str, uuid } from "../_shared/common.ts";

const num = (v: unknown, name: string, min: number, max: number) => {
  const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, "INVALID_INPUT", `${name} is not valid`); return n;
};

async function route(oLat: number, oLng: number, dLat: number, dLng: number) {
  const key = env("GOOGLE_MAPS_SERVER_KEY");
  if (!key) return null;
  const started = Date.now();
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", { method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline" },
    body: JSON.stringify({ origin: { location: { latLng: { latitude: oLat, longitude: oLng } } }, destination: { location: { latLng: { latitude: dLat, longitude: dLng } } },
      travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", regionCode: "IN" }) }).catch(() => null);
  const data = await res?.json().catch(() => null);
  const r = data?.routes?.[0];
  await logIntegration("maps", "google_maps", "compute_route", res?.ok && r ? "ok" : "error", { http: res?.status, ms: Date.now() - started, error: res?.ok ? (r ? undefined : "no route") : String(data?.error?.message ?? "request failed") });
  if (!res?.ok || !r?.distanceMeters) return null;
  return { km: Math.round(r.distanceMeters) / 1000, minutes: Math.max(1, Math.round(parseInt(String(r.duration ?? "0"), 10) / 60)), polyline: r.polyline?.encodedPolyline ?? null };
}

serve(async (req, body) => {
  const action = str(body.action, "action", 1, 20);
  const caller = await requireUser(req);
  const db = admin();
  const pLat = num(body.pickup_lat, "pickup_lat", -90, 90), pLng = num(body.pickup_lng, "pickup_lng", -180, 180);
  const dLat = num(body.drop_lat, "drop_lat", -90, 90), dLng = num(body.drop_lng, "drop_lng", -180, 180);
  const categoryId = uuid(body.category_id, "category_id"), cityId = uuid(body.city_id, "city_id");
  const r = await route(pLat, pLng, dLat, dLng);

  if (action === "quote") {
    let km = r?.km;
    if (km == null) {
      const [{ data: h }, { data: f }] = await Promise.all([db.rpc("haversine_km", { lat1: pLat, lng1: pLng, lat2: dLat, lng2: dLng }), db.from("system_settings").select("value").eq("key", "rides.road_distance_factor").maybeSingle()]);
      km = Math.round(Number(h) * Number(f?.value ?? 1.3) * 100) / 100;
    }
    const { data: fare, error } = await caller.client.rpc("calculate_fare", { p_category_id: categoryId, p_city_id: cityId, p_distance_km: km, p_duration_min: r?.minutes ?? Math.ceil(km * 3),
      p_pickup_lat: pLat, p_pickup_lng: pLng });
    if (error) throw new Error(error.message);
    return { ok: true, distance_km: km, duration_min: r?.minutes ?? null, distance_source: r ? "google_routes" : "haversine_estimate", polyline: r?.polyline ?? null, fare };
  }

  if (action === "create") {
    const customerId = uuid(body.customer_id, "customer_id");
    // Who is asking? A customer for themselves, or staff with rides.create.
    const { data: cust } = await db.from("customers").select("user_id").eq("id", customerId).maybeSingle();
    let staffId: string | null = null;
    if (cust?.user_id !== caller.userId) staffId = (await requireStaff(req, "rides.create")).staffId;
    const booking = await call(db.rpc("create_booking", { p_customer_id: customerId, p_category_id: categoryId, p_city_id: cityId,
      p_pickup_address: str(body.pickup_address, "pickup_address", 3, 500), p_pickup_lat: pLat, p_pickup_lng: pLng,
      p_drop_address: str(body.drop_address, "drop_address", 3, 500), p_drop_lat: dLat, p_drop_lng: dLng,
      p_payment_method: typeof body.payment_method === "string" ? body.payment_method : "cash",
      p_coupon_code: typeof body.coupon_code === "string" && body.coupon_code.trim() ? body.coupon_code.trim() : null,
      p_scheduled_for: typeof body.scheduled_for === "string" && body.scheduled_for ? body.scheduled_for : null,
      p_route_distance_km: r?.km ?? null, p_route_duration_min: r?.minutes ?? null, p_encoded_polyline: r?.polyline ?? null, p_actor_staff_id: staffId }));
    return { ok: true, booking };
  }
  throw new HttpError(400, "UNKNOWN_ACTION", "action must be quote or create");
});
