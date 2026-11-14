// Sign-in, two-step verification, session registration, idle timeout and sign-out.
// Order matters:  password -> (MFA) -> begin_session() -> my_access().
// Until begin_session() has registered this login, the database grants no permissions.
import { sb, rpc, toAppError, AppError } from './supabase-client.js';
import { setAccess } from './permissions.js';

const CODE_TEXT = {
  NOT_STAFF: 'This account is not a staff account. Ask your administrator for access.',
  ACCOUNT_SUSPENDED: 'Your staff account is suspended. Contact your administrator.',
  ACCOUNT_DEACTIVATED: 'Your staff account has been deactivated.',
  IP_BLOCKED: 'Sign-in is not allowed from this network.',
  SESSION_REVOKED: 'This session was signed out by an administrator. Please sign in again.',
  NO_SESSION: 'Your session could not be verified. Please sign in again.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
};
const lockedText = (until) => `This account is temporarily locked after repeated failed sign-ins. Try again ${until ? `after ${new Date(until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'later'}.`;
const deviceLabel = () => { const ua = navigator.userAgent; const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'; return `${br} on ${os}`; };

/** Step 1: password. Returns the next step: {step:'mfa'|'enrol'|'ready', ...}. Throws AppError with a safe message. */
export async function signIn(email, password) {
  email = String(email).trim().toLowerCase();
  let pre;
  try { pre = await rpc('login_precheck', { p_email: email }); } catch (e) { throw toAppError(e); }
  if (pre && pre.allowed === false) throw new AppError(pre.code, pre.code === 'LOCKED' ? lockedText(pre.locked_until) : CODE_TEXT[pre.code] ?? 'Sign-in is not available right now.');
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    if (/Failed to fetch|NetworkError/i.test(error.message)) throw toAppError(error);
    if (/invalid login credentials/i.test(error.message)) {
      try { await rpc('record_login_failure', { p_email: email }); } catch { /* best effort */ }
      // Same message for "no such account" and "wrong password" so accounts cannot be enumerated.
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect e-mail or password.');
    }
    if (/email not confirmed/i.test(error.message)) throw new AppError('EMAIL_NOT_CONFIRMED', 'Open the invitation e-mail and set your password first.');
    throw new AppError('SIGN_IN_FAILED', error.message);
  }
  return continueSession();
}

/** Decides what is still needed for the current Supabase session. Used after sign-in and on page reload. */
export async function continueSession() {
  const { data: aal, error: aalError } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) throw toAppError(aalError);
  if (aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    const { data: factors } = await sb.auth.mfa.listFactors();
    const totp = factors?.totp?.find((f) => f.status === 'verified');
    if (totp) return { step: 'mfa', factorId: totp.id };
  }
  const begun = await rpc('begin_session', { p_device: deviceLabel() });
  if (!begun?.ok) {
    await sb.auth.signOut({ scope: 'local' });
    throw new AppError(begun?.code ?? 'SESSION', begun?.code === 'LOCKED' ? lockedText(begun.locked_until) : CODE_TEXT[begun?.code] ?? 'Sign-in could not be completed.');
  }
  const access = await rpc('my_access');
  if (access?.code === 'MFA_REQUIRED') return { step: 'enrol' };
  if (!access?.ok) {
    await sb.auth.signOut({ scope: 'local' });
    throw new AppError(access?.code ?? 'ACCESS', CODE_TEXT[access?.code] ?? 'Access could not be verified.');
  }
  setAccess(access);
  startIdleTimer(access.session_timeout_min);
  return { step: 'ready', access };
}

export async function verifyMfa(factorId, code) {
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: String(code).trim() });
  if (error) throw new AppError('MFA_INVALID', /expired|invalid/i.test(error.message) ? 'That code is not correct or has expired. Try the next code.' : error.message);
  return continueSession();
}
/** Start TOTP enrolment. Returns { factorId, qr (data URI), secret }. */
export async function enrolMfaStart() {
  const { data: existing } = await sb.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) if (f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
  if (error) throw new AppError('MFA_ENROL', error.message);
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}
export async function enrolMfaVerify(factorId, code) {
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: String(code).trim() });
  if (error) throw new AppError('MFA_INVALID', 'That code is not correct. Check the time on your phone and try the next code.');
  try { await rpc('log_auth_event', { p_event: 'mfa_enrolled' }); } catch { /* best effort */ }
  return true;
}
export async function listMfaFactors() { const { data, error } = await sb.auth.mfa.listFactors(); if (error) throw toAppError(error); return data?.totp ?? []; }
export async function removeMfaFactor(factorId) { const { error } = await sb.auth.mfa.unenroll({ factorId }); if (error) throw toAppError(error); try { await rpc('log_auth_event', { p_event: 'mfa_removed' }); } catch { /* ignore */ } }

export async function requestPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo: `${location.origin}${location.pathname}` });
  // Deliberately no "account not found" message.
  if (error && /rate limit/i.test(error.message)) throw new AppError('RATE_LIMITED', CODE_TEXT.RATE_LIMITED);
}
export async function setNewPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw new AppError('PASSWORD', error.message);
  try { await rpc('log_auth_event', { p_event: 'password_reset' }); } catch { /* ignore */ }
}
/** Re-enter the password before a sensitive change (step-up). */
export async function reauthenticate(password) {
  const { data } = await sb.auth.getUser();
  const { error } = await sb.auth.signInWithPassword({ email: data?.user?.email, password });
  if (error) throw new AppError('REAUTH_FAILED', 'Password is incorrect.');
}

export async function signOut(reason = null) {
  stopIdleTimer();
  try { await rpc('end_session'); } catch { /* session may already be gone */ }
  try { await sb.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
  setAccess(null);
  if (reason) sessionStorage.setItem('rms.signout_reason', reason);
  location.hash = '';
  location.reload();
}
export const hasSession = async () => { const { data } = await sb.auth.getSession(); return !!data?.session; };
export const onAuthChange = (cb) => sb.auth.onAuthStateChange((event, session) => cb(event, session));

// ---------- idle timeout ----------
let idleMinutes = 30, idleHandle = null, lastActivity = Date.now();
const EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
const touch = () => { lastActivity = Date.now(); try { localStorage.setItem('rms.activity', String(lastActivity)); } catch { /* private mode */ } };
function startIdleTimer(minutes) {
  stopIdleTimer(); idleMinutes = Math.max(5, Number(minutes) || 30); touch();
  EVENTS.forEach((e) => window.addEventListener(e, touch, { passive: true }));
  idleHandle = setInterval(() => {
    // Activity in another tab of the same browser counts too.
    const shared = Number(localStorage.getItem('rms.activity') || 0);
    if (Date.now() - Math.max(lastActivity, shared) > idleMinutes * 60000) signOut(`You were signed out after ${idleMinutes} minutes without activity.`);
  }, 30000);
}
function stopIdleTimer() { if (idleHandle) clearInterval(idleHandle); idleHandle = null; EVENTS.forEach((e) => window.removeEventListener(e, touch)); }
