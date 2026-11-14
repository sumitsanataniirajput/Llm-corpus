// Static check of direct table writes made by the console (insert / update / upsert):
// every column written must exist AND be writable by signed-in staff (table or column grant).
// Columns come from object literals at the call site and from the field names of the form that feeds the call.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, all } from './lib/db.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await createDb();
const priv = {}; for (const r of await all(db, `select c.table_name t, c.column_name c, has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'INSERT') i, has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'UPDATE') u from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`)) (priv[r.t] ??= {})[r.c] = r;
const dir = path.join(root, 'web/js/pages'); let problems = 0, checked = 0, calls = 0; const unverified = [];
const balanced = (s, i) => { let d = 0; for (let j = i; j < s.length; j += 1) { const ch = s[j]; if (ch === '(' || ch === '{' || ch === '[') d += 1; else if (ch === ')' || ch === '}' || ch === ']') { d -= 1; if (d === 0) return s.slice(i, j + 1); } } return s.slice(i); };
const literalKeys = (obj) => { const out = []; let d = 0, tok = '', spread = false; const body = obj.slice(1, -1); let i = 0;
  const parts = []; let cur = ''; let q = null;
  for (; i < body.length; i += 1) { const ch = body[i]; if (q) { cur += ch; if (ch === q && body[i - 1] !== '\\') q = null; continue; } if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; } if ('({['.includes(ch)) d += 1; if (')}]'.includes(ch)) d -= 1; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) { if (p.startsWith('...')) { spread = true; continue; } const m = /^['"]?([A-Za-z_][\w]*)['"]?\s*(:|$)/.exec(p); if (m) out.push(m[1]); }
  return { keys: out, spread }; };
for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const s = readFileSync(path.join(dir, f), 'utf8');
  const re = /\b(insert|update)\('([a-z_]+)',|\.from\('([a-z_]+)'\)\.(upsert|insert|update)\(/g; let m;
  while ((m = re.exec(s))) {
    const kind = m[1] ?? m[4], table = m[2] ?? m[3]; calls += 1; if (!priv[table]) { console.log(`${f}: write to unknown table ${table}`); problems += 1; continue; }
    const open = m[1] ? m.index + m[1].length : m.index + m[0].length - 1; const call = balanced(s, open); const args = call.slice(1, -1);
    // last top-level argument is the values
    let d = 0, last = 0, q = null; for (let i = 0; i < args.length; i += 1) { const ch = args[i]; if (q) { if (ch === q && args[i - 1] !== '\\') q = null; continue; } if ("'\"`".includes(ch)) { q = ch; continue; } if ('({['.includes(ch)) d += 1; if (')}]'.includes(ch)) d -= 1; if (ch === ',' && d === 0) last = i + 1; }
    let val = args.slice(last).trim(); if (m[1] === 'update' ) { /* update(table, id, values[, key]) */ const tops = []; d = 0; q = null; let st = 0; for (let i = 0; i <= args.length; i += 1) { const ch = args[i]; if (i === args.length || (ch === ',' && d === 0 && !q)) { tops.push(args.slice(st, i).trim()); st = i + 1; continue; } if (q) { if (ch === q) q = null; continue; } if ("'\"`".includes(ch)) { q = ch; continue; } if ('({['.includes(ch)) d += 1; if (')}]'.includes(ch)) d -= 1; } val = tops[2] ?? ''; }
    if (m[1] === 'insert') { const tops = args.split(/,(?![^({[]*[)}\]])/); val = args.slice(args.indexOf(',') + 1).trim(); }
    let keys = [], formVar = null; const before = s.slice(0, m.index);
    const fromLiteral = (text) => { const lit = literalKeys(balanced(text, 0)); keys.push(...lit.keys); const sp = /\.\.\.([A-Za-z_]\w*)/.exec(text.slice(0, balanced(text, 0).length)); return lit.spread ? sp?.[1] ?? '?' : null; };
    const resolve = (name, depth = 0) => { // an identifier: a nearby `const name = {…}` literal, or the form values
      const def = [...before.matchAll(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\{`, 'g'))].pop();
      if (def && m.index - def.index < 4000) { const at = def.index + def[0].length - 1; const more = fromLiteral(s.slice(at)); if (more && more !== name && depth < 2) resolve(more, depth + 1); return; }
      formVar = name; };
    if (val.startsWith('{')) { const more = fromLiteral(val); if (more) resolve(more); }
    else if (/^[A-Za-z_]\w*$/.test(val)) resolve(val);
    else { const lits = [...val.matchAll(/\{/g)]; if (!lits.length) unverified.push(`${f}: ${kind} ${table} — ${val.slice(0, 60)}`); for (const l of lits.slice(0, 1)) { /* conditional expression: check each object literal branch */ let i = 0; while ((i = val.indexOf('{', i)) >= 0) { const blk = balanced(val, i); const more = fromLiteral(blk); if (more) resolve(more); i += blk.length; } } }
    if (formVar) { const at = before.lastIndexOf('formModal('); const fm = at >= 0 ? balanced(s, at + 'formModal'.length) : ''; const param = /onSubmit:\s*(?:async\s*)?\(?\s*(\{[^}]*\}|[A-Za-z_]\w*)/.exec(fm)?.[1] ?? '';
      const rest = /\.\.\.([A-Za-z_]\w*)/.exec(param)?.[1]; const direct = param === formVar || rest === formVar;
      if (at < 0 || m.index > at + fm.length || !direct) unverified.push(`${f}: ${kind} ${table} — values built in code from "${formVar}" (reviewed by hand)`);
      else { let text = fm; const ref = /fields:\s*([A-Za-z_]\w*)\s*(\(|,|\})/.exec(fm); if (ref) { const def = [...before.matchAll(new RegExp(`const ${ref[1]}\\s*=[^\\[]*\\[`, 'g'))].pop(); if (def) text = balanced(s, def.index + def[0].length - 1); }
        const dropped = new Set(param.startsWith('{') ? param.slice(1).split(',').map((x) => x.trim().split(':')[0].trim()).filter((x) => x && !x.startsWith('...')) : []);
        for (const n of text.matchAll(/\{\s*name:\s*'([a-z_][a-z0-9_]*)'([^{}]*)/g)) if (!dropped.has(n[1]) && !/type:\s*'(section|static)'/.test(n[2])) keys.push(n[1]); } }
    keys = keys.filter((k) => !(kind === 'upsert' && k === 'onConflict'));
    for (const k of new Set(keys)) { checked += 1; const p = priv[table][k]; const need = kind === 'update' ? 'u' : kind === 'insert' ? 'i' : 'i';
      if (!p) { console.log(`${f}: ${kind} ${table}.${k} — column does not exist`); problems += 1; } else if (!p[need]) { console.log(`${f}: ${kind} ${table}.${k} — staff have no ${kind === 'update' ? 'UPDATE' : 'INSERT'} grant on this column`); problems += 1; } }
  }
}
console.log(`\n${calls} write call(s), ${checked} column(s) checked: ${problems ? problems + ' problem(s)' : 'all columns exist and are writable'}`);
if (unverified.length && process.env.VERBOSE) { console.log('\nNot statically verifiable:'); unverified.forEach((u) => console.log('  ' + u)); } else if (unverified.length) console.log(`${unverified.length} call(s) not statically verifiable (VERBOSE=1 to list)`);
process.exit(problems ? 1 : 0);
