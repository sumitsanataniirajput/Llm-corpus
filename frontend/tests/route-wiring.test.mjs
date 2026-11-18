/**
 * Route wiring: every sidebar entry must resolve to a real page module.
 *
 * The router keeps three parallel tables (PAGE_MODULES, MODULE_SCRIPTS and the
 * `routes` dispatch record) plus the navItems list. Adding a nav entry without
 * the other three produces a page that silently falls back to "module not
 * loaded", so the tables are checked against each other and against the files
 * on disk here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..');
const routerSource = fs.readFileSync(path.join(FRONTEND, 'js', 'router.js'), 'utf8');

function block(name) {
  const start = routerSource.indexOf(`const ${name} = {`);
  assert.ok(start !== -1, `${name} exists in router.js`);
  const end = routerSource.indexOf('\n  };', start);
  return routerSource.slice(start, end);
}

function pairs(name) {
  const body = block(name);
  const out = {};
  for (const match of body.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*'?([A-Za-z0-9_.\/-]+)'?,?$/gm)) {
    out[match[1]] = match[2];
  }
  return out;
}

const pageModules = pairs('PAGE_MODULES');
const moduleScripts = pairs('MODULE_SCRIPTS');

const navRoutes = [...routerSource.matchAll(/\{ route: '([a-z0-9-]+)', label: '/g)].map((m) => m[1]);
const dispatchRoutes = [...routerSource.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*(render[A-Za-z]+),$/gm)]
  .map((m) => m[1]);

test('every navigation entry has a module, a script and a renderer', () => {
  assert.ok(navRoutes.length >= 20, 'the navigation list is read');
  for (const route of navRoutes) {
    assert.ok(pageModules[route], `${route} has a PAGE_MODULES entry`);
    assert.ok(moduleScripts[route], `${route} has a MODULE_SCRIPTS entry`);
    assert.ok(dispatchRoutes.includes(route), `${route} has a renderer in the routes record`);
    const file = path.join(FRONTEND, moduleScripts[route]);
    assert.ok(fs.existsSync(file), `${route} points at an existing file (${moduleScripts[route]})`);
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, new RegExp(`window\\.${pageModules[route]}\\s*=`),
      `${moduleScripts[route]} publishes window.${pageModules[route]}`);
    assert.match(source, /(?:function render\b|render\s*[,:])/,
      `${moduleScripts[route]} exposes a render function`);
  }
});

test('the new teacher/distillation pages are reachable from the sidebar', () => {
  for (const route of ['ai-teachers', 'provider-management', 'teacher-selection',
    'knowledge-distillation', 'dataset-review', 'student-models',
    'training-intelligence', 'api-usage']) {
    assert.ok(navRoutes.includes(route), `${route} is in the sidebar`);
  }
});

test('index.html loads every page module exactly once with the current build id', () => {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'version.json'), 'utf8')).buildId;
  const config = fs.readFileSync(path.join(FRONTEND, 'js', 'config.js'), 'utf8');
  assert.match(config, new RegExp(`BUILD_ID: '${version.replace(/\./g, '\\.')}'`),
    'config.js carries the committed build id');
  assert.match(html, new RegExp(`content="${version.replace(/\./g, '\\.')}"`),
    'the corpus-build meta tag carries the committed build id');

  for (const route of Object.keys(pageModules)) {
    const file = moduleScripts[route];
    const occurrences = (html.match(new RegExp(`src="${file.replace(/[.\/]/g, '\\$&')}\\?`, 'g')) || []).length;
    assert.equal(occurrences, 1, `${file} is loaded exactly once`);
    assert.ok(html.includes(`${file}?v=${version}`), `${file} is stamped with ${version}`);
  }
});

test('a deep link resolves to its page and keeps the id in the hash', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="page-container"></div></body></html>',
    { url: 'https://example.com/#/dataset-review/dj_1', runScripts: 'dangerously' });
  dom.window.CORPUS_APP = { logDiagnostic() {}, recordError() {}, requirePageContainer: () => null };
  dom.window.state = { getRoute: () => 'dashboard' };
  dom.window.eval(fs.readFileSync(path.join(FRONTEND, 'js', 'router.js'), 'utf8'));

  assert.equal(dom.window.router.getRouteFromHash(), 'dataset-review',
    'the page route is resolved');
  assert.match(dom.window.location.hash, /dj_1$/,
    'the dataset id stays in the hash for the page to read');
  dom.window.close();
});
