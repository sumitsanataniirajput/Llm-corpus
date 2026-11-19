/**
 * Every route, through the real router, with the real page modules.
 *
 * The other suites call `window.<module>.render()` directly, which cannot catch
 * the failure this suite exists for: the router dispatching a route to a
 * renderer that then draws the "module not loaded" panel (or an error panel)
 * even though the module is fine.
 *
 * This boots frontend/index.html exactly as the browser does — every local
 * script in document order, the real router, the real registry, the real
 * navigation — and walks all 24 sidebar routes plus the hidden auth route.
 *
 * What is asserted per route:
 *   - the module's own render() is called, and it receives the route name
 *     (the AI Teacher Network regression: `renderer()` was called with no
 *     arguments, so a renderer shared by two routes had no idea which page to
 *     draw);
 *   - the page draws its real heading, not a placeholder;
 *   - neither "module not loaded" nor "Page failed to load" is on screen;
 *   - the sidebar marks exactly that route active and opens its section;
 *   - the hash and the session restore entry agree with the route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

/** The heading each page really renders when the account has no data. */
const EXPECTED_HEADING = {
  dashboard: 'Dashboard',
  statistics: 'Statistics',
  models: 'Models',
  training: 'Train a model',
  datasets: 'Dataset Manager',
  evaluation: 'Evaluation Center',
  experiments: 'Experiment Manager',
  'ai-information': 'AI Information',
  chat: 'AI Chat',
  'prediction-lab': 'Prediction Lab',
  'neural-lab': 'Neural Network Lab',
  compute: 'Compute Manager',
  'device-compute': 'This device',
  'multi-device': 'Devices & distribution',
  'cloud-storage': 'Cloud Storage',
  'ai-teachers': 'Who teaches your models',
  'provider-management': 'Connect an AI teacher',
  'teacher-selection': 'Choose who teaches, and who checks',
  'knowledge-distillation': 'Turn a dataset into teacher-generated training data',
  'dataset-review': 'What the teachers produced',
  'student-models': 'Which model learns, and how',
  'training-intelligence': 'What the training run is really doing',
  'api-usage': 'What the teachers cost',
  settings: 'Settings',
};

function registry() {
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', fs.readFileSync(path.join(FRONTEND, 'js', 'routes.js'), 'utf8'))(sandbox.window);
  return sandbox.window.CORPUS_ROUTES;
}

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const LIST_ENDPOINTS = new Set([
  '/api/v1/models', '/api/v1/datasets', '/api/v1/training', '/api/v1/experiments',
  '/api/v1/devices', '/api/v1/checkpoints', '/api/v1/students/models',
  '/api/v1/students/configs', '/api/v1/teachers/providers', '/api/v1/teachers/models',
  '/api/v1/training/events', '/api/v1/storage/objects',
]);

function bootApp({ hash = '#/dashboard', width = 390, height = 844 } = {}) {
  const dom = new JSDOM(INDEX.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/' + hash,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });

  // Chart.js stand-in with the shape the app's updateChart expects.
  window.Chart = class Chart {
    constructor(ctx, cfg) { this.ctx = ctx; this.data = (cfg && cfg.data) || { labels: [], datasets: [] }; this.options = (cfg && cfg.options) || {}; }
    update() {}
    destroy() {}
  };
  window.Swal = { fire: async () => ({ isConfirmed: false }) };
  window.AOS = { init() {}, refresh() {} };
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} removeEventListener() {} };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.scrollTo = () => {};
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }), measureText: () => ({ width: 0 }) };
  };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

  window.fetch = async (url) => {
    const pathname = new URL(url, 'http://localhost').pathname.replace(/\/$/, '');
    // An empty account: list endpoints answer [], everything else answers an
    // empty object or a 404. Pages must degrade to their empty states.
    if (LIST_ENDPOINTS.has(pathname)) return json([]);
    if (/^\/api\/v1\/training\/[^/]+$/.test(pathname)) return json({ detail: 'not found' }, 404);
    return json({ detail: 'not found: ' + pathname }, 404);
  };

  const loaded = [];
  for (const match of INDEX.matchAll(/<script\s+src="(js\/[^"]+)"/g)) {
    const rel = match[1].split('?')[0];
    try {
      window.eval(fs.readFileSync(path.join(FRONTEND, rel), 'utf8'));
    } catch (err) {
      throw new Error(`${rel} failed to execute: ${err.message}`);
    }
    loaded.push(rel);
  }

  window.CORPUS_SUPABASE = {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1', email: 'tester@example.com' } } } }),
    init() {},
    signIn: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }),
    signOut: async () => ({}),
    onAuthStateChange() { return { unsubscribe() {} }; },
  };

  const container = window.document.getElementById('page-container');
  if (window.CORPUS_APP && window.CORPUS_APP.setPageContainer) window.CORPUS_APP.setPageContainer(container);

  return { dom, window, doc: window.document, container, loaded };
}

async function startApp(app) {
  app.window.state.setUser({ id: 'user-1', email: 'tester@example.com' });
  app.window.state.setAuthReady(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** Wrap a page module's render so the test can prove it ran, and with what. */
function spyOn(app, moduleName) {
  const page = app.window[moduleName];
  const original = page.render.bind(page);
  const calls = [];
  page.render = async (route) => {
    calls.push(route);
    return original(route);
  };
  return calls;
}

function visibleText(doc) {
  const container = doc.getElementById('page-container');
  return (container.textContent || '').replace(/\s+/g, ' ').trim();
}

test('the app boots with every registry module registered', async () => {
  const app = bootApp();
  await startApp(app);
  const reg = registry();
  for (const entry of reg.modules()) {
    assert.ok(app.window[entry.module], `window.${entry.module} is registered (${entry.script})`);
    assert.equal(typeof app.window[entry.module].render, 'function', `window.${entry.module}.render exists`);
  }
  app.dom.window.close();
});

const VIEWPORTS = [
  { name: 'phone 390x844', width: 390, height: 844 },
  { name: 'desktop 1440x900', width: 1440, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test(`every route renders its real page through the router — ${viewport.name}`, async () => {
    const app = bootApp({ width: viewport.width, height: viewport.height });
    await startApp(app);
    const reg = registry();
    const failures = [];

    for (const entry of reg.ROUTES) {
      const calls = spyOn(app, entry.module);
      app.window.location.hash = '#/' + entry.route;
      await app.window.router.navigate(entry.route);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const html = app.container.innerHTML;
      const text = visibleText(app.doc);
      const heading = app.container.querySelector('.section-title, h1, h2, h3');

      if (!calls.length) failures.push(`${entry.route}: ${entry.module}.render was never called`);
      else if (calls[calls.length - 1] !== entry.route) {
        failures.push(`${entry.route}: render received "${calls[calls.length - 1]}" instead of its route`);
      }
      if (/module not loaded/i.test(html)) failures.push(`${entry.route}: showed the missing-module panel`);
      if (/Page failed to load/i.test(html)) failures.push(`${entry.route}: showed the error panel — ${text.slice(0, 160)}`);
      if (html.trim().length < 120) failures.push(`${entry.route}: rendered almost nothing (${html.length} chars)`);

      const expected = EXPECTED_HEADING[entry.route];
      const rendered = heading ? heading.textContent.trim() : '';
      if (expected && rendered !== expected) {
        failures.push(`${entry.route}: heading "${rendered}" (expected "${expected}")`);
      }
    }

    // Navigating the whole menu must not leave uncaught errors behind.
    const log = (app.window.CORPUS_APP.getDiagnostics() || {}).errorLog || [];
    const renderFailures = log.filter((entry) => /router\.render|router\.module|uncaught/i.test(entry.source || ''));
    assert.equal(renderFailures.length, 0,
      'no render or module error was recorded while walking the menu:\n' +
      renderFailures.map((entry) => `${entry.source}: ${entry.message}`).join('\n'));

    assert.deepEqual(failures, [], failures.join('\n'));
    app.dom.window.close();
  });
}

test('the AI Teacher Network and AI API Keys routes both draw their own view', async () => {
  const app = bootApp();
  await startApp(app);

  await app.window.router.navigate('ai-teachers');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const teachersText = visibleText(app.doc);
  assert.match(teachersText, /Who teaches your models/, 'AI Teacher Network renders its overview');
  assert.match(teachersText, /Provider|teacher/i, 'the overview lists teachers/providers');
  assert.ok(!/module not loaded/i.test(app.container.innerHTML));

  await app.window.router.navigate('provider-management');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const keysText = visibleText(app.doc);
  assert.match(keysText, /Connect an AI teacher/, 'AI API Keys renders the connection form');
  assert.notEqual(keysText, teachersText, 'the two routes are different pages, not one repeated');

  app.dom.window.close();
});

test('the active route is marked in the sidebar and its section opens', async () => {
  const app = bootApp();
  await startApp(app);
  const nav = app.doc.getElementById('sidebar-nav');

  for (const entry of registry().ROUTES) {
    await app.window.router.navigate(entry.route);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const active = nav.querySelectorAll('.nav-item.active');
    assert.equal(active.length, 1, `${entry.route}: exactly one active item`);
    assert.equal(active[0].dataset.route, entry.route, `${entry.route}: the right item is active`);
    assert.equal(active[0].getAttribute('aria-current'), 'page', `${entry.route}: aria-current is set`);
    assert.equal(active[0].textContent.trim(), entry.label, `${entry.route}: the item shows its label`);

    const group = nav.querySelector(`.nav-group[data-group="${entry.group}"]`);
    assert.ok(group, `${entry.route}: its group exists`);
    assert.equal(group.open, true, `${entry.route}: its section is open so the item is visible`);
  }

  app.dom.window.close();
});

test('the hash, the restore entry and the route stay in agreement', async () => {
  const app = bootApp();
  await startApp(app);

  await app.window.router.navigate('dataset-review');
  assert.equal(app.window.location.hash, '#/dataset-review');
  assert.equal(app.window.sessionStorage.getItem('corpus:last-route'), 'dataset-review');

  // An old bookmark is rewritten to the page that replaced it.
  app.window.location.hash = '#/ai-api-keys';
  const resolved = app.window.router.getRouteFromHash();
  assert.equal(resolved, 'provider-management');
  await app.window.router.navigate('#/ai-api-keys');
  assert.equal(app.window.location.hash, '#/provider-management', 'the alias is rewritten, not left in the URL');
  assert.equal(app.doc.querySelector('.nav-item.active').dataset.route, 'provider-management');

  app.dom.window.close();
});

test('an unknown route falls back to the dashboard instead of a blank page', async () => {
  const app = bootApp({ hash: '#/this-route-does-not-exist' });
  await startApp(app);
  assert.equal(app.window.router.getRouteFromHash(), 'dashboard');
  assert.match(visibleText(app.doc), /Dashboard/);
  assert.ok(!/module not loaded/i.test(app.container.innerHTML));
  app.dom.window.close();
});

test('a deep link with an id opens its own page, not the dashboard', async () => {
  const app = bootApp({ hash: '#/dataset-review/dj_123' });
  await startApp(app);
  assert.equal(app.window.router.getRouteFromHash(), 'dataset-review');
  assert.match(visibleText(app.doc), /What the teachers produced/);
  assert.equal(app.window.location.hash, '#/dataset-review', 'the id stays in the hash for the page to parse');
  app.dom.window.close();
});
