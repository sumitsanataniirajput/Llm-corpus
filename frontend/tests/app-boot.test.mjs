/**
 * Whole-application boot test.
 *
 * The other suites load a hand-picked list of modules and replace
 * `window.CORPUS_APP` and `window.router` with stubs, so they can never catch
 * the failure the user actually hit: a page script that does not register its
 * global (bad syntax, truncated download, stale cached file) and therefore
 * leaves the Datasets route showing "Datasets module not loaded."
 *
 * This suite reads frontend/index.html, loads **every** local script in the
 * exact document order index.html uses, and then drives the REAL router:
 *
 *   - every script parses and executes (a syntax error fails the test);
 *   - every page module registers `<global>.render`;
 *   - navigating to #/datasets renders the Dataset Manager (upload button,
 *     file input, name field, queue, library) and never the missing-module
 *     panel;
 *   - selecting a file does not reload the document;
 *   - if a module global is wiped (simulating a stale cached script) the router
 *     re-requests that one file with a cache-busting query and recovers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'version.json'), 'utf8'));

/** Local scripts in <script src="js/..."> order, exactly as the browser runs them. */
function localScripts() {
  const scripts = [];
  const re = /<script\s+src="(js\/[^"]+)"/g;
  let match;
  while ((match = re.exec(INDEX_HTML)) !== null) {
    scripts.push(match[1].split('?')[0]);
  }
  return scripts;
}

const PAGE_GLOBALS = {
  dashboard: 'js/dashboard.js',
  models: 'js/models.js',
  training: 'js/training.js',
  statistics: 'js/statistics.js',
  aiInfo: 'js/ai-information.js',
  chat: 'js/chat.js',
  prediction: 'js/prediction.js',
  neuralLab: 'js/neural-lab.js',
  datasets: 'js/datasets.js',
  evaluation: 'js/evaluation.js',
  compute: 'js/compute.js',
  storage: 'js/storage.js',
  experiments: 'js/experiments.js',
  settings: 'js/settings.js',
};

function fakeIndexedDB() {
  const store = new Map();
  return {
    open() {
      const request = { result: null };
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          transaction() {
            const tx = {};
            const objectStore = {
              get(key) {
                const getRequest = { result: store.get(key) || null };
                setTimeout(() => getRequest.onsuccess && getRequest.onsuccess(), 0);
                return getRequest;
              },
              put(record) {
                store.set(record.ownerId, record);
                setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              },
              delete(key) {
                store.delete(key);
                setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              },
            };
            tx.objectStore = () => objectStore;
            tx.error = null;
            return tx;
          },
          close() {},
        };
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

/** Boot index.html with every local script evaluated in document order. */
function bootApp({ datasets = [], hash = '#/datasets' } = {}) {
  const dom = new JSDOM(INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/' + hash,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // --- browser APIs jsdom does not implement (or that talk to the network) --
  window.indexedDB = fakeIndexedDB();
  window.Chart = class { constructor() { this.data = {}; } update() {} destroy() {} };
  window.Swal = { fire: () => {} };
  window.AOS = { init() {}, refresh() {} };
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} };
  window.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
    open() {} setRequestHeader() {} getResponseHeader() { return 'application/json'; }
    send() { this.status = 200; this.responseText = '{}'; if (this.onload) this.onload(); }
  };
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }) };
  };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.scrollTo = () => {};

  const calls = [];
  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const route = new URL(url, 'http://localhost').pathname.replace(/\/$/, '');
    calls.push({ method, route });
    if (route === '/api/v1/datasets' && method === 'GET') return jsonResponse(datasets);
    if (route === '/api/v1/datasets' && method === 'POST') {
      return jsonResponse({ id: 'ds_new', name: 'TXT corpus', format: 'txt', status: 'pending', has_file: false });
    }
    if (route === '/api/v1/models' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/training' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/health') return jsonResponse({ status: 'ok' });
    return jsonResponse({ detail: 'not found: ' + route }, 404);
  };

  // --- load the real scripts in document order ----------------------------
  const loaded = [];
  for (const rel of localScripts()) {
    const code = fs.readFileSync(path.join(FRONTEND_DIR, rel), 'utf8');
    // A SyntaxError here is exactly what breaks "Datasets module not loaded"
    // in production, so let it fail the test with the file name attached.
    try {
      window.eval(code);
    } catch (err) {
      throw new Error(`${rel} failed to execute: ${err.message}`);
    }
    loaded.push(rel);
  }

  // supabase-client.js defines window.CORPUS_SUPABASE while loading, so the
  // network-free stub must be installed *after* the scripts run.
  window.CORPUS_SUPABASE = {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1' } } } }),
    init() {},
    signIn: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1', email: 'tester@example.com' } } }, error: null }),
    signOut: async () => ({}),
    // auth.init() subscribes here; the tests fire the events Supabase would.
    onAuthStateChange(cb) {
      window.__authStateCallbacks = window.__authStateCallbacks || [];
      window.__authStateCallbacks.push(cb);
      return { unsubscribe() {} };
    },
  };

  // In production the bootstrap hands the container to CORPUS_APP before the
  // first render; do the same here so the router's requirePageContainer works.
  const container = window.document.getElementById('page-container');
  if (container && window.CORPUS_APP && window.CORPUS_APP.setPageContainer) {
    window.CORPUS_APP.setPageContainer(container);
  }

  return { dom, window, doc: window.document, calls, loaded };
}

/**
 * Finish a real boot: mark the (stubbed) session as signed in and let
 * app-bootstrap run its own start() → router.init() → router.render() sequence.
 * The bootstrap schedules itself 50 ms after the scripts load, so this waits
 * for it instead of racing it.
 */
async function startApp(app) {
  app.window.state.setUser({ id: 'user-1', email: 'tester@example.com' });
  app.window.state.setAuthReady(true);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/** Router navigation on top of the finished boot. */
async function goTo(window, route) {
  window.location.hash = '#/' + route;
  await window.router.navigate(route);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test('every script in index.html executes and registers its page module', () => {
  const app = bootApp();
  const scripts = localScripts();
  assert.ok(scripts.includes('js/datasets.js'), 'index.html must load js/datasets.js');
  assert.ok(
    scripts.indexOf('js/datasets.js') < scripts.indexOf('js/app-bootstrap.js'),
    'the datasets module loads before the bootstrap starts'
  );
  assert.equal(app.loaded.length, scripts.length, 'every declared script was executed');

  for (const [global, file] of Object.entries(PAGE_GLOBALS)) {
    assert.ok(app.window[global], `window.${global} is not registered (${file})`);
    assert.equal(typeof app.window[global].render, 'function', `window.${global}.render is missing (${file})`);
  }
  assert.equal(typeof app.window.datasets.loadDatasets, 'function');
  assert.equal(typeof app.window.router.navigate, 'function');
  assert.equal(typeof app.window.CORPUS_APP.getDiagnostics, 'function');
  app.dom.window.close();
});

test('the Datasets route renders the full Dataset Manager, not the missing-module panel', async () => {
  const app = bootApp({
    datasets: [{
      id: 'ds_uploaded', owner_id: 'user-1', name: 'Wiki corpus', format: 'txt',
      size: 2048, file_size: 2048, file_name: 'wiki.txt', status: 'uploaded',
      has_file: true, trainable: true, uploaded_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }],
  });
  await startApp(app);

  await goTo(app.window, 'datasets');

  const text = app.doc.body.textContent;
  assert.doesNotMatch(text, /module not loaded/i, 'the missing-module panel must not be shown');
  assert.doesNotMatch(text, /Page failed to load/i);

  const container = app.doc.getElementById('page-container');
  assert.match(container.textContent, /Dataset Manager/);
  assert.match(container.textContent, /Upload dataset/);
  assert.match(container.textContent, /Tap to choose files/);
  assert.match(container.textContent, /TXT, MD, CSV, JSON, JSONL, PDF/);

  // Controls required by the acceptance criteria.
  assert.ok(app.doc.getElementById('datasets-file'), 'file picker input exists');
  assert.ok(app.doc.getElementById('datasets-name'), 'dataset name field exists');
  assert.ok(app.doc.getElementById('datasets-file-list'), 'selected-file queue exists');
  assert.ok(app.doc.getElementById('datasets-library'), 'dataset library exists');
  assert.ok(app.doc.getElementById('datasets-upload-btn'), 'Upload button exists');
  assert.equal(app.doc.getElementById('datasets-file').type, 'file');
  assert.equal(app.doc.getElementById('datasets-file').multiple, true);

  // The library shows the backend's dataset, i.e. listing works through the API.
  assert.match(app.doc.getElementById('datasets-library').textContent, /Wiki corpus/);
  assert.ok(
    app.calls.some((c) => c.route === '/api/v1/datasets' && c.method === 'GET'),
    'the page fetched the dataset list from the backend'
  );
  app.dom.window.close();
});

test('selecting a file never reloads the page and fills the queue', async () => {
  const app = bootApp();
  await startApp(app);
  await goTo(app.window, 'datasets');

  let reloads = 0;
  app.window.addEventListener('beforeunload', () => { reloads += 1; });

  const input = app.doc.getElementById('datasets-file');
  const file = new app.window.File(['hello corpus'], 'corpus.txt', { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });

  const changeEvent = new app.window.Event('change', { bubbles: true, cancelable: true });
  input.dispatchEvent(changeEvent);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(reloads, 0, 'a file selection must not navigate/reload');
  assert.equal(changeEvent.defaultPrevented, false, 'the change event is not cancelled (it is a local action)');
  assert.match(app.doc.getElementById('datasets-file-list').textContent, /corpus\.txt/);
  assert.match(app.doc.getElementById('datasets-file-list').textContent, /ready/);
  app.dom.window.close();
});

test('a wiped module global is re-requested with a cache-busting query and recovers', async () => {
  const app = bootApp();
  await startApp(app);

  // Simulate what a stale/broken cached script leaves behind.
  const realDatasets = app.window.datasets;
  delete app.window.datasets;

  const requested = [];
  app.window.CORPUS_MODULE_LOADER = (src) => {
    requested.push(src);
    app.window.datasets = realDatasets; // the re-request succeeds
    return true;
  };

  await goTo(app.window, 'datasets');

  assert.deepEqual(requested.length, 1, 'exactly one recovery request');
  assert.match(requested[0], /^js\/datasets\.js\?v=/);
  assert.ok(requested[0].includes(encodeURIComponent(VERSION.buildId)) || requested[0].includes(VERSION.buildId),
    'the re-request carries the build id');
  assert.match(requested[0], /retry=\d+/, 'and a unique retry marker so no cache can answer it');
  assert.match(app.doc.getElementById('page-container').textContent, /Dataset Manager/);
  assert.doesNotMatch(app.doc.body.textContent, /module not loaded/i);
  app.dom.window.close();
});

test('an unrecoverable module shows diagnostics with build id, script URL and retry result', async () => {
  const app = bootApp();
  await startApp(app);

  delete app.window.datasets;
  const requested = [];
  app.window.CORPUS_MODULE_LOADER = (src) => { requested.push(src); return false; };

  await goTo(app.window, 'datasets');
  const text = app.doc.getElementById('page-container').textContent;

  assert.match(text, /module not loaded/i);
  assert.match(text, new RegExp('Frontend build:\\s*' + VERSION.buildId.replace(/\./g, '\\.')));
  assert.match(text, /Expected script:\s*js\/datasets\.js\?v=/);
  assert.match(text, /Automatic recovery:\s*re-requested/);
  assert.equal(requested.length, 1);
  app.dom.window.close();
});

test('a Supabase SIGNED_IN event on reload does not yank the user to the dashboard', async () => {
  const app = bootApp();
  await startApp(app);
  await goTo(app.window, 'datasets');

  const container = app.doc.getElementById('page-container');
  assert.match(container.textContent, /Dataset Manager/);
  assert.equal(app.window.location.hash, '#/datasets');

  // supabase-js re-emits SIGNED_IN when it restores/refreshes a stored session
  // (page reload, token refresh, coming back from the Android file picker).
  // That must not be treated as a fresh login.
  const cbs = app.window.__authStateCallbacks || [];
  assert.ok(cbs.length > 0, 'auth.init() subscribed to auth state changes');
  cbs.forEach((cb) => cb('SIGNED_IN', { user: { id: 'user-1', email: 'tester@example.com' } }));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(app.window.location.hash, '#/datasets', 'the current route is preserved');
  assert.match(app.doc.getElementById('page-container').textContent, /Dataset Manager/);
  assert.doesNotMatch(app.doc.body.textContent, /Sign in required/i);
  app.dom.window.close();
});

test('TOKEN_REFRESHED keeps the page and the signed-in user', async () => {
  const app = bootApp();
  await startApp(app);
  await goTo(app.window, 'datasets');

  const cbs = app.window.__authStateCallbacks || [];
  cbs.forEach((cb) => cb('TOKEN_REFRESHED', { user: { id: 'user-1', email: 'tester@example.com' } }));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(app.window.location.hash, '#/datasets');
  assert.equal(app.window.state.getUser().id, 'user-1');
  app.dom.window.close();
});

test('reloading on the dataset page restores that page instead of the dashboard', async () => {
  const app = bootApp();
  // The previous page life stored the route before the browser reloaded
  // (Android can recreate the page after the file picker closes).
  app.window.sessionStorage.setItem('corpus:last-route', 'datasets');
  await startApp(app);

  assert.equal(app.window.location.hash, '#/datasets', 'the saved route is restored into the URL');
  assert.match(app.doc.getElementById('page-container').textContent, /Dataset Manager/);
  app.dom.window.close();
});
