// Static check: every rpc('name', { p_x: ... }) call in the web console and Edge Functions must match a real
// database function and only use argument names that function accepts. Table names used with the data helpers
// are checked too. Run: node check-rpc-usage.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './lib/db.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : [p]; });
const files = [...walk(join(root, 'web')).filter((f) => f.endsWith('.js') || f.endsWith('.html')), ...walk(join(root, 'supabase/functions')).filter((f) => f.endsWith('.ts'))];

const db = await createDb();
const fnRows = (await db.query(`select p.proname, coalesce(p.proargnames, '{}') as names, p.pronargs, p.pronargdefaults, coalesce(p.proargmodes::text[], '{}') as modes,
  has_function_privilege('authenticated', p.oid, 'execute') as auth from pg_proc p where p.pronamespace = 'public'::regnamespace`)).rows;
const fns = new Map();
for (const r of fnRows) { const inNames = r.names.filter((_, i) => !r.modes.length || ['i', 'b', 'v'].includes(r.modes[i])); fns.set(r.proname, { args: inNames, required: inNames.slice(0, r.pronargs - r.pronargdefaults), auth: r.auth }); }
const rels = new Map();
for (const r of (await db.query(`select table_name, column_name from information_schema.columns where table_schema = 'public'`)).rows) { if (!rels.has(r.table_name)) rels.set(r.table_name, new Set()); rels.get(r.table_name).add(r.column_name); }

const permCodes = new Set((await db.query('select code from permissions')).rows.map((r) => r.code));
let problems = 0, calls = 0;
const bad = (file, msg) => { problems++; console.log(`  ✗ ${file.replace(root + '/', '')}: ${msg}`); };
// Find the object literal that follows the function name and return its top-level keys.
function topKeys(src, start) {
  let i = start; while (/\s/.test(src[i])) i++;
  if (src[i] !== '{') return null;
  const keys = []; let depth = 0, expectKey = true, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') { const q = c; j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } continue; }
    if ('{[('.includes(c)) { depth++; if (depth === 1) expectKey = true; continue; }
    if ('}])'.includes(c)) { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && c === ',') { expectKey = true; continue; }
    if (depth === 1 && expectKey && /[A-Za-z_.]/.test(c)) {
      const m = /^(\.\.\.)?([A-Za-z_][\w]*)/.exec(src.slice(j)); if (m) { if (!m[1]) keys.push(m[2]); j += m[0].length - 1; } expectKey = false;
    }
  }
  return keys;
}
for (const file of files) {
  const src = readFileSync(file, 'utf8'); const web = file.includes('/web/');
  for (const m of src.matchAll(/\brpc\(\s*['"]([a-z_0-9]+)['"]\s*(,)?/g)) {
    const name = m[1]; calls++; if (process.env.VERBOSE) console.log("call", file.split("/").pop(), name);
    const f = fns.get(name);
    if (!f) { bad(file, `rpc '${name}' does not exist`); continue; }
    if (web && !f.auth) bad(file, `rpc '${name}' is not executable by signed-in users`);
    const keys = m[2] ? topKeys(src, m.index + m[0].length) : [];
    if (keys === null) continue;                       // arguments passed as a variable; cannot check statically
    for (const k of keys) if (!f.args.includes(k)) bad(file, `rpc '${name}' has no argument '${k}' (accepts: ${f.args.join(', ') || 'none'})`);
    for (const k of f.required) if (!keys.includes(k)) bad(file, `rpc '${name}' is missing required argument '${k}'`);
  }
  const tables = [...src.matchAll(/(?<![.\w])(?:list|listAll|getOne|insert|update|remove|select|countOf)\(\s*'([a-z_]+)'/g), ...src.matchAll(/\battach\([^,]+,\s*'[a-z_]+',\s*'([a-z_]+)'/g),
    ...[...src.matchAll(/(.{0,12})\.from\(['"]([a-z_]+)['"]\)/g)].filter((m) => !/storage/.test(m[1])).map((m) => [m[0], m[2]])];
  for (const m of tables) if (!rels.has(m[1])) bad(file, `table or view '${m[1]}' does not exist`);
  if (web) {
    const perms = [...src.matchAll(/\bcan\('([^']+)'\)/g), ...src.matchAll(/\bperm:\s*'([^']+)'/g), ...src.matchAll(/data-perm="([^"$]+)"/g)];
    for (const m of perms) for (const code of m[1].split('|')) if (!permCodes.has(code)) bad(file, `permission '${code}' does not exist`);
  }
  for (const m of src.matchAll(/table:\s*'([a-z_]+)'/g)) if (!rels.has(m[1])) bad(file, `table or view '${m[1]}' does not exist`);
}
if (process.env.VERBOSE) for (const [n, f] of fns) if (f.auth) console.log(n, f.args.join(','));
console.log(`\n${calls} rpc call(s) checked in ${files.length} file(s): ${problems ? `${problems} problem(s)` : 'all match the database'}`);
await db.close?.();
process.exit(problems ? 1 : 0);
