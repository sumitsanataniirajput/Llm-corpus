// Ride-start OTP: generation, SMS delivery, resend, manual generation and manager override.
// The plaintext OTP exists only inside this function for the few milliseconds needed to hand
// it to the SMS provider. It is never logged, never stored and never returned to any caller.
import { admin, anonClient, call, HttpError, requireStaff, requireUser, serve, str, uuid } from "../_shared/common.ts";
import { sendOtpSms } from "../_shared/sms.ts";

type Issue = { ok: boolean; code: string; otp?: string; otp_id?: string; phone?: string; booking_code?: string; expires_at?: string; message?: string; [k: string]: unknown };

async function issueAndSend(bookingId: string, type: "auto" | "resend" | "manual", staffId: string | null) {
  const db = admin();
  const issued = await call<Issue>(db.rpc("otp_issue", { p_booking_id: bookingId, p_generation_type: type, p_staff_id: staffId }));
  if (!issued.ok || !issued.otp) {
    const { otp: _drop, phone: _p, ...safe } = issued;
    return safe;                                   // e.g. ALREADY_ACTIVE, LOCKED, TOO_SOON, RESEND_LIMIT
  }
  const [{ data: name }, { data: expiry }] = await Promise.all([
    db.from("system_settings").select("value").eq("key", "brand.app_name").maybeSingle(),
    db.from("system_settings").select("value").eq("key", "otp.expiry_seconds").maybeSingle(),
  ]);
  const sms = await sendOtpSms({ phone: issued.phone ?? "", otp: issued.otp, minutes: Math.max(1, Math.round(Number(expiry?.value ?? 300) / 60)), appName: String(name?.value ?? "Ride") });
  await call(db.rpc("otp_record_delivery", { p_otp_id: issued.otp_id, p_channel: "sms", p_provider: sms.provider, p_status: sms.status,
    p_provider_message_id: sms.messageId ?? null, p_error: sms.error ?? null, p_delivery_type: type === "auto" ? "automatic" : type, p_staff_id: staffId,
    p_response: null }));
  return { ok: true, code: "ISSUED", otp_id: issued.otp_id, booking_code: issued.booking_code, expires_at: issued.expires_at,
    delivery: { status: sms.status, provider: sms.provider, error: sms.status === "sent" ? null : sms.error ?? null } };
}

serve(async (req, body) => {
  const action = str(body.action, "action", 1, 30);
  const bookingId = uuid(body.booking_id, "booking_id");
  const db = admin();

  if (action === "issue") {
    // Called by the Driver App right after the driver accepts the ride.
    const caller = await requireUser(req);
    const { data: b } = await db.from("bookings").select("id, driver_id, drivers:driver_id(user_id)").eq("id", bookingId).maybeSingle();
    const driverUser = (b?.drivers as { user_id?: string } | null)?.user_id;
    if (!b || driverUser !== caller.userId) throw new HttpError(403, "NOT_ASSIGNED_DRIVER", "Only the assigned driver can request the ride OTP");
    return await issueAndSend(bookingId, "auto", null);
  }

  if (action === "resend") {
    // Driver (assigned) or staff with otp.deliver.
    const caller = await requireUser(req);
    const { data: b } = await db.from("bookings").select("id, drivers:driver_id(user_id)").eq("id", bookingId).maybeSingle();
    if (!b) throw new HttpError(404, "BOOKING_NOT_FOUND", "Booking not found");
    if ((b.drivers as { user_id?: string } | null)?.user_id === caller.userId) return await issueAndSend(bookingId, "resend", null);
    const staff = await requireStaff(req, "otp.deliver");
    return await issueAndSend(bookingId, "resend", staff.staffId);
  }

  if (action === "generate") {
    const staff = await requireStaff(req, "otp.generate");
    str(body.reason, "reason", 5, 500);
    return await issueAndSend(bookingId, "manual", staff.staffId);
  }

  if (action === "override") {
    // Exceptional path. Requires: permission + password re-entry + reason + identity confirmation.
    const staff = await requireStaff(req, "otp.override");
    const password = str(body.password, "password", 1, 200);
    const reason = str(body.reason, "reason", 20, 1000);
    const identity = str(body.identity_confirmation, "identity_confirmation", 10, 1000);
    if (!staff.email) throw new HttpError(400, "REAUTH_UNAVAILABLE", "Your account has no e-mail address to re-authenticate with");
    const { data: allowed } = await db.rpc("check_rate_limit", { p_key: `otp_override_reauth:${staff.staffId}`, p_max: 5, p_window_seconds: 900 });
    if (allowed === false) throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Try again in 15 minutes.");
    const { error: authError } = await anonClient().auth.signInWithPassword({ email: staff.email, password });
    if (authError) {
      await db.from("otp_audit_logs").insert({ booking_id: bookingId, event: "override_reauth_failed", actor_type: "staff", actor_id: staff.staffId, details: {} });
      throw new HttpError(403, "REAUTH_FAILED", "Password is incorrect. The override was not applied.");
    }
    return await call(db.rpc("otp_override", { p_booking_id: bookingId, p_staff_id: staff.staffId, p_reason: reason, p_identity_confirmation: identity }));
  }

  throw new HttpError(400, "UNKNOWN_ACTION", "action must be issue, resend, generate or override");
});
