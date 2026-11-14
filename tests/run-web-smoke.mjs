// Web console smoke test.
// Loads every page module in jsdom and runs every tab against the REAL schema: the fake Supabase
// client below translates each PostgREST query into SQL and runs it on a local PostgreSQL (PGlite)
// as a signed-in Super Admin, and RPCs call the real database functions. So a wrong table, column,
// filter, RPC argument or a render crash fails this test. Writes made from forms are not exercised.
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb, asUser, rpc as dbRpc, one, all } from './lib/db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const problems = []; let context = 'setup'; const queries = { table: 0, rpc: 0 };
const problem = (msg) => { const line = `[${context}] ${msg}`; if (!problems.includes(line)) problems.push(line); };

// ---------- database ----------
const db = await createDb();
const SEED = process.env.SMOKE_SEED !== '0';
const owner = { id: (await one(db, `insert into auth.users(email) values ('owner@example.test') returning id`)).id, session: randomUUID() };
await dbRpc(db, 'bootstrap_super_admin', { p_email: 'owner@example.test', p_full_name: 'Owner One' });
await asUser(db, owner, () => dbRpc(db, 'begin_session', { p_device: 'smoke' }));
if (SEED) await db.exec(readFileSync(path.join(root, 'supabase/seed/demo_seed.sql'), 'utf8'));
const cols = {}; for (const r of await all(db, `select table_name, column_name from information_schema.columns where table_schema = 'public'`)) (cols[r.table_name] ??= new Set()).add(r.column_name);
const fnRet = Object.fromEntries((await all(db, `select p.proname, p.proretset, t.typname from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype where n.nspname = 'public'`)).map((r) => [r.proname, r]));
let chain = Promise.resolve();                       // PGlite is single-connection: run one statement at a time
const serial = (job) => { const p = chain.then(job, job); chain = p.catch(() => {}); return p; };
const asOwner = (job) => serial(() => asUser(db, owner, job));

// ---------- fake supabase-js ----------
const ident = (c) => { if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`bad identifier "${c}"`); return `"${c}"`; };
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
class Query {
  constructor(table) { this.t = table; this.w = []; this.p = []; this.o = []; this.sel = '*'; this.mode = 'select'; this.opts = {}; this.one = null; if (!cols[table]) problem(`table "${table}" does not exist`); }
  col(c) { c = String(c).split('->')[0]; if (cols[this.t] && !cols[this.t].has(c)) problem(`${this.t}: column "${c}" does not exist`); return ident(c); }
  v(x) { this.p.push(x); return `$${this.p.length}`; }
  select(s = '*', opts = {}) { if (this.mode === 'select') { this.sel = s; this.opts = opts; } return this; }
  insert(v) { this.mode = 'write'; this.keys(v); return this; } upsert(v) { return this.insert(v); } update(v) { this.mode = 'write'; this.keys(v); return this; } delete() { this.mode = 'write'; return this; }
  keys(v) { for (const row of [].concat(v)) for (const k of Object.keys(row ?? {})) this.col(k); }
  cond(c, op, val) { if (op in OPS) return `${this.col(c)}::text ${OPS[op]} ${this.v(String(val))}`; if (op === 'is') return `${this.col(c)} is ${val === null || val === 'null' ? 'null' : val === true || val === 'true' ? 'true' : 'false'}`;
    if (op === 'in') { const list = Array.isArray(val) ? val : String(val).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); return list.length ? `${this.col(c)}::text = any(${this.v(list.map(String))}::text[])` : 'false'; }
    if (op === 'cs' || op === 'ov' || op === 'cd') { this.col(c); return 'true'; } problem(`${this.t}: unsupported filter operator "${op}"`); return 'true'; }
  or(expr) { const parts = String(expr).split(/,(?![^()]*\))/).map((part) => { const m = /^([a-z_0-9]+)\.(not\.)?([a-z]+)\.(.*)$/s.exec(part.trim()); if (!m) { problem(`${this.t}: cannot parse or() part "${part}"`); return 'false'; } const c = this.cond(m[1], m[3], m[4].replace(/\*/g, '%')); return m[2] ? `not (${c})` : c; }); this.w.push(`(${parts.join(' or ')})`); return this; }
  not(c, op, val) { this.w.push(`not (${this.cond(c, op, val)})`); return this; }
  filter(c, op, val) { this.w.push(this.cond(c, op, val)); return this; }
  order(c, { ascending = true, nullsFirst } = {}) { this.o.push(`${this.col(c)} ${ascending ? 'asc' : 'desc'}${nullsFirst === false ? ' nulls last' : nullsFirst ? ' nulls first' : ''}`); return this; }
  range(a, b) { this.lim = [a, b - a + 1]; return this; } limit(n) { this.lim = [0, n]; return this; }
  single() { this.one = 'single'; return this; } maybeSingle() { this.one = 'maybe'; return this; }
  then(res, rej) { return this.run().then(res, rej); }
  async run() {
    if (this.mode === 'write') { problem(`${this.t}: unexpected write while only loading a page`); return { data: null, error: null }; }
    let list = this.sel.trim() === '*' ? '*' : null;
    if (!list) { const parts = this.sel.split(/,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean); const plain = [];
      for (const part of parts) { if (part.includes('(')) { problem(`${this.t}: embedded select "${part}" (use attach() instead — not verified here)`); continue; } if (part === '*') { plain.push('*'); continue; } const [a, b] = part.split(':'); plain.push(b ? `${this.col(b)} as ${ident(a)}` : this.col(a)); }
      list = plain.join(', ') || '*'; }
    const where = this.w.length ? ` where ${this.w.join(' and ')}` : '';
    try { queries.table += 1;
      return await asOwner(async () => {
        const rows = this.opts.head ? [] : await all(db, `select ${list} from public.${ident(this.t)}${where}${this.o.length ? ` order by ${this.o.join(', ')}` : ''}${this.lim ? ` limit ${Number(this.lim[1])} offset ${Number(this.lim[0])}` : ''}`, this.p);
        const count = this.opts.count ? Number((await one(db, `select count(*) as n from public.${ident(this.t)}${where}`, this.p)).n) : null;
        if (this.one) return rows.length === 1 ? { data: rows[0], error: null, count } : this.one === 'maybe' && !rows.length ? { data: null, error: null, count } : { data: null, error: { code: 'PGRST116', message: 'no rows' }, count };
        return { data: this.opts.head ? null : rows, error: null, count }; });
    } catch (e) { problem(`${this.t}: query failed — ${e.message}`); return { data: null, error: { message: e.message }, count: null }; }
  }
}
for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']) Query.prototype[op] = function f(c, val) { this.w.push(this.cond(c, op, val)); return this; };
for (const op of ['contains', 'overlaps', 'containedBy']) Query.prototype[op] = function f(c) { this.col(c); return this; };
const EXPECTED_RPC_ERRORS = /NOT_FOUND|NO_PRICING_RULE|REASON_REQUIRED/;
const fakeSb = {
  from: (t) => new Query(t),
  rpc: async (name, args = {}) => { queries.rpc += 1; const meta = fnRet[name]; if (!meta) { problem(`rpc "${name}" does not exist`); return { data: null, error: { message: 'missing' } }; }
    try { const keys = Object.keys(args); const params = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', '); const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
      const data = await asOwner(async () => { if (meta.proretset) { const rows = await all(db, `select * from public.${ident(name)}(${params})`, vals); return meta.typname === 'record' || cols[meta.typname] ? rows : rows.map((r) => Object.values(r)[0]); } return (await one(db, `select public.${ident(name)}(${params}) as result`, vals)).result; });
      return { data, error: null }; }
    catch (e) { if (!EXPECTED_RPC_ERRORS.test(e.message)) problem(`rpc ${name}(${Object.keys(args).join(', ')}) failed — ${e.message}`); return { data: null, error: { message: e.message } }; } },
  functions: { invoke: async (name) => ({ data: null, error: { message: 'Failed to send a request to the Edge Function', context: { status: 404 } }, name }) },
  channel: () => { const ch = { on: () => ch, subscribe: (cb) => { cb?.('SUBSCRIBED'); return ch; }, unsubscribe: () => {} }; return ch; }, removeChannel: () => {},
  storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }), getPublicUrl: () => ({ data: { publicUrl: 'about:blank' } }), remove: async () => ({ error: null }) }) },
  auth: { getSession: async () => ({ data: { session: { user: { id: owner.id, email: 'owner@example.test' }, access_token: 'x' } }, error: null }), getUser: async () => ({ data: { user: { id: owner.id, email: 'owner@example.test' } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }),
    mfa: { listFactors: async () => ({ data: { totp: [], all: [] }, error: null }), getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) } },
};

// ---------- browser ----------
const dom = new JSDOM(readFileSync(path.join(web, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ''), { url: 'https://console.example.test/', pretendToBeVisual: true });
const { window } = dom;
for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'location', 'history', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FormData', 'DOMParser', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob', 'File', 'FileReader', 'Notification']) if (window[k] !== undefined && !(k in globalThis)) globalThis[k] = window[k];
const cssShim = { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
for (const [k, v] of [['navigator', window.navigator], ['CSS', cssShim]]) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
window.CSS = cssShim;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })); globalThis.matchMedia = window.matchMedia;
window.scrollTo = () => {}; window.open = () => null; window.HTMLElement.prototype.scrollIntoView = () => {}; window.HTMLCanvasElement.prototype.getContext = () => null;
globalThis.IntersectionObserver = window.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }; globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
window.Chart = class { constructor(canvas, config) { this.config = config; if (!config?.data?.datasets) problem('chart created without datasets'); } destroy() {} update() {} }; window.Chart.defaults = { font: {}, plugins: { legend: { labels: {} }, tooltip: {} }, scale: { grid: {} }, scales: {} }; window.Chart.register = () => {};
window.Swal = { fire: async () => ({ isConfirmed: false, isDismissed: true }), close() {}, isVisible: () => false, mixin: () => window.Swal, showLoading() {}, showValidationMessage() {}, getPopup: () => null, getInput: () => null }; globalThis.Swal = window.Swal;
window.RMS_CONFIG = { SUPABASE_URL: 'https://smoketest.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_smoke', GOOGLE_MAPS_API_KEY: '', FIREBASE: {} };
window.supabase = { createClient: () => fakeSb };
const origErr = console.error; console.error = (...a) => { problem(`console.error: ${a.map((x) => (x instanceof Error ? x.stack?.split('\n').slice(0, 3).join(' | ') : String(x))).join(' ').slice(0, 400)}`); };
process.on('unhandledRejection', (e) => problem(`unhandled rejection: ${e?.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`));
window.addEventListener('error', (e) => problem(`window error: ${e.error?.stack?.split('\n').slice(0, 3).join(' | ') ?? e.message}`));

const imp = (rel) => import(pathToFileURL(path.join(web, rel)).href);
const { setAccess, routes } = await imp('js/permissions.js');
const { rpc } = await imp('js/supabase-client.js');
setAccess(await rpc('my_access'));
const settle = async (ms = 40) => { for (let i = 0; i < 6; i += 1) { await new Promise((r) => setTimeout(r, ms)); await chain; } };
const host = window.document.createElement('div'); window.document.body.appendChild(host);
const scan = (where) => { for (const el of window.document.querySelectorAll('.state.error')) problem(`${where}: error state shown — ${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)}`); for (const el of window.document.querySelectorAll('body *')) if (el.children.length === 0 && /\bundefined\b|\[object Object\]|NaN/.test(el.textContent)) problem(`${where}: suspicious text "${el.textContent.trim().slice(0, 80)}"`); };
const closeModals = () => window.document.querySelectorAll('.modal-backdrop, .modal-overlay, .drawer-backdrop').forEach((m) => m.remove());

let pages = 0, tabsRun = 0, rowsOpened = 0;
for (const r of routes()) {
  const file = path.join(web, 'js/pages', `${r.id}.js`); context = r.id;
  if (!existsSync(file)) { problem('page module is missing'); continue; }
  if (!existsSync(path.join(web, 'pages', `${r.id}.html`))) { problem('page HTML is missing'); continue; }
  pages += 1; host.innerHTML = readFileSync(path.join(web, 'pages', `${r.id}.html`), 'utf8');
  const mod = await imp(`js/pages/${r.id}.js`); let params = {}; let cleanup = null;
  const ctx = { params, navigate: () => {}, setParams: (p) => { params = { ...params, ...p }; } };
  try { cleanup = await mod.init(host, ctx); } catch (e) { problem(`init threw: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); continue; }
  await settle(); scan('first view');
  const tabIds = [...host.querySelectorAll('.tabs [data-tab]')].map((b) => b.dataset.tab); tabsRun += Math.max(1, tabIds.length);
  for (const id of tabIds) {
    context = `${r.id} › ${id}`; host.querySelector(`.tabs [data-tab="${id}"]`)?.click(); await settle(); scan('tab');
    const row = host.querySelector('.tab-pane table tbody tr'); if (row && !row.querySelector('.state')) { row.click(); await settle(); if (window.document.querySelector('.modal, .drawer')) { rowsOpened += 1; scan('row detail'); } closeModals(); }
  }
  context = r.id; try { if (typeof cleanup === 'function') cleanup(); } catch (e) { problem(`cleanup threw: ${e.message}`); }
  closeModals(); host.innerHTML = '';
}
console.error = origErr;
console.log(`pages: ${pages}/${routes().length}   tabs: ${tabsRun}   row details opened: ${rowsOpened}   table queries: ${queries.table}   rpc calls: ${queries.rpc}`);
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(`  - ${p}`); process.exit(1); }
console.log('web smoke test passed'); process.exit(0);
