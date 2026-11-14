// Provider-independent SMS layer. Choose the provider with the SMS_PROVIDER secret.
// Indian A2P SMS needs DLT registration: an approved sender ID (header) and template.
// With no credentials the result is "not_configured" — we never pretend an SMS was sent.
import { env, logIntegration } from "./common.ts";

export interface SmsResult { status: "sent" | "failed" | "not_configured"; provider: string; messageId?: string; error?: string; }
export interface OtpSms { phone: string; otp: string; minutes: number; appName: string; }

const normalise = (phone: string) => { const d = phone.replace(/\D/g, ""); return d.length === 10 ? `91${d}` : d; };

async function msg91(m: OtpSms): Promise<SmsResult> {
  const key = env("MSG91_AUTH_KEY"), template = env("MSG91_OTP_TEMPLATE_ID");
  if (!key || !template) return { status: "not_configured", provider: "msg91", error: "MSG91_AUTH_KEY / MSG91_OTP_TEMPLATE_ID not set" };
  // MSG91 Flow API: the DLT-approved template holds the wording; we pass only variables.
  const res = await fetch("https://control.msg91.com/api/v5/flow", {
    method: "POST", headers: { authkey: key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ template_id: template, short_url: "0", recipients: [{ mobiles: normalise(m.phone), otp: m.otp, minutes: String(m.minutes), app: m.appName }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.type === "success") return { status: "sent", provider: "msg91", messageId: String(body.message ?? "") };
  return { status: "failed", provider: "msg91", error: `HTTP ${res.status}: ${String(body?.message ?? "request rejected")}` };
}

async function twilio(m: OtpSms): Promise<SmsResult> {
  const sid = env("TWILIO_ACCOUNT_SID"), token = env("TWILIO_AUTH_TOKEN"), from = env("TWILIO_FROM");
  if (!sid || !token || !from) return { status: "not_configured", provider: "twilio", error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM not set" };
  const text = `Your ${m.appName} ride OTP is ${m.otp}. Share it with your driver only after you board. Valid for ${m.minutes} minutes.`;
  const callback = env("SMS_STATUS_CALLBACK_URL");
  const form = new URLSearchParams({ To: `+${normalise(m.phone)}`, From: from, Body: text, ...(callback ? { StatusCallback: callback } : {}) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.sid) return { status: "sent", provider: "twilio", messageId: body.sid };
  return { status: "failed", provider: "twilio", error: `HTTP ${res.status}: ${String(body?.message ?? "request rejected")}` };
}

async function fast2sms(m: OtpSms): Promise<SmsResult> {
  const key = env("FAST2SMS_API_KEY"), sender = env("FAST2SMS_SENDER_ID"), template = env("FAST2SMS_DLT_TEMPLATE_ID");
  if (!key || !sender || !template) return { status: "not_configured", provider: "fast2sms", error: "FAST2SMS_API_KEY / FAST2SMS_SENDER_ID / FAST2SMS_DLT_TEMPLATE_ID not set" };
  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST", headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ route: "dlt", sender_id: sender, message: template, variables_values: `${m.otp}|${m.minutes}`, numbers: normalise(m.phone).slice(-10) }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body?.return === true) return { status: "sent", provider: "fast2sms", messageId: String(body.request_id ?? "") };
  return { status: "failed", provider: "fast2sms", error: `HTTP ${res.status}: ${String(body?.message ?? "request rejected")}` };
}

const PROVIDERS: Record<string, (m: OtpSms) => Promise<SmsResult>> = { msg91, twilio, fast2sms };

export function smsProviderName(): string { return env("SMS_PROVIDER").toLowerCase(); }

export async function sendOtpSms(m: OtpSms): Promise<SmsResult> {
  const name = smsProviderName();
  if (!name) return { status: "not_configured", provider: "none", error: "SMS_PROVIDER secret is not set" };
  const fn = PROVIDERS[name];
  if (!fn) return { status: "not_configured", provider: name, error: `Unknown SMS provider "${name}". Use msg91, twilio or fast2sms.` };
  const started = Date.now();
  let result: SmsResult;
  try { result = await fn(m); } catch (e) { result = { status: "failed", provider: name, error: e instanceof Error ? e.message : "network error" }; }
  await logIntegration("sms", name, "send_otp", result.status === "sent" ? "ok" : result.status === "not_configured" ? "not_configured" : "error",
    { ms: Date.now() - started, error: result.error, reference: result.messageId });
  return result;
}
