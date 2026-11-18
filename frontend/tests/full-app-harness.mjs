/**
 * Whole-application harness for performance probes.
 *
 * Unlike frontend/tests/harness.mjs (which loads a hand-picked module list and
 * stubs CORPUS_APP/router), this loads every local script index.html loads, in
 * document order, and then drives the REAL router with the REAL page modules —
 * the same surface a user touches.
 *
 * The network is simulated so latency and payload size can be dialled up:
 * "a cold Render backend that takes 1.2 s per request and returns 400 datasets"
 * is exactly the case where the UI used to freeze, and it is reproducible here.
 *
 * Instrumentation collected per boot:
 *   calls[]            every API request (method, route, at)
 *   pendingTimers      setTimeout ids still armed
 *   pendingIntervals   setInterval ids still armed
 *   sockets            WebSocket instances created
 *   listeners          window/document listeners added
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');

export function localScripts() {
  const scripts = [];
  const re = /<script\s+src="(js\/[^"]+)"/g;
  let match;
  while ((match = re.exec(INDEX_HTML)) !== null) scripts.push(match[1].split('?')[0]);
  return scripts;
}

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

export function makeDatasets(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: 'ds_' + i,
      owner_id: 'user-1',
      name: 'Corpus ' + i,
      format: 'txt',
      size: 1024 + i,
      file_size: 1024 + i,
      file_name: 'corpus-' + i + '.txt',
      storage_path: 'user-1/datasets/ds_' + i + '/f.txt',
      uploaded_at: new Date(Date.now() - i * 60_000).toISOString(),
      status: i % 7 === 0 ? 'pending' : 'uploaded',
      has_file: i % 7 !== 0,
      trainable: i % 7 !== 0,
      token_count: 100 + i,
      created_at: new Date(Date.now() - i * 120_000).toISOString(),
    });
  }
  return out;
}

export function makeModels(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: 'model_' + i,
      owner_id: 'user-1',
      name: 'Model ' + i,
      status: i % 5 === 0 ? 'training' : 'idle',
      config: { d_model: 64, n_layers: 2, n_heads: 4, d_ff: 128, vocab_size: 512, context_length: 64 },
      created_at: new Date(Date.now() - i * 60_000).toISOString(),
      updated_at: new Date(Date.now() - i * 30_000).toISOString(),
    });
  }
  return out;
}

export function makeJobs(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: 'job_' + i,
      owner_id: 'user-1',
      model_id: 'model_0',
      dataset_id: 'ds_0',
      status: i % 4 === 0 ? 'running' : 'completed',
      engine: 'corpus',
      compute: 'cpu',
      progress: i % 4 === 0 ? 40 : 100,
      created_at: new Date(Date.now() - i * 60_000).toISOString(),
      updated_at: new Date(Date.now() - i * 30_000).toISOString(),
    });
  }
  return out;
}

/**
 * @param {object} options
 * @param {number} options.latencyMs    simulated per-request latency (default 0)
 * @param {number} options.datasets     number of datasets the API returns
 * @param {number} options.models       number of models the API returns
 * @param {number} options.jobs         number of training jobs the API returns
 * @param {string} options.hash         initial route
 */
export function bootFullApp(options = {}) {
  const {
    latencyMs = 0,
    datasets = 2,
    models = 2,
    jobs = 0,
    hash = '#/dashboard',
  } = options;

  const dom = new JSDOM(INDEX_HTML.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/' + hash,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  window.indexedDB = fakeIndexedDB();
  window.Chart = class {
    constructor(ctx, config) { this.config = config; this.data = config && config.data; this.updates = 0; }
    update() { this.updates += 1; }
    destroy() {}
  };
  window.Swal = { fire: () => {} };
  window.AOS = { init() {}, refresh() {} };
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(payload) { this.sent.push(payload); }
    close() { this.readyState = 3; }
  };
  window.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; }
    open() {} setRequestHeader() {} getResponseHeader() { return 'application/json'; }
    send() { this.status = 200; this.responseText = '{}'; if (this.onload) this.onload(); }
  };
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }) };
  };
  window.scrollTo = () => {};

  // --- instrumentation -----------------------------------------------------
  const calls = [];
  const sockets = [];
  const pendingTimers = new Set();
  const pendingIntervals = new Set();
  const listeners = { window: 0, document: 0 };

  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);

  window.setTimeout = function trackedSetTimeout(fn, ms, ...rest) {
    let id;
    const wrapped = (...args) => { pendingTimers.delete(id); if (typeof fn === 'function') fn(...args); };
    id = realSetTimeout(wrapped, ms, ...rest);
    pendingTimers.add(id);
    return id;
  };
  window.clearTimeout = function trackedClearTimeout(id) { pendingTimers.delete(id); return realClearTimeout(id); };
  window.setInterval = function trackedSetInterval(fn, ms, ...rest) {
    const id = realSetInterval(fn, ms, ...rest);
    pendingIntervals.add(id);
    return id;
  };
  window.clearInterval = function trackedClearInterval(id) { pendingIntervals.delete(id); return realClearInterval(id); };
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);

  const origWindowAdd = window.addEventListener.bind(window);
  window.addEventListener = function countedWindowAdd(type, handler, opts) {
    listeners.window += 1;
    return origWindowAdd(type, handler, opts);
  };
  const origDocAdd = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = function countedDocAdd(type, handler, opts) {
    listeners.document += 1;
    return origDocAdd(type, handler, opts);
  };

  const health = { status: 'ok' };
  const dataModel = makeModels(models);
  const dataDatasets = makeDatasets(datasets);
  const dataJobs = makeJobs(jobs);

  function respond(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const route = new URL(url, 'http://localhost').pathname.replace(/\/$/, '') || '/';
    calls.push({ method, route, at: Date.now() });
    if (route === '/api/v1/datasets' && method === 'GET') return jsonResponse([...dataDatasets]);
    if (route === '/api/v1/models' && method === 'GET') return jsonResponse([...dataModel]);
    if (route === '/api/v1/training' && method === 'GET') return jsonResponse([...dataJobs]);
    if (route === '/api/v1/training/checkpoints' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/health') return jsonResponse(health);
    if (route === '/api/v1/evaluation' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/experiments' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/compute/workers' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/storage/objects' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/settings/api-keys' && method === 'GET') return jsonResponse([]);
    if (route === '/api/v1/settings' && method === 'GET') return jsonResponse({ theme: 'dark' });
    if (/^\/api\/v1\/training\/[^/]+\/metrics$/.test(route)) return jsonResponse([]);
    if (/^\/api\/v1\/training\/[^/]+\/logs$/.test(route)) return jsonResponse([]);
    if (route === '/api/v1/datasets' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const created = { id: 'ds_new', name: body.name, format: body.format, status: 'pending', has_file: false };
      return jsonResponse(created);
    }
    if (route === '/api/v1/models' && method === 'POST') {
      return jsonResponse({ id: 'model_new', name: 'New', status: 'idle', config: {} });
    }
    return jsonResponse({ detail: 'not found: ' + route }, 404);
  }

  window.fetch = (url, opts = {}) => {
    const payload = respond(url, opts);
    if (!latencyMs) return Promise.resolve(payload);
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      const timer = realSetTimeout(() => resolve(payload), latencyMs);
      if (signal) {
        if (signal.aborted) { realClearTimeout(timer); resolve(jsonResponse({ detail: 'aborted' }, 499)); return; }
        signal.addEventListener('abort', () => {
          realClearTimeout(timer);
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  for (const rel of localScripts()) {
    const code = fs.readFileSync(path.join(FRONTEND_DIR, rel), 'utf8');
    window.eval(code);
  }

  window.CORPUS_SUPABASE = {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1' } } } }),
    init() {},
    signIn: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1' } } }, error: null }),
    signOut: async () => ({}),
    onAuthStateChange() { return { unsubscribe() {} }; },
  };

  window.CORPUS_APP.setPageContainer(window.document.getElementById('page-container'));
  window.state.setUser({ id: 'user-1', email: 'tester@example.com' });
  window.state.setAuthReady(true);

  return {
    dom,
    window,
    doc: window.document,
    calls,
    sockets,
    pendingTimers,
    pendingIntervals,
    listeners,
    container: window.document.getElementById('page-container'),
    close() { dom.window.close(); },
  };
}

/** Wait for a predicate to hold, polling every macrotask, up to timeoutMs. */
export async function waitFor(predicate, { timeoutMs = 4000, stepMs = 5 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return -1;
}
