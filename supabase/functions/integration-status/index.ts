// Reports which integrations have credentials, optionally running a harmless live check.
// Only the presence of a secret is reported — never its value.
import { admin, env, requireStaff, serve } from "../_shared/common.ts";

type Status = "not_configured" | "configured" | "healthy" | "error";
interface Check { kind: string; provider: string; needs: string[]; probe?: () => Promise<{ ok: boolean; error?: string }>; }

const probe = async (url: string, init: RequestInit, okStatuses = [200]) => {
  try { const r = await fetch(url, init); await r.body?.cancel(); return okStatuses.includes(r.status) ? { ok: true } : { ok: false, error: `Provider answered HTTP ${r.status}` }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : "network error" }; }
};

const CHECKS: Check[] = [
  { kind: "payment", provider: "razorpay", needs: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
    probe: () => probe("https://api.razorpay.com/v1/payments?count=1", { headers: { Authorization: `Basic ${btoa(`${env("RAZORPAY_KEY_ID")}:${env("RAZORPAY_KEY_SECRET")}`)}` } }) },
  { kind: "maps", provider: "google_maps", needs: ["GOOGLE_MAPS_SERVER_KEY"],
    probe: async () => {
      try {
        const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=India&key=${env("GOOGLE_MAPS_SERVER_KEY")}`);
        const b = await r.json(); return b.status === "OK" ? { ok: true } : { ok: false, error: `${b.status}: ${b.error_message ?? ""}`.slice(0, 200) };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "network error" }; }
    } },
  { kind: "push", provider: "fcm", needs: ["FIREBASE_SERVICE_ACCOUNT"] },
  { kind: "email", provider: "resend", needs: ["RESEND_API_KEY", "EMAIL_FROM"],
    probe: () => probe("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` } }) },
  { kind: "whatsapp", provider: "whatsapp_cloud", needs: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"] },
  { kind: "ai", provider: "openai_compatible", needs: ["AI_API_KEY"] },
  { kind: "cache", provider: "upstash_redis", needs: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] },
];
const SMS_NEEDS: Record<string, string[]> = {
  msg91: ["MSG91_AUTH_KEY", "MSG91_OTP_TEMPLATE_ID"], twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"],
  fast2sms: ["FAST2SMS_API_KEY", "FAST2SMS_SENDER_ID", "FAST2SMS_DLT_TEMPLATE_ID"],
};

serve(async (req, body) => {
  await requireStaff(req, "settings.view");
  const live = body.live_check === true;
  const sms = env("SMS_PROVIDER").toLowerCase();
  const checks: Check[] = [{ kind: "sms", provider: sms && SMS_NEEDS[sms] ? sms : "msg91", needs: sms && SMS_NEEDS[sms] ? ["SMS_PROVIDER", ...SMS_NEEDS[sms]] : ["SMS_PROVIDER"] }, ...CHECKS];
  const out = [];
  for (const c of checks) {
    const missing = c.needs.filter((k) => !env(k));
    let status: Status = missing.length ? "not_configured" : "configured"; let error: string | null = missing.length ? `Missing secret(s): ${missing.join(", ")}` : null;
    if (!missing.length && live && c.probe) { const r = await c.probe(); status = r.ok ? "healthy" : "error"; error = r.ok ? null : r.error ?? "check failed"; }
    await admin().rpc("report_integration_status", { p_kind: c.kind, p_provider: c.provider, p_status: status, p_error: error });
    out.push({ kind: c.kind, provider: c.provider, status, missing, error, live_checked: !missing.length && live && !!c.probe });
  }
  return { ok: true, checked_at: new Date().toISOString(), integrations: out };
});
