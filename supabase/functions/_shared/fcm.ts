// Firebase Cloud Messaging (HTTP v1). Needs the FIREBASE_SERVICE_ACCOUNT secret:
// the full JSON of a Firebase service-account key. Without it: "not_configured".
import { env } from "./common.ts";

let cached: { token: string; exp: number; projectId: string } | null = null;
const b64url = (b: ArrayBuffer | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function accessToken(): Promise<{ token: string; projectId: string } | null> {
  const raw = env("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) return null;
  if (cached && cached.exp > Date.now() + 60_000) return cached;
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const pem = String(sa.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`FCM auth failed: ${body.error_description ?? res.status}`);
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000, projectId: sa.project_id };
  return cached;
}

export interface PushResult { status: "sent" | "failed" | "not_configured" | "skipped"; sent: number; failed: number; invalidTokens: string[]; error?: string; }

export async function sendPush(tokens: string[], title: string, body: string, data: Record<string, string>, highPriority: boolean): Promise<PushResult> {
  let auth;
  try { auth = await accessToken(); } catch (e) { return { status: "failed", sent: 0, failed: tokens.length, invalidTokens: [], error: e instanceof Error ? e.message : "auth error" }; }
  if (!auth) return { status: "not_configured", sent: 0, failed: 0, invalidTokens: [], error: "FIREBASE_SERVICE_ACCOUNT secret is not set" };
  if (tokens.length === 0) return { status: "skipped", sent: 0, failed: 0, invalidTokens: [], error: "No registered devices for this audience" };
  let sent = 0, failed = 0; const invalid: string[] = []; let lastError = "";
  const queue = [...tokens];
  const worker = async () => {
    for (let t = queue.pop(); t; t = queue.pop()) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${auth!.projectId}/messages:send`, { method: "POST",
        headers: { Authorization: `Bearer ${auth!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: t, notification: { title, body }, data, android: { priority: highPriority ? "HIGH" : "NORMAL" } } }) }).catch(() => null);
      if (res?.ok) { sent++; continue; }
      failed++;
      const err = await res?.json().catch(() => null);
      const code = err?.error?.details?.[0]?.errorCode ?? err?.error?.status ?? "NETWORK";
      lastError = String(code);
      if (code === "UNREGISTERED" || code === "INVALID_ARGUMENT") invalid.push(t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, tokens.length) }, worker));
  return { status: sent > 0 ? "sent" : "failed", sent, failed, invalidTokens: invalid, error: failed ? `${failed} device(s) failed (${lastError})` : undefined };
}
