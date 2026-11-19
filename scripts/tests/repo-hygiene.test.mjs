/** Repo-hygiene and documentation truthfulness contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('package-lock.json is tracked and npm scripts expose the repo gates', () => {
  const ignore = read('.gitignore');
  assert.doesNotMatch(ignore, /^package-lock\.json$/m, 'lockfile must not be ignored');
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), true);
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['test', 'test:baseline', 'check:migrations', 'test:docs', 'test:ci', 'verify:deployment']) {
    assert.equal(typeof pkg.scripts[script], 'string');
  }
  assert.match(pkg.scripts['test:ci'], /check:migrations/);
  assert.match(pkg.scripts['test:ci'], /test:baseline/);
});

test('no deployable source claims create_all, cloud gradient training or old WebSocket tokens', () => {
  const backend = fs.readdirSync(path.join(ROOT, 'backend/app'), { recursive: true })
    .filter((name) => name.endsWith('.py'))
    .map((name) => read(path.join('backend/app', name)))
    .join('\n');
  assert.doesNotMatch(backend, /metadata\.create_all/, 'startup must not auto-create schema');
  // Ignore prose in websocket_auth.py that warns against the old pattern; check
  // the actual browser client and endpoint source instead.
  const clientAndEndpoints = fs.readdirSync(path.join(ROOT, 'frontend/js'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => read(path.join('frontend/js', name)))
    .concat(fs.readdirSync(path.join(ROOT, 'backend/app/api/endpoints'))
      .filter((name) => name.endsWith('.py'))
      .map((name) => read(path.join('backend/app/api/endpoints', name))))
    .join('\n');
  assert.doesNotMatch(clientAndEndpoints, /\?token=/, 'WebSocket URLs must not carry credentials');

  const docs = ['README.md', 'AGENTS.md', 'docs/DEPLOYMENT.md', 'docs/STATUS_AND_LIMITATIONS.md']
    .map(read).join('\n');
  assert.match(docs, /cloud.*not implemented|no.*cloud gradient/i);
  assert.match(docs, /first.*frame|first-frame/i);
  assert.match(docs, /does\s+\*{0,2}not\*{0,2}\s+call\s+`?Base\.metadata\.create_all/i);
});

test('all forward-only SQL migrations are documented with a rollback playbook', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql')).sort();
  assert.ok(migrations.length >= 8);
  const playbook = read('docs/MIGRATIONS_AND_ROLLBACK.md');
  for (const name of migrations) assert.match(playbook, new RegExp(name.replace('.', '\\.')));
  assert.match(playbook, /Rollback strategy/i);
  assert.match(playbook, /no `009`/i);
  for (const name of migrations) {
    assert.doesNotMatch(read(`supabase/migrations/${name}`), /drop\s+table|drop\s+column|truncate\s+table|delete\s+from/i);
  }
});

test('historical docs no longer teach stale branches, builds, navigation or auth', () => {
  const docFiles = fs.readdirSync(path.join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
  const docs = ['README.md', 'AGENTS.md', ...docFiles].map(read).join('\n');
  const activeDocs = ['README.md', 'AGENTS.md', ...docFiles.filter((name) => !name.startsWith('docs/REPORT_'))]
    .map(read).join('\n');
  assert.doesNotMatch(activeDocs, /branch `arena\//i, 'stale working-branch note in active docs');
  assert.doesNotMatch(docs, /Branch: `arena\//, 'stale working-branch note');
  assert.doesNotMatch(docs, /build `2026-11-(?:19|20)\.\d+`/, 'stale build marker');
  assert.doesNotMatch(docs, /"build_id": "2026-11-16\.5"/, 'stale expected deployment example');
  assert.doesNotMatch(docs, /build 2026-11-16\.7/, 'stale manual-check build');
  assert.doesNotMatch(docs, /Click each bottom navigation item/, 'removed bottom navigation');
  assert.doesNotMatch(docs, /\/api\/v1\/training\/ws\/\{job_id\}\?token/, 'query-string socket auth');
  assert.match(read('docs/HOPEWEB_INSTALL.md'), /version\.json/);
  assert.match(read('docs/STATUS_AND_LIMITATIONS.md'), /checkpoint-backed inference/i);
  for (const report of ['docs/REPORT_AUTH_UPLOAD_REPAIR.md', 'docs/REPORT_PERFORMANCE_AUDIT.md']) {
    assert.match(read(report), /Historical engineering report/i, `${report} needs a current-status banner`);
  }
});

test('development CI runs real backend/frontend tests rather than only a live identity check', () => {
  const workflow = read('.github/workflows/verify.yml');
  assert.match(workflow, /npm ci|npm install/);
  assert.match(workflow, /npm run test:ci|npm test/);
  assert.match(workflow, /pytest/);
  assert.match(workflow, /check-migrations|test:ci/);
  assert.doesNotMatch(workflow, /verify-deployment/);
});
