// Delivery-status callbacks from the SMS provider.
// Configure the provider to call:  https://<project>.functions.supabase.co/sms-webhook?token=<SMS_WEBHOOK_TOKEN>
// (deploy with --no-verify-jwt; the shared token authenticates the provider).
import { admin, env, json, logIntegration, timingSafeEqual } from "../_shared/common.ts";

const MAP: Record<string, string> = {
  delivered: "delivered", delivrd: "delivered", "1": "delivered", sent: "sent", queued: "sent", accepted: "sent",
  failed: "failed", undelivered: "failed", rejected: "failed", "2": "failed", expired: "failed", ndnc: "failed", blocked: "failed",
};

Deno.serve(async (req) => {
  const expected = env("SMS_WEBHOOK_TOKEN");
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!expected || !timingSafeEqual(token, expected)) return json(req, { ok: false, code: "UNAUTHORIZED" }, 401);

  const provider = (new URL(req.url).searchParams.get("provider") ?? env("SMS_PROVIDER") ?? "unknown").toLowerCase();
  const raw = await req.text();
  const updates: { id: string; status: string; error?: string }[] = [];
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {             // Twilio
      const p = new URLSearchParams(raw);
      updates.push({ id: p.get("MessageSid") ?? "", status: (p.get("MessageStatus") ?? "").toLowerCase(), error: p.get("ErrorCode") ?? undefined });
    } else {
      const data = JSON.parse(raw || "{}");
      const rows = Array.isArray(data) ? data : [data];
      for (const r of rows) {
        const reports = Array.isArray(r.report) ? r.report : [r];       // MSG91 groups by requestId
        for (const x of reports) updates.push({ id: String(r.requestId ?? r.request_id ?? x.requestId ?? x.message_id ?? x.id ?? ""),
          status: String(x.status ?? x.desc ?? "").toLowerCase(), error: x.desc ? String(x.desc) : undefined });
      }
    }
  } catch {
    return json(req, { ok: false, code: "INVALID_PAYLOAD" }, 400);
  }

  let matched = 0;
  for (const u of updates) {
    const status = MAP[u.status];
    if (!u.id || !status) continue;
    const { data } = await admin().rpc("otp_update_delivery_status", { p_provider: provider, p_provider_message_id: u.id, p_status: status,
      p_error: status === "failed" ? (u.error ?? "Provider reported failure") : null });
    if (data === true) matched++;
  }
  await logIntegration("sms", provider, "delivery_report", "ok", { direction: "inbound", reference: `${matched}/${updates.length}` });
  return json(req, { ok: true, matched });
});
