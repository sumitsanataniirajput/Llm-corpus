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
  'js/actions.js',
  'js/charts.js',
  'js/dashboard.js',
  'js/models.js',
  'js/training.js',
  'js/datasets.js',
  'js/device-agent.js',
  'js/devices.js',
  'js/teachers.js',
  'js/teacher-selection.js',
  'js/distillation.js',
  'js/students.js',
  'js/intelligence.js',
  'js/budgets.js',
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

/**
 * Worker stub used by the device agent in tests.
 *
 * It speaks the real worker protocol (progress/result/benchmark messages) and
 * counts tokens with a deliberately simple split, so the agent's streaming,
 * progress reporting and completion logic run exactly as in production.
 */
class WorkerStub {
  constructor(url) {
    this.url = url;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    WorkerStub.instances.push(this);
  }
  postMessage(payload) {
    this.posted.push(payload);
    const respond = (message) => {
      if (this.terminated) return;
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: message });
      }, 0);
    };
    if (payload.type === 'tokenize') {
      const tokens = String(payload.text || '').split(/\s+/).filter(Boolean).length;
      respond({
        type: 'progress', processedChars: String(payload.text || '').length,
        totalChars: String(payload.text || '').length, tokens, elapsedMs: 1,
      });
      respond({ type: 'result', tokens, characters: String(payload.text || '').length, elapsedMs: 1, charactersPerSecond: 1000 });
    } else if (payload.type === 'benchmark') {
      respond({ type: 'benchmark', characters: 300000, tokens: 60000, elapsedMs: 100, charactersPerSecond: 3000000, tokensPerSecond: 600000 });
    }
  }
  terminate() { this.terminated = true; }
}
WorkerStub.instances = [];

class XHRStub {
  constructor() {
    this.upload = { onprogress: null };
    this.status = 0;
    this.responseText = '';
    this.headers = {};
    this.sent = [];
    XHRStub.instances.push(this);
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getResponseHeader(name) { return name.toLowerCase() === 'content-type' ? 'application/json' : null; }
  send(body) {
    this.sent.push(body);
    if (XHRStub.nextResponder) {
      const fn = XHRStub.nextResponder;
      XHRStub.nextResponder = null;
      fn(this, body);
      return;
    }
    const total = body && body.__size ? body.__size : 1000;
    if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: total, total });
    this.status = 200;
    this.responseText = JSON.stringify({ ok: true, dataset: { id: 'uploaded_' + XHRStub.instances.length } });
    if (this.onload) this.onload();
  }
}
XHRStub.instances = [];
XHRStub.nextResponder = null;

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
  XHRStub.instances = [];
  XHRStub.nextResponder = null;

  window.Chart = ChartStub;
  WorkerStub.instances = [];
  window.CORPUS_WORKER_FACTORY = (url) => new WorkerStub(url);
  window.WebSocket = WebSocketStub;
  window.XMLHttpRequest = XHRStub;
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
    metrics: options.metrics ? [...options.metrics] : [],
    devices: options.devices ? [...options.devices] : [],
    deviceTasks: options.deviceTasks ? [...options.deviceTasks] : [],
    datasetText: 'datasetText' in options ? String(options.datasetText) : 'device corpus shard text\n'.repeat(40),
    deleteJobHandler: options.deleteJobHandler || null,
    jobLogs: options.jobLogs || [],
    deviceCalls: [],
    checkpoints: options.checkpoints ? [...options.checkpoints] : [],
    health: options.health === undefined ? { status: 'ok' } : options.health,
    // Extra routes let a test describe endpoints the legacy fixtures never
    // needed (teacher network, distillation, student studio, telemetry) without
    // growing this file's if-chain. Each entry: {method, match, respond}.
    extraRoutes: Array.isArray(options.extraRoutes) ? [...options.extraRoutes] : [],
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
    state.calls.push({
      method,
      route,
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null,
      url,
    });

    for (const entry of state.extraRoutes) {
      if (entry.method && entry.method !== method) continue;
      const matched = entry.match instanceof RegExp ? entry.match.test(route) : entry.match === route;
      if (!matched) continue;
      const result = await entry.respond({
        route,
        method,
        url,
        body: opts.body ? JSON.parse(opts.body) : null,
        searchParams: parsed.searchParams,
        state,
      });
      if (result !== undefined) return result;
    }

    if (route === '/api/v1/datasets' && method === 'GET') {
      return jsonResponse([...state.datasets]);
    }
    if (route === '/api/v1/models' && method === 'GET') {
      return jsonResponse([...state.models]);
    }
    if (route === '/api/v1/training' && method === 'GET') {
      return jsonResponse([...state.jobs]);
    }
    if (route === '/api/v1/training/checkpoints' && method === 'GET') {
      return jsonResponse([...state.checkpoints]);
    }
    if (route === '/api/v1/health') {
      if (state.health === null) {
        const err = new Error('Failed to fetch');
        err.networkError = true;
        throw err;
      }
      return jsonResponse(state.health);
    }
    if (route === '/api/v1/models' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const config = body.config || body;
      const created = {
        id: 'model_created_' + (state.models.length + 1),
        name: config.name || body.name || 'New model',
        version: '1',
        status: 'idle',
        config,
      };
      state.models.push(created);
      return jsonResponse({ model: created }, 201);
    }
    if (route === '/api/v1/datasets' && method === 'POST') {
      const body = JSON.parse(opts.body);
      const created = {
        id: 'ds_created_' + (state.datasets.length + 1),
        name: body.name,
        format: body.format,
        size: body.size,
        status: 'pending',
        has_file: false,
        file_name: null,
      };
      state.datasets.push(created);
      return jsonResponse(created);
    }
    if (/^\/api\/v1\/models\/[^/]+$/.test(route) && method === 'DELETE') {
      const id = route.split('/').pop();
      const stopActive = parsed.searchParams.get('stop_active') === 'true';
      if (state.deleteModelHandler) {
        return state.deleteModelHandler({ id, stopActive, state, jsonResponse });
      }
      const idx = state.models.findIndex((m) => m.id === id);
      if (idx === -1) return jsonResponse({ detail: 'Model not found' }, 404);
      state.models.splice(idx, 1);
      return jsonResponse({ ok: true, model_id: id, removed_files: 0 });
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
    if (/^\/api\/v1\/training\/[^/]+\/logs$/.test(route)) {
      return jsonResponse(state.jobLogs || []);
    }
    if (/^\/api\/v1\/datasets\/[^/]+\/preview$/.test(route)) {
      return jsonResponse(state.preview);
    }
    if (route === '/api/v1/datasets/x/text' || /^\/api\/v1\/datasets\/[^/]+\/text$/.test(route)) {
      const text = String(state.datasetText);
      const offset = Number(parsed.searchParams.get('offset') || 0);
      const limit = Number(parsed.searchParams.get('limit') || 200000);
      const chunk = text.slice(offset, offset + limit);
      const next = offset + chunk.length;
      return jsonResponse({
        dataset_id: route.split('/')[5],
        file_name: 'corpus.txt',
        offset,
        limit,
        total_characters: text.length,
        returned_characters: chunk.length,
        next_offset: next < text.length ? next : null,
        complete: next >= text.length,
        text: chunk,
      });
    }

    // ---------- devices ----------
    state.deviceCalls.push({ method, route, body: opts.body ? JSON.parse(opts.body) : null });
    if (route === '/api/v1/devices' && method === 'GET') {
      return jsonResponse({ devices: [...state.devices], sweep: { devices_offline: 0, tasks_expired: 0 }, heartbeat_timeout_seconds: 75 });
    }
    if (route === '/api/v1/devices' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const created = {
        id: 'dev_' + (state.devices.length + 1),
        name: body.name,
        device_type: body.device_type,
        platform: body.platform,
        capabilities: body.capabilities || {},
        status: 'online',
        online: true,
        last_heartbeat: new Date().toISOString(),
        heartbeat_age_seconds: 1,
        task: null,
        job: null,
      };
      state.devices.push(created);
      return jsonResponse(created);
    }
    if (/^\/api\/v1\/devices\/[^/]+\/heartbeat$/.test(route) && method === 'POST') {
      const id = route.split('/')[4];
      const device = state.devices.find((d) => d.id === id);
      if (!device) return jsonResponse({ detail: 'Device not found' }, 404);
      const body = JSON.parse(opts.body || '{}');
      device.last_heartbeat = new Date().toISOString();
      device.heartbeat_age_seconds = 0;
      if (body.capabilities) device.capabilities = body.capabilities;
      if (body.status) device.status = body.status;
      const task = state.deviceTasks.find((t) => t.device_id === id && ['assigned', 'running'].includes(t.status));
      device.task = task || null;
      if (task && body.task_id === task.id && body.progress_percent != null) {
        task.progress_percent = body.progress_percent;
        task.status = 'running';
      }
      return jsonResponse(device);
    }
    if (/^\/api\/v1\/devices\/[^/]+$/.test(route) && method === 'PATCH') {
      const id = route.split('/').pop();
      const device = state.devices.find((d) => d.id === id);
      if (!device) return jsonResponse({ detail: 'Device not found' }, 404);
      const body = JSON.parse(opts.body || '{}');
      if (body.status) device.status = body.status;
      if (body.name) device.name = body.name;
      if (body.status === 'paused') {
        state.deviceTasks.forEach((t) => { if (t.device_id === id && ['assigned', 'running'].includes(t.status)) t.status = 'expired'; });
        device.task = null;
      }
      return jsonResponse(device);
    }
    if (/^\/api\/v1\/devices\/[^/]+\/disconnect$/.test(route) && method === 'POST') {
      const id = route.split('/')[4];
      const device = state.devices.find((d) => d.id === id);
      if (!device) return jsonResponse({ detail: 'Device not found' }, 404);
      device.status = 'offline';
      device.online = false;
      const released = [];
      state.deviceTasks.forEach((t) => {
        if (t.device_id === id && ['assigned', 'running'].includes(t.status)) { t.status = 'expired'; released.push(t.id); }
      });
      device.task = null;
      return jsonResponse({ ok: true, device_id: id, status: 'offline', released_tasks: released });
    }
    if (/^\/api\/v1\/devices\/[^/]+$/.test(route) && method === 'DELETE') {
      const id = route.split('/').pop();
      const index = state.devices.findIndex((d) => d.id === id);
      if (index === -1) return jsonResponse({ detail: 'Device not found' }, 404);
      state.devices.splice(index, 1);
      state.deviceTasks = state.deviceTasks.filter((t) => t.device_id !== id);
      return jsonResponse({ ok: true, device_id: id, removed: true });
    }
    if (/^\/api\/v1\/devices\/[^/]+\/assign$/.test(route) && method === 'POST') {
      const id = route.split('/')[4];
      const body = JSON.parse(opts.body || '{}');
      if (!state.devices.find((d) => d.id === id)) return jsonResponse({ detail: 'Device not found' }, 404);
      const job = state.jobs.find((j) => j.id === body.job_id);
      if (!job) return jsonResponse({ detail: 'Training job not found' }, 404);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        return jsonResponse({ detail: 'Job is already ' + job.status + '; nothing to assign.' }, 409);
      }
      const task = {
        id: 'task_' + state.deviceTasks.length + 1,
        device_id: id,
        job_id: job.id,
        kind: body.kind || 'train',
        status: 'assigned',
        progress_percent: 0,
        shard_index: 0,
        shard_count: null,
        lease_expires_at: new Date(Date.now() + 90000).toISOString(),
        detail: { mode: body.kind === 'preprocess' ? 'collaborative-preprocess' : 'parallel' },
      };
      state.deviceTasks.push(task);
      return jsonResponse({ ok: true, task, job: { id: job.id, status: job.status, dataset_id: job.dataset_id, model_id: job.model_id } });
    }
    if (route === '/api/v1/devices/auto-assign' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const assignments = (body.job_ids || []).map((jobId, index) => ({
        job_id: jobId,
        assigned: index < state.devices.length,
        device_id: (state.devices[index] || {}).id || null,
        reason: index < state.devices.length ? null : 'no device available',
      }));
      return jsonResponse({ assignments });
    }
    if (route === '/api/v1/devices/plan/collaborative' && method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const job = state.jobs.find((j) => j.id === body.job_id);
      if (!job) return jsonResponse({ detail: 'Training job not found' }, 404);
      const devices = state.devices.filter((d) => !body.device_ids || body.device_ids.includes(d.id));
      const tasks = devices.map((device, index) => {
        const task = {
          id: 'ptask_' + index,
          device_id: device.id,
          job_id: job.id,
          kind: 'preprocess',
          status: 'assigned',
          progress_percent: 0,
          shard_index: index,
          shard_count: devices.length,
          detail: { mode: 'collaborative-preprocess' },
        };
        state.deviceTasks.push(task);
        return task;
      });
      return jsonResponse({
        ok: true,
        mode: 'collaborative-preprocess',
        shard_count: devices.length,
        tasks,
        synchronisation: 'Gradient synchronisation is not implemented by this backend.',
      });
    }
    if (/^\/api\/v1\/devices\/[^/]+\/tasks\/[^/]+\/progress$/.test(route) && method === 'POST') {
      const parts = route.split('/');
      const taskId = parts[6];
      const task = state.deviceTasks.find((t) => t.id === taskId);
      if (!task) return jsonResponse({ detail: 'Task not found' }, 404);
      const body = JSON.parse(opts.body || '{}');
      task.progress_percent = body.progress_percent;
      task.status = 'running';
      task.lease_expires_at = new Date(Date.now() + 90000).toISOString();
      return jsonResponse({ ok: true, task });
    }
    if (/^\/api\/v1\/devices\/[^/]+\/tasks\/[^/]+\/complete$/.test(route) && method === 'POST') {
      const parts = route.split('/');
      const taskId = parts[6];
      const task = state.deviceTasks.find((t) => t.id === taskId);
      if (!task) return jsonResponse({ detail: 'Task not found' }, 404);
      const body = JSON.parse(opts.body || '{}');
      task.status = body.status === 'failed' ? 'failed' : 'completed';
      task.progress_percent = task.status === 'completed' ? 100 : task.progress_percent;
      task.detail = { ...task.detail, result: body.detail || {} };
      task.lease_expires_at = null;
      return jsonResponse({ ok: true, task, aggregate: null });
    }
    if (/^\/api\/v1\/devices\/jobs\/[^/]+\/tasks$/.test(route) && method === 'GET') {
      const jobId = route.split('/')[5];
      const tasks = state.deviceTasks.filter((t) => t.job_id === jobId).map((t) => {
        const device = state.devices.find((d) => d.id === t.device_id);
        return { ...t, device_name: device ? device.name : null };
      });
      return jsonResponse({ job: { id: jobId }, tasks });
    }

    if (/^\/api\/v1\/training\/[^/]+$/.test(route) && method === 'DELETE') {
      const id = route.split('/').pop();
      if (state.deleteJobHandler) {
        return state.deleteJobHandler({ id, state, jsonResponse, hard: parsed.searchParams.get('hard') === 'true' });
      }
      const index = state.jobs.findIndex((j) => j.id === id);
      if (index === -1) return jsonResponse({ detail: 'Job not found' }, 404);
      state.jobs.splice(index, 1);
      return jsonResponse({ ok: true, job_id: id, deleted: 'soft' });
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

  return { dom, window, doc: window.document, net: state, ChartStub, WebSocketStub, XHRStub, WorkerStub };
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
