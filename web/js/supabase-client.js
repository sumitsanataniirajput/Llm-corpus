// The single Supabase client for the console. Uses ONLY the public anon key:
// every request is limited by Row Level Security and server-side permission checks.

const cfg = window.RMS_CONFIG || null;

export function configProblem() {
  if (window.RMS_CONFIG_MISSING || !cfg) return 'missing';
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || /YOUR-PROJECT-REF|YOUR-ANON/.test(`${cfg.SUPABASE_URL}${cfg.SUPABASE_ANON_KEY}`)) return 'placeholder';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/.test(cfg.SUPABASE_URL) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(cfg.SUPABASE_URL)) return 'bad_url';
  try {
    // Refuse to start if someone pasted the service-role key into a public file.
    const payload = JSON.parse(atob(cfg.SUPABASE_ANON_KEY.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role === 'service_role') return 'service_key';
  } catch { /* new-style publishable keys are not JWTs — fine */ }
  if (/^sb_secret_/.test(cfg.SUPABASE_ANON_KEY)) return 'service_key';
  if (!window.supabase?.createClient) return 'sdk';
  return null;
}

export const config = cfg || {};
export const sb = configProblem() ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'rms.auth' },
  realtime: { params: { eventsPerSecond: 10 } },
});

/** Friendly messages for the error codes raised by the database and Edge Functions. */
const MESSAGES = {
  PERMISSION_DENIED: 'You do not have permission to do this.',
  NOT_AUTHENTICATED: 'Your session has expired. Please sign in again.',
  REASON_REQUIRED: 'A reason is required (at least 5 characters).',
  INVALID_STATE: 'This action is not allowed in the current state.',
  INVALID_TRANSITION: 'That status change is not allowed.',
  DRIVER_BUSY: 'This driver is already on another active ride.',
  VEHICLE_BUSY: 'This vehicle is already on another active ride.',
  DOCUMENTS_INCOMPLETE: 'Required documents are not yet approved.',
  NO_PRICING_RULE: 'No active pricing rule exists for this category and city. Add one in Pricing.',
  INSUFFICIENT_BALANCE: 'The wallet balance is not enough for this amount.',
  SELF_APPROVAL_FORBIDDEN: 'Payouts must be approved by a different person from the one who created them.',
  REFUND_EXCEEDS_PAYMENT: 'The refund is larger than the amount that can still be refunded.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  PAYMENT_GATEWAY_NOT_CONFIGURED: 'Online payments are not configured yet (Settings › Integrations).',
  AI_NOT_CONFIGURED: 'The AI assistant is not configured.',
  ROLE_ABOVE_YOURS: 'You cannot manage someone with a more senior role.',
};
const PG = { '23505': 'A record with the same unique value already exists.', '23503': 'This record is linked to other records and cannot be changed that way.',
  '23514': 'A value is outside the allowed range.', '23502': 'A required value is missing.', '42501': 'You do not have permission to do this.', 'PGRST116': 'Record not found.' };

export class AppError extends Error {
  constructor(code, message, raw) { super(message); this.code = code; this.raw = raw; }
}
/** Turns any Supabase / PostgREST / function error into an AppError with a human message. */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  const raw = String(error?.message ?? error ?? 'Unknown error');
  const m = /^([A-Z][A-Z0-9_]{2,40}):?\s*(.*)$/s.exec(raw);
  if (m) return new AppError(m[1], m[2]?.trim() || MESSAGES[m[1]] || m[1].replace(/_/g, ' ').toLowerCase(), error);
  if (error?.code && PG[error.code]) return new AppError(error.code, /row-level security/.test(raw) ? PG['42501'] : PG[error.code], error);
  if (/row-level security|permission denied/i.test(raw)) return new AppError('PERMISSION_DENIED', MESSAGES.PERMISSION_DENIED, error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return new AppError('NETWORK', 'No connection to the server. Check your internet and try again.', error);
  if (/JWT expired|invalid JWT/i.test(raw)) return new AppError('NOT_AUTHENTICATED', MESSAGES.NOT_AUTHENTICATED, error);
  return new AppError(error?.code || 'ERROR', raw, error);
}

/** Await a Supabase query; returns data or throws AppError. */
export async function unwrap(query) {
  const { data, error, count } = await query;
  if (error) throw toAppError(error);
  return count === null || count === undefined ? data : { rows: data ?? [], count };
}

/** Call a database function (RPC). */
export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw toAppError(error);
  return data;
}

/** Call an Edge Function. Functions answer { ok:false, code, message } on failure. */
export async function fn(name, body = {}) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let payload = null;
    try { payload = await error.context?.json?.(); } catch { /* not JSON */ }
    if (payload?.code) throw new AppError(payload.code, payload.message || MESSAGES[payload.code] || payload.code, payload);
    if (error.context?.status === 404 || /not found|Failed to send/i.test(String(error.message)))
      throw new AppError('FUNCTION_NOT_DEPLOYED', `The "${name}" server function is not deployed yet. See documentation/DEPLOYMENT.md.`, error);
    throw toAppError(error);
  }
  // Business outcomes (e.g. { ok:false, code:'TOO_SOON' }) are returned so pages can show them precisely.
  return data;
}
