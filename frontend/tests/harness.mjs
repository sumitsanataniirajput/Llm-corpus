/**
 * CORPUS ULTIMATE — frontend test harness.
 *
 * Loads the REAL frontend modules (config, utils, api, state, components,
 * charts, training, datasets) into a jsdom document and replaces only the
 * network boundary (`fetch`, `WebSocket`, Chart.js) with recording stubs.
 *
 * Usage:
 *   npm install --prefix /tmp/fe jsdom
 *   NODE_PATH=/tmp/fe/node_modules node --test frontend/tests/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');

const MODULES = [
  'js/config.js',
  'js/utils.js',
  'js/state.js',
  'js/api.js',
  'js/components.js',
  'js/charts.js',
  'js/training.js',
  'js/datasets.js',
];

class ChartStub {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.data = config.data;
    this.options = config.options;
    this.updated = 0;
    ChartStub.instances.set(config.__id || this.data?.datasets?.[0]?.label, this);
  }
  update() { this.updated += 1; }
  destroy() { this.destroyed = true; }
}
ChartStub.instances = new Map();

class WebSocketStub {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    WebSocketStub.opened.push(this);
  }
  send(payload) { this.sent.push(payload); }
  close() { this.readyState = 3; this.closed = true; }
}
WebSocketStub.opened = [];

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

/**
 * Create a booted application context.
 *
 * @param {object} options
 * @param {Array} options.datasets   datasets returned by GET /api/v1/datasets/
 * @param {Array} options.models     models returned by GET /api/v1/models/
 * @param {Array} options.jobs       jobs returned by GET /api/v1/training/
 */
export function createApp(options = {}) {
  return createAppFromFiles(options);
}

function createAppFromFiles(options) {
  const indexPath = path.join(FRONTEND_DIR, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/#/training',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  window.Chart = ChartStub;
  window.WebSocket = WebSocketStub;
  window.AOS = { refresh() {}, init() {} };
  window.Swal = { fire: (opts) => { window.__lastSwal = opts; } };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  // Canvas is not available in jsdom; Chart.js is replaced by ChartStub below.
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }) };
  };

  // --- network stub ------------------------------------------------------
  const state = {
    datasets: options.datasets ? [...options.datasets] : [],
    models: options.models ? [...options.models] : [],
    jobs: options.jobs ? [...options.jobs] : [],
    calls: [],
    createJobResponses: [],
    preview: options.preview || {
      preview: 'first line of the corpus\nsecond line',
      file_name: 'corpus.txt',
      file_size: 1024,
      total_characters: 35,
      total_lines: 2,
      truncated: false,
    },
  };

  async function fetchStub(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    // The API client omits trailing slashes on collection routes; normalise.
    const route = parsed.pathname.replace(/\/$/, '') || '/';
    state.calls.push({ method, route, body: opts.body ? JSON.parse(opts.body) : null, url });

    if (route === '/api/v1/datasets' && method === 'GET') {
      return jsonResponse([...state.datasets]);
    }
    if (route === '/api/v1/models' && method === 'GET') {
      return jsonResponse([...state.models]);
    }
    if (route === '/api/v1/training' && method === 'GET') {
      return jsonResponse([...state.jobs]);
    }
    if (route === '/api/v1/training' && method === 'POST') {
      const body = JSON.parse(opts.body);
      const job = {
        id: 'job_created01',
        owner_id: 'user-1',
        model_id: body.model_id,
        dataset_id: body.dataset_id,
        status: 'queued',
        engine: body.engine,
        compute: body.compute,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.jobs.unshift(job);
      state.createJobResponses.push(body);
      return jsonResponse(job);
    }
    if (/^\/api\/v1\/training\/[^/]+$/.test(route) && method === 'GET') {
      const id = route.split('/').pop();
      const job = state.jobs.find((j) => j.id === id) || { id, status: 'queued' };
      return jsonResponse(job);
    }
    if (/^\/api\/v1\/training\/[^/]+\/metrics$/.test(route)) {
      return jsonResponse(state.metrics || []);
    }
    if (/^\/api\/v1\/datasets\/[^/]+\/preview$/.test(route)) {
      return jsonResponse(state.preview);
    }
    return jsonResponse({ detail: 'not found: ' + route }, 404);
  }

  window.fetch = fetchStub;
  window.AbortController = globalThis.AbortController;
  window.CORPUS_APP = {
    getPageContainer: () => window.document.getElementById('page-container'),
    requirePageContainer: () => window.document.getElementById('page-container'),
    logDiagnostic() {},
    recordError() {},
  };
  window.CORPUS_SUPABASE = {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1' } } } }),
  };

  // --- load real modules -------------------------------------------------
  for (const rel of MODULES) {
    const code = fs.readFileSync(path.join(FRONTEND_DIR, rel), 'utf8');
    window.eval(code);
  }

  window.router = { navigate: (route) => { state.navigatedTo = route; } };
  window.state.setUser({ id: 'user-1', email: 'tester@example.com' });
  window.state.setAuthReady(true);

  return { dom, window, doc: window.document, net: state, ChartStub, WebSocketStub };
}

export function datasetFixtures() {
  return {
    models: [
      { id: 'model_1', name: 'Corpus Small', status: 'idle', config: { d_model: 64, n_layers: 2, n_heads: 4, d_ff: 128, vocab_size: 512, context_length: 64 } },
      { id: 'model_2', name: 'Corpus Large', status: 'idle', config: { d_model: 128, n_layers: 4, n_heads: 4, d_ff: 256, vocab_size: 1024, context_length: 128 } },
    ],
    datasets: [
      {
        id: 'ds_uploaded',
        owner_id: 'user-1',
        name: 'Wiki corpus',
        format: 'txt',
        size: 2048,
        file_size: 2048,
        file_name: 'wiki.txt',
        storage_path: 'user-1/datasets/ds_uploaded/abc_wiki.txt',
        uploaded_at: new Date(Date.now() - 3600_000).toISOString(),
        status: 'uploaded',
        has_file: true,
        trainable: true,
        token_count: 512,
        created_at: new Date(Date.now() - 7200_000).toISOString(),
      },
      {
        id: 'ds_pending',
        owner_id: 'user-1',
        name: 'Book draft',
        format: 'txt',
        size: 0,
        file_size: null,
        file_name: null,
        storage_path: null,
        uploaded_at: null,
        status: 'pending',
        has_file: false,
        trainable: false,
        token_count: 0,
        created_at: new Date().toISOString(),
      },
    ],
    jobs: [],
  };
}

/** Await pending microtasks/timers. */
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
