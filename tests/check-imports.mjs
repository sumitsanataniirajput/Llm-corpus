// Static check: every named import between web modules refers to a real export,
// and every rules.<name> used in a page exists in validation.js.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const files = []; (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(root);
const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));
const exportsOf = (f) => { const s = src[f]; const out = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) m[1].split(',').forEach((x) => { const n = x.trim().split(/\s+as\s+/).pop(); if (n) out.add(n); });
  if (/export\s+default/.test(s)) out.add('default'); return out; };
let problems = 0, checked = 0;
for (const f of files) {
  for (const m of src[f].matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(f), m[2]); if (!src[target]) { if (!target.endsWith('config.js')) { console.log(`${relative(root, f)}: imports missing file ${m[2]}`); problems++; } continue; }
    const ex = exportsOf(target);
    for (const n of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) { checked++; if (!ex.has(n)) { console.log(`${relative(root, f)}: "${n}" is not exported by ${m[2]}`); problems++; } }
  }
}
const v = src[join(root, 'js', 'validation.js')]; const rulesBody = v.slice(v.indexOf('export const rules'));
for (const f of files) for (const m of src[f].matchAll(/\brules\.([A-Za-z_]\w*)/g)) { checked++; if (!new RegExp(`\\b${m[1]}\\s*:`).test(rulesBody)) { console.log(`${relative(root, f)}: rules.${m[1]} does not exist`); problems++; } }
console.log(`\n${checked} import(s)/rule(s) checked in ${files.length} file(s): ${problems ? problems + ' problem(s)' : 'all resolve'}`);
process.exit(problems ? 1 : 0);
