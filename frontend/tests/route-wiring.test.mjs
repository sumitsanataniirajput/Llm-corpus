/**
 * Route registry contract.
 *
 * Every page is declared once in `frontend/js/routes.js`. The router, the
 * bootstrap module check and the sidebar all read that table, so the things
 * that used to drift apart silently — a route whose script was never added to
 * index.html, a label with no route, two files fighting over one global — are
 * checked here against the real files and the real document.
 *
 * No chips are drawn on assumption: the registry is executed and inspected, and
 * the files it points at are read from disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');

const html = read('index.html');
const version = JSON.parse(read('version.json'));
const configSource = read('js/config.js');
const routerSource = read('js/router.js');
const bootstrapSource = read('js/app-bootstrap.js');

/** Execute routes.js (pure data + helpers, no DOM) and return the registry. */
function loadRegistry() {
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', read('js/routes.js'))(sandbox.window);
  assert.ok(sandbox.window.CORPUS_ROUTES, 'routes.js publishes window.CORPUS_ROUTES');
  return sandbox.window.CORPUS_ROUTES;
}

const registry = loadRegistry();

/** Local script sources in document order. */
const scripts = [...html.matchAll(/<script\s+src="(js\/[^"]+)"/g)].map((m) => m[1].split('?')[0]);

test('the registry declares every page exactly once with a module, script and group', () => {
  assert.ok(registry.ROUTES.length >= 24, `expected at least 24 routes, found ${registry.ROUTES.length}`);

  const seenRoutes = new Set();
  for (const entry of registry.ROUTES) {
    for (const field of ['route', 'module', 'script', 'label', 'icon', 'group']) {
      assert.ok(entry[field], `${entry.route || '(route)'} is missing ${field}`);
    }
    assert.match(entry.route, /^[a-z0-9-]+$/, `${entry.route} is a valid hash route`);
    assert.match(entry.script, /^js\/[a-z0-9-]+\.js$/, `${entry.route} points at a js file`);
    assert.ok(!seenRoutes.has(entry.route), `${entry.route} is declared twice`);
    seenRoutes.add(entry.route);
    assert.ok(registry.group(entry.group), `${entry.route} belongs to a declared group (${entry.group})`);
    assert.ok(fs.existsSync(path.join(FRONTEND, entry.script)), `${entry.script} exists on disk`);
  }
});

test('every declared module registers a global with a render() function', () => {
  for (const entry of registry.ROUTES) {
    const source = read(entry.script);
    assert.match(source, new RegExp(`window\\.${entry.module}\\s*=`),
      `${entry.script} publishes window.${entry.module}`);
    assert.match(source, /(?:function render\b|\brender\s*[,:])/,
      `${entry.script} defines render()`);
  }
});

test('each page module is loaded exactly once, before the bootstrap, at the current build id', () => {
  for (const script of registry.scripts()) {
    const occurrences = scripts.filter((src) => src === script).length;
    assert.equal(occurrences, 1, `${script} is declared exactly once in index.html`);
    assert.ok(scripts.indexOf(script) < scripts.indexOf('js/app-bootstrap.js'),
      `${script} loads before app-bootstrap.js runs`);
    assert.ok(html.includes(`${script}?v=${version.buildId}`), `${script} is cache-busted`);
  }
});

test('the registry loads before the router and the bootstrap', () => {
  const registryIndex = scripts.indexOf('js/routes.js');
  assert.notEqual(registryIndex, -1, 'index.html loads js/routes.js');
  assert.equal(scripts.filter((src) => src === 'js/routes.js').length, 1, 'loaded once');
  assert.ok(registryIndex < scripts.indexOf('js/router.js'), 'routes.js precedes router.js');
  assert.ok(registryIndex < scripts.indexOf('js/app-bootstrap.js'), 'routes.js precedes the bootstrap');
});

test('the router and the bootstrap take their tables from the registry', () => {
  assert.match(routerSource, /window\.CORPUS_ROUTES/, 'router reads the registry');
  assert.match(bootstrapSource, /window\.CORPUS_ROUTES/, 'bootstrap module check reads the registry');
  assert.match(bootstrapSource, /registry\.modules\(\)/, 'the bootstrap verifies every module, not a hand-kept list');

  // No renderer may hard-code a route string again: that is what made
  // renderTeachers() receive `undefined` and show "module not loaded".
  const hardcoded = [...routerSource.matchAll(/renderModulePage\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(hardcoded, [], 'no page renderer hard-codes its own route');
  // Only the generic page renderer and the auth page may exist; a per-page
  // wrapper (the old renderTeachers, renderDistillation, …) is exactly how a
  // route lost its argument.
  const wrappers = [...routerSource.matchAll(/^  (?:async )?function render(Page|Auth)\b/gm)]
    .map((m) => m[1]);
  assert.deepEqual([...wrappers].sort(), ['Auth', 'Page'],
    'one shared renderer plus the auth page — a per-page wrapper cannot drift');
});

test('no two files assign the same window global', () => {
  const files = fs.readdirSync(path.join(FRONTEND, 'js')).filter((f) => f.endsWith('.js'));
  const owners = new Map();
  for (const file of files) {
    const source = read(path.join('js', file));
    for (const match of source.matchAll(/^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm)) {
      const name = match[1];
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(file);
    }
  }
  const duplicates = [...owners.entries()].filter(([, files2]) => files2.length > 1);
  for (const [name, list] of duplicates) {
    // The one allowed overlap must be a merge, not a replacement: components.js
    // extends the ui object auth.js already populated.
    assert.deepEqual(list.sort(), ['auth.js', 'components.js'], `unexpected duplicate global window.${name}`);
    const components = read('js/components.js');
    assert.match(components, /window\.ui = Object\.assign\(window\.ui \|\| \{\}/,
      'components.js merges into window.ui instead of replacing it (auth helpers live there)');
  }
});

test('the sidebar lists exactly the requested pages, in grouped sections', () => {
  const required = [
    'Dashboard', 'Models', 'Training Center', 'Statistics', 'AI Information', 'Chat',
    'Prediction Lab', 'Neural Lab', 'Datasets', 'Evaluation', 'Compute', 'Device Compute',
    'Multi-Device Training', 'Cloud Storage', 'Experiments', 'AI Teacher Network',
    'AI API Keys', 'Teacher Selection', 'Knowledge Distillation', 'Dataset Quality Review',
    'Student Model Studio', 'Training Intelligence', 'API Usage & Budgets', 'Settings',
  ];
  const labels = registry.ROUTES.map((entry) => entry.label);
  assert.deepEqual([...labels].sort(), [...required].sort(), 'the menu matches the requested page list');

  const groupIds = new Set(registry.ROUTES.map((entry) => entry.group));
  assert.ok(groupIds.size >= 5, 'pages are grouped into at least five sections');
  for (const id of groupIds) {
    assert.ok(registry.routesInGroup(id).length > 0, `${id} has at least one page`);
  }
});

test('every group is declared with a label and an icon and is used', () => {
  for (const group of registry.GROUPS) {
    assert.ok(group.id && group.label && group.icon, `${group.id} is fully declared`);
    assert.ok(registry.routesInGroup(group.id).length > 0, `${group.id} contains pages`);
  }
  const declared = new Set(registry.GROUPS.map((group) => group.id));
  for (const entry of registry.ROUTES) {
    assert.ok(declared.has(entry.group), `${entry.route} points at a declared group`);
  }
});

test('old bookmarks resolve to the page that replaced them', () => {
  assert.equal(registry.canonical('ai-api-keys'), 'provider-management');
  assert.equal(registry.canonical('api-keys'), 'provider-management');
  assert.equal(registry.canonical('#/knowledge-distillation'), 'knowledge-distillation');
  assert.equal(registry.canonical('knowledge-distillation/'), 'knowledge-distillation');
  assert.equal(registry.canonical('not-a-route'), 'not-a-route');
  assert.equal(registry.isKnown('not-a-route'), false);
  assert.equal(registry.isKnown('auth'), true);
});

test('the build id matches in the document, the config and version.json', () => {
  assert.match(configSource, new RegExp(`BUILD_ID: '${version.buildId.replace(/\./g, '\\.')}'`));
  assert.match(html, new RegExp(`content="${version.buildId.replace(/\./g, '\\.')}"`));
  const unversioned = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]*)"/g)]
    .map((m) => m[1])
    .filter((href) => !href.includes('?v='));
  assert.deepEqual(unversioned, [], 'every local asset is cache-busted');
});
