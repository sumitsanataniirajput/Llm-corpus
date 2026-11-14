// Razorpay webhook receiver — the ONLY place a payment becomes "captured".
// Deploy with --no-verify-jwt. Security comes from the HMAC signature over the raw body,
// verified with RAZORPAY_WEBHOOK_SECRET. Unsigned / mismatching events change nothing.
// Replays are harmless: every event id is stored once (unique provider + event_id).
import { admin, env, hmacSha256Hex, json, logIntegration, timingSafeEqual } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, { ok: false }, 405);
  const secret = env("RAZORPAY_WEBHOOK_SECRET");
  const raw = await req.text();
  if (!secret) {
    await logIntegration("payment", "razorpay", "webhook", "not_configured", { direction: "inbound", error: "RAZORPAY_WEBHOOK_SECRET not set" });
    return json(req, { ok: false, code: "NOT_CONFIGURED" }, 503);
  }
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const valid = signature.length > 0 && timingSafeEqual(await hmacSha256Hex(secret, raw), signature);

  let evt: Record<string, any>;
  try { evt = JSON.parse(raw); } catch { return json(req, { ok: false, code: "INVALID_JSON" }, 400); }
  const type = String(evt.event ?? "");
  const pay = evt.payload?.payment?.entity, ref = evt.payload?.refund?.entity;
  const eventId = req.headers.get("x-razorpay-event-id") ?? `${type}:${ref?.id ?? pay?.id ?? ""}:${evt.created_at ?? ""}`;
  const kind = type === "payment.captured" || type === "order.paid" ? "payment_captured"
    : type === "payment.failed" ? "payment_failed" : type === "refund.processed" ? "refund_processed" : type === "refund.failed" ? "refund_failed" : "other";

  // Store only what reconciliation needs — never card or bank details.
  const slim = { event: type, created_at: evt.created_at, payment: pay ? { id: pay.id, order_id: pay.order_id, amount: pay.amount, currency: pay.currency, status: pay.status, method: pay.method, error_code: pay.error_code } : null,
    refund: ref ? { id: ref.id, payment_id: ref.payment_id, amount: ref.amount, status: ref.status } : null };

  const { data, error } = await admin().rpc("apply_payment_webhook", { p_provider: "razorpay", p_event_id: eventId, p_event_type: type, p_signature_valid: valid,
    p_payload: slim, p_kind: kind, p_order_id: pay?.order_id ?? null, p_payment_id: pay?.id ?? ref?.payment_id ?? null, p_amount_paise: pay?.amount ?? ref?.amount ?? null,
    p_method: pay?.method ?? null, p_refund_id: ref?.id ?? null, p_failure_reason: pay?.error_description ?? null });
  await logIntegration("payment", "razorpay", `webhook:${type}`, error || !valid ? "error" : "ok", { direction: "inbound", error: error?.message ?? (valid ? undefined : "invalid signature"), reference: eventId });

  if (!valid) return json(req, { ok: false, code: "INVALID_SIGNATURE" }, 401);
  if (error) return json(req, { ok: false, code: "PROCESSING_FAILED" }, 500);      // gateway will retry
  return json(req, data ?? { ok: true });
});
