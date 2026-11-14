// Staff account administration that needs the Auth admin API (service role):
// create a staff login, send a password-reset e-mail, force sign-out.
// No passwords are ever generated, stored or returned by this function —
// the new staff member sets their own through the invite e-mail.
import { admin, call, HttpError, requireStaff, serve, str, uuid } from "../_shared/common.ts";

serve(async (req, body) => {
  const staff = await requireStaff(req, "staff.manage");
  const action = str(body.action, "action", 1, 30);
  const db = admin();

  if (action === "create") {
    const email = str(body.email, "email", 5, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "INVALID_INPUT", "Enter a valid e-mail address");
    const fullName = str(body.full_name, "full_name", 2, 120);
    const roleCode = str(body.role_code, "role_code", 2, 60);
    const phone = typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
    const cityScope = Array.isArray(body.city_scope) && body.city_scope.length ? body.city_scope.map((c) => uuid(c, "city_scope")) : null;
    const branchId = body.branch_id ? uuid(body.branch_id, "branch_id") : null;
    const redirectTo = typeof body.redirect_to === "string" ? body.redirect_to : undefined;

    const { data: existing } = await db.from("staff_accounts").select("id").eq("email", email).maybeSingle();
    if (existing) throw new HttpError(409, "ALREADY_EXISTS", "A staff account with this e-mail already exists");

    const { data: invited, error } = await db.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo });
    if (error || !invited?.user) throw new HttpError(400, "INVITE_FAILED", error?.message ?? "Could not create the login. Check that e-mail sending is configured in Supabase Auth.");
    try {
      const staffId = await call<string>(db.rpc("create_staff_record", { p_actor_staff_id: staff.staffId, p_user_id: invited.user.id, p_full_name: fullName, p_email: email,
        p_phone: phone, p_role_code: roleCode, p_city_scope: cityScope, p_branch_id: branchId, p_mfa_required: body.mfa_required === true }));
      return { ok: true, staff_id: staffId, invited: true };
    } catch (e) {
      await db.auth.admin.deleteUser(invited.user.id);      // do not leave an orphan login behind
      throw e;
    }
  }

  // The remaining actions target an existing staff member; rank is enforced by update_staff-style checks.
  const targetId = uuid(body.staff_id, "staff_id");
  const { data: target } = await db.from("staff_accounts").select("id, user_id, email, roles:role_id(rank)").eq("id", targetId).maybeSingle();
  if (!target) throw new HttpError(404, "NOT_FOUND", "Staff member not found");
  const { data: me } = await db.from("staff_accounts").select("roles:role_id(rank)").eq("id", staff.staffId).maybeSingle();
  const myRank = (me?.roles as { rank?: number } | null)?.rank ?? 999, theirRank = (target.roles as { rank?: number } | null)?.rank ?? 0;
  if (theirRank < myRank) throw new HttpError(403, "ROLE_ABOVE_YOURS", "You cannot manage someone with a more senior role");

  if (action === "send_password_reset") {
    const { error } = await db.auth.resetPasswordForEmail(target.email, { redirectTo: typeof body.redirect_to === "string" ? body.redirect_to : undefined });
    if (error) throw new HttpError(400, "RESET_FAILED", error.message);
    await db.rpc("write_audit", { p_action: "staff.password_reset_sent", p_entity_type: "staff_accounts", p_entity_id: targetId, p_staff_override: staff.staffId });
    return { ok: true };
  }
  if (action === "force_sign_out") {
    await db.from("admin_sessions").update({ revoked_at: new Date().toISOString(), revoked_by: staff.staffId, revoked_reason: "Forced sign-out by administrator" })
      .eq("staff_id", targetId).is("revoked_at", null);
    await db.rpc("write_audit", { p_action: "staff.force_sign_out", p_entity_type: "staff_accounts", p_entity_id: targetId, p_staff_override: staff.staffId });
    return { ok: true };
  }
  throw new HttpError(400, "UNKNOWN_ACTION", "action must be create, send_password_reset or force_sign_out");
});
