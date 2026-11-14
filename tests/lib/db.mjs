// Local test database: real PostgreSQL (PGlite / WASM) + minimal stand-ins for the
// parts of Supabase the migrations rely on (auth schema, API roles, JWT claims).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const migrationsDir = path.join(root, 'supabase/migrations');

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, created_at timestamptz default now());
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub', '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

export async function createDb({ seedDemo = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));
    } catch (e) {
      e.message = `[${f}] ${e.message}`;
      throw e;
    }
  }
  await db.exec('grant usage on schema extensions to anon, authenticated, service_role;');
  if (seedDemo) await db.exec(readFileSync(path.join(root, 'supabase/seed/demo_seed.sql'), 'utf8'));
  return db;
}

async function setCtx(db, role, claims, headers) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`,
    [claims ? JSON.stringify(claims) : '', JSON.stringify(headers || {})]);
  if (role) await db.exec(`set role ${role}`);
}

/** Run fn as a signed-in API user (RLS applies). */
export async function asUser(db, user, fn) {
  await setCtx(db, 'authenticated', { sub: user.id, role: 'authenticated', session_id: user.session, aal: user.aal || 'aal1' }, user.headers);
  try { return await fn(); } finally { await setCtx(db, null, null); }
}
/** Run fn as an Edge Function holding the service-role key. */
export async function asService(db, fn) {
  await setCtx(db, 'service_role', { role: 'service_role' });
  try { return await fn(); } finally { await setCtx(db, null, null); }
}
export async function asAnon(db, fn, headers) {
  await setCtx(db, 'anon', { role: 'anon' }, headers);
  try { return await fn(); } finally { await setCtx(db, null, null); }
}

/** Call an RPC with named arguments; returns the scalar result. */
export async function rpc(db, name, args = {}) {
  const keys = Object.keys(args);
  const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = keys.map((k) => { const v = args[k]; return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v; });
  const r = await db.query(`select public.${name}(${params}) as result`, values);
  return r.rows[0]?.result;
}
export const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
export const all = async (db, sql, params) => (await db.query(sql, params)).rows;
