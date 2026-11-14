// Delivers a notification that already exists in the database (created by the
// send_notification RPC, which enforced permissions) over push / e-mail.
// Every channel result is written to notification_delivery_logs exactly as it happened.
import { admin, call, env, HttpError, logIntegration, requireStaff, serve, uuid } from "../_shared/common.ts";
import { sendPush } from "../_shared/fcm.ts";

const MAX_RECIPIENTS = 5000;

serve(async (req, body) => {
  await requireStaff(req, "notifications.send");
  const id = uuid(body.notification_id, "notification_id");
  const db = admin();
  const { data: n } = await db.from("notifications").select("*").eq("id", id).maybeSingle();
  if (!n) throw new HttpError(404, "NOT_FOUND", "Notification not found");
  if (n.dispatch_status !== "pending") return { ok: true, duplicate: true, dispatch_status: n.dispatch_status };

  // Resolve the audience to auth user ids.
  let userIds: string[] = []; let emails: string[] = [];
  const pick = async (table: string, filter: (q: any) => any, cols = "user_id, email") => {
    const { data } = await filter(db.from(table).select(cols)).limit(MAX_RECIPIENTS);
    return (data ?? []) as { user_id: string | null; email: string | null }[];
  };
  let rows: { user_id: string | null; email: string | null }[] = [];
  const cityFilter = (q: any) => (n.city_id ? q.eq("city_id", n.city_id) : q);
  if (n.audience === "staff") rows = await pick("staff_accounts", (q) => q.eq("id", n.recipient_staff_id));
  else if (n.audience === "driver") rows = await pick("drivers", (q) => q.eq("id", n.recipient_driver_id));
  else if (n.audience === "customer") rows = await pick("customers", (q) => q.eq("id", n.recipient_customer_id));
  else if (n.audience === "all_staff") rows = await pick("staff_accounts", (q) => q.eq("status", "active"));
  else if (n.audience === "all_drivers") rows = await pick("drivers", (q) => cityFilter(q.eq("status", "approved")));
  else if (n.audience === "all_customers") rows = await pick("customers", (q) => cityFilter(q.eq("status", "active")));
  userIds = rows.map((r) => r.user_id).filter((x): x is string => !!x);
  emails = rows.map((r) => r.email).filter((x): x is string => !!x);

  const channels: string[] = n.channels ?? [];
  const logs: Record<string, unknown>[] = [];

  if (channels.includes("push")) {
    let tokens: string[] = [];
    for (let i = 0; i < userIds.length; i += 200) {
      const { data } = await db.from("device_tokens").select("token").in("user_id", userIds.slice(i, i + 200));
      tokens = tokens.concat((data ?? []).map((t: { token: string }) => t.token));
    }
    const started = Date.now();
    const r = await sendPush(tokens, n.title, n.body, { notification_id: id, category: String(n.category), priority: String(n.priority) }, n.priority !== "normal");
    if (r.invalidTokens.length) await db.from("device_tokens").delete().in("token", r.invalidTokens);
    await logIntegration("push", "fcm", "send", r.status === "sent" ? "ok" : r.status === "not_configured" ? "not_configured" : "error", { ms: Date.now() - started, error: r.error, reference: id });
    logs.push({ channel: "push", provider: "fcm", status: r.status, recipients_count: r.sent, error: r.error ?? null });
  }

  if (channels.includes("email")) {
    const key = env("RESEND_API_KEY"), from = env("EMAIL_FROM");
    if (!key || !from) logs.push({ channel: "email", provider: "resend", status: "not_configured", error: "RESEND_API_KEY / EMAIL_FROM not set" });
    else if (emails.length === 0) logs.push({ channel: "email", provider: "resend", status: "skipped", error: "No e-mail addresses for this audience" });
    else {
      let sent = 0, lastError = ""; const started = Date.now();
      for (let i = 0; i < emails.length; i += 50) {          // BCC batches keep addresses private
        const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [from], bcc: emails.slice(i, i + 50), subject: n.title, text: n.body }) }).catch(() => null);
        if (res?.ok) sent += Math.min(50, emails.length - i); else lastError = `HTTP ${res?.status ?? "network"}`;
      }
      await logIntegration("email", "resend", "send", sent ? "ok" : "error", { ms: Date.now() - started, error: lastError || undefined, reference: id });
      logs.push({ channel: "email", provider: "resend", status: sent ? "sent" : "failed", recipients_count: sent, error: lastError || null });
    }
  }

  // Bulk SMS / WhatsApp need provider-approved (DLT / Meta) templates per message. They are
  // reported honestly as not configured instead of being silently dropped.
  for (const ch of ["sms", "whatsapp"]) {
    if (channels.includes(ch)) logs.push({ channel: ch, provider: "none", status: "not_configured",
      error: ch === "sms" ? "Bulk SMS requires a DLT-approved template for this message. Only ride OTP SMS is enabled." : "WhatsApp requires an approved Meta template. Not configured." });
  }
  if (channels.includes("in_app")) logs.push({ channel: "in_app", provider: "database", status: "delivered", recipients_count: rows.length });

  await call(db.rpc("notification_dispatch_result", { p_notification_id: id, p_logs: logs }));
  const { data: after } = await db.from("notifications").select("dispatch_status").eq("id", id).maybeSingle();
  return { ok: true, dispatch_status: after?.dispatch_status, results: logs };
});
