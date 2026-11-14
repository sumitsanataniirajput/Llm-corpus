// Payment gateway operations that need the secret key: create an order, execute a refund.
// A payment is marked successful ONLY by the signed webhook (see payment-webhook), never here
// and never by the browser or the Android app.
import { admin, call, env, HttpError, logIntegration, requireStaff, requireUser, serve, str, uuid } from "../_shared/common.ts";

function razorpayAuth(): string {
  const id = env("RAZORPAY_KEY_ID"), secret = env("RAZORPAY_KEY_SECRET");
  if (!id || !secret) throw new HttpError(503, "PAYMENT_GATEWAY_NOT_CONFIGURED", "Online payments are not configured yet. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as Edge Function secrets.");
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

async function razorpay(path: string, payload: Record<string, unknown>, idempotencyKey: string, op: string) {
  const started = Date.now();
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, { method: "POST",
    headers: { Authorization: razorpayAuth(), "content-type": "application/json", "X-Razorpay-Idempotency-Key": idempotencyKey, "X-Payout-Idempotency": idempotencyKey },
    body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  await logIntegration("payment", "razorpay", op, res.ok ? "ok" : "error", { http: res.status, ms: Date.now() - started,
    error: res.ok ? undefined : String(body?.error?.description ?? "request rejected"), reference: String(body?.id ?? "") });
  return { ok: res.ok, status: res.status, body };
}

serve(async (req, body) => {
  const action = str(body.action, "action", 1, 30);
  const db = admin();

  if (action === "create_order") {
    // Customer (own booking) or staff. The amount comes from the database, never from the request.
    const caller = await requireUser(req);
    const bookingId = uuid(body.booking_id, "booking_id");
    const { data: b } = await db.from("bookings").select("id, booking_code, status, total_fare_paise, customers:customer_id(user_id)").eq("id", bookingId).maybeSingle();
    if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", "Booking not found");
    if ((b.customers as { user_id?: string } | null)?.user_id !== caller.userId) await requireStaff(req, "finance.record_payment");
    if (b.status !== "PAYMENT_PENDING") throw new HttpError(400, "INVALID_STATE", "This booking is not awaiting payment");
    const { data: pay } = await db.from("payments").select("id, amount_paise, currency, status, provider_order_id").eq("booking_id", bookingId).maybeSingle();
    if (!pay) throw new HttpError(404, "PAYMENT_NOT_FOUND", "No payment record for this booking");
    if (pay.provider_order_id && pay.status !== "failed") {
      return { ok: true, reused: true, order_id: pay.provider_order_id, amount_paise: pay.amount_paise, currency: pay.currency, key_id: env("RAZORPAY_KEY_ID") };
    }
    const r = await razorpay("orders", { amount: Number(pay.amount_paise), currency: pay.currency ?? "INR", receipt: b.booking_code, notes: { booking_id: bookingId } },
      `order:${pay.id}:${pay.status}`, "create_order");
    if (!r.ok) throw new HttpError(502, "GATEWAY_ERROR", "The payment gateway rejected the order. Nothing was charged.");
    const attached = await call<Record<string, unknown>>(db.rpc("payment_attach_order", { p_booking_id: bookingId, p_provider: "razorpay", p_order_id: r.body.id, p_method: null }));
    return { ok: true, order_id: r.body.id, amount_paise: attached.amount_paise, currency: attached.currency, key_id: env("RAZORPAY_KEY_ID") };   // key_id is the PUBLIC key
  }

  if (action === "execute_refund") {
    // Step 2 of a refund. Step 1 (request_refund RPC) already validated limits and reserved the amount.
    await requireStaff(req, "finance.refund");
    const refundId = uuid(body.refund_id, "refund_id");
    const { data: r } = await db.from("refunds").select("id, status, amount_paise, idempotency_key, provider_refund_id, payments:payment_id(provider, provider_payment_id, method)").eq("id", refundId).maybeSingle();
    if (!r) throw new HttpError(404, "REFUND_NOT_FOUND", "Refund not found");
    if (r.status === "completed") return { ok: true, status: "completed", duplicate: true };
    if (r.status === "processing") return { ok: true, status: "processing", duplicate: true, message: "Already sent to the gateway. Waiting for confirmation." };
    const p = r.payments as { provider?: string; provider_payment_id?: string } | null;
    if (p?.provider !== "razorpay" || !p.provider_payment_id) throw new HttpError(400, "NOT_GATEWAY_PAYMENT", "This payment was not taken through the gateway");
    const res = await razorpay(`payments/${p.provider_payment_id}/refund`, { amount: Number(r.amount_paise), speed: "normal", notes: { refund_id: refundId } },
      `refund:${r.idempotency_key}`, "refund");
    if (!res.ok) {
      await call(db.rpc("refund_gateway_result", { p_refund_id: refundId, p_state: "failed", p_provider_refund_id: null, p_failure_reason: String(res.body?.error?.description ?? `Gateway HTTP ${res.status}`) }));
      throw new HttpError(502, "GATEWAY_ERROR", "The gateway rejected the refund. No money was moved.");
    }
    // Razorpay answers "processed" for instant refunds, otherwise "pending" and confirms later by webhook.
    const state = res.body.status === "processed" ? "completed" : "processing";
    await call(db.rpc("refund_gateway_result", { p_refund_id: refundId, p_state: state, p_provider_refund_id: res.body.id, p_failure_reason: null }));
    return { ok: true, status: state, provider_refund_id: res.body.id };
  }

  throw new HttpError(400, "UNKNOWN_ACTION", "action must be create_order or execute_refund");
});
