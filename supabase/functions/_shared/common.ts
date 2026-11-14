// Shared helpers for every Edge Function.
// The service-role key lives ONLY here (server side). It is never sent to a browser or phone.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** Origins allowed to call the functions from a browser. Comma separated. "*" only if unset. */
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Wraps a handler with CORS, JSON parsing and uniform error responses. Never leaks stack traces. */
export function serve(handler: (req: Request, body: Record<string, unknown>) => Promise<unknown>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    if (req.method !== "POST") return json(req, { ok: false, code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405);
    try {
      let body: Record<string, unknown> = {};
      const text = await req.text();
      if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, "INVALID_JSON", "Request body must be JSON"); } }
      const result = await handler(req, body);
      return result instanceof Response ? result : json(req, result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json(req, { ok: false, code: e.code, message: e.message }, e.status);
      const msg = e instanceof Error ? e.message : String(e);
      // Database errors raised by our functions look like "CODE: message".
      const m = /^([A-Z_]{3,40}):?\s*(.*)$/.exec(msg);
      if (m) return json(req, { ok: false, code: m[1], message: m[2] || m[1] }, m[1] === "PERMISSION_DENIED" ? 403 : 400);
      console.error("unhandled", msg);
      try { await admin().rpc("log_client_error", { p_source: "edge", p_level: "error", p_message: msg.slice(0, 500), p_context: { url: new URL(req.url).pathname } }); } catch { /* ignore */ }
      return json(req, { ok: false, code: "INTERNAL_ERROR", message: "Something went wrong on the server. The error has been logged." }, 500);
    }
  });
}

let _admin: SupabaseClient | null = null;
/** Service-role client. Bypasses RLS — use only after the caller has been authorised. */
export function admin(): SupabaseClient {
  if (!SERVICE_KEY || !SUPABASE_URL) throw new HttpError(500, "SERVER_NOT_CONFIGURED", "Supabase environment variables are missing");
  if (!_admin) _admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

/** A client that acts AS the caller (their JWT, RLS applies, x-forwarded-for preserved for IP rules). */
export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") ?? "";
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth, ...(fwd ? { "x-forwarded-for": fwd } : {}) } },
  });
}

/** An anonymous client used only to re-check a password (step-up authentication). */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface Caller { userId: string; email: string | null; client: SupabaseClient; }

/** Verifies the caller's JWT with Supabase Auth. Throws 401 when missing / invalid. */
export async function requireUser(req: Request): Promise<Caller> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) throw new HttpError(401, "NOT_AUTHENTICATED", "Sign in first");
  const client = userClient(req);
  const { data, error } = await client.auth.getUser(auth.slice(7));
  if (error || !data?.user) throw new HttpError(401, "NOT_AUTHENTICATED", "Your session has expired. Sign in again.");
  return { userId: data.user.id, email: data.user.email ?? null, client };
}

export interface StaffCaller extends Caller { staffId: string; }

/**
 * Verifies the caller is active staff holding `permission`. The check runs in the database
 * AS the caller, so it includes role, MFA, session revocation and IP rules — the same rule
 * the console is subject to. Never trust a role sent in the request body.
 */
export async function requireStaff(req: Request, permission: string): Promise<StaffCaller> {
  const caller = await requireUser(req);
  const { data: ok, error } = await caller.client.rpc("has_permission", { p_code: permission });
  if (error) throw new HttpError(500, "PERMISSION_CHECK_FAILED", "Could not verify permissions");
  if (ok !== true) throw new HttpError(403, "PERMISSION_DENIED", `You do not have the "${permission}" permission`);
  const { data: staffId } = await caller.client.rpc("current_staff_id");
  if (!staffId) throw new HttpError(403, "PERMISSION_DENIED", "Staff account not found");
  return { ...caller, staffId: staffId as string };
}

/** Unwraps a Supabase RPC result, turning database errors into thrown errors. */
export async function call<T = unknown>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export function str(v: unknown, name: string, min = 1, max = 2000): string {
  if (typeof v !== "string" || v.trim().length < min) throw new HttpError(400, "INVALID_INPUT", `${name} is required${min > 1 ? ` (at least ${min} characters)` : ""}`);
  if (v.length > max) throw new HttpError(400, "INVALID_INPUT", `${name} is too long`);
  return v.trim();
}
export function uuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new HttpError(400, "INVALID_INPUT", `${name} must be a valid id`);
  return v;
}

/** Records an outbound provider call (no secrets, no message bodies). */
export async function logIntegration(kind: string, provider: string, operation: string, status: "ok" | "error" | "not_configured",
  extra: { http?: number; ms?: number; error?: string; reference?: string; direction?: "outbound" | "inbound" } = {}) {
  try {
    await admin().rpc("log_integration_event", { p_kind: kind, p_provider: provider, p_direction: extra.direction ?? "outbound", p_operation: operation,
      p_status: status, p_http_status: extra.http ?? null, p_duration_ms: extra.ms ?? null, p_error: extra.error?.slice(0, 500) ?? null, p_reference: extra.reference ?? null });
  } catch (e) { console.error("integration log failed", e instanceof Error ? e.message : e); }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let r = 0; for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const env = (k: string) => (Deno.env.get(k) ?? "").trim();
