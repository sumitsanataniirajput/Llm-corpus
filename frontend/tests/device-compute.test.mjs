/**
 * Device compute: real worker protocol, real detection, real task execution.
 *
 * The worker file is executed in a VM with a `self` shim, so what is asserted
 * here is the actual worker code, not a copy of it. The agent tests then run
 * the real modules against the harness' fake network.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createApp as createAppBase, tick } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'device-worker.js'), 'utf8');

const openApps = [];
function createApp(options) {
  const app = createAppBase(options);
  openApps.push(app);
  return app;
}
after(() => {
  while (openApps.length) {
    const app = openApps.pop();
    try {
      if (app.window.devices && typeof app.window.devices.dispose === 'function') app.window.devices.dispose();
      app.dom.window.close();
    } catch (e) { /* already closed */ }
  }
});

/** Run the real worker file in an isolated context and collect its messages. */
function runWorker(payload) {
  const messages = [];
  const context = {
    self: null,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
  };
  context.self = {
    onmessage: null,
    postMessage: (message) => messages.push(message),
  };
  vm.createContext(context);
  vm.runInContext(WORKER_SOURCE, context);
  context.self.onmessage({ data: payload });
  return messages;
}

// ---------------------------------------------------------------- the worker

test('the device worker tokenizes real text and reports progress', () => {
  const text = 'CORPUS ultimate, device compute! 123 tokens?\n'.repeat(200);
  // progressIntervalMs: 0 asks for one report per slice instead of the
  // production coalescing, so this asserts the slicing itself.
  const messages = runWorker({ type: 'tokenize', text, chunkChars: 1024, progressIntervalMs: 0, taskId: 'task_1' });

  const progress = messages.filter((m) => m.type === 'progress');
  assert.ok(progress.length >= 2, 'progress is reported while the shard is still being processed');
  assert.equal(progress[progress.length - 1].processedChars, text.length);
  assert.equal(progress[progress.length - 1].totalChars, text.length);

  const result = messages.find((m) => m.type === 'result');
  assert.ok(result, 'a result message is produced');
  assert.equal(result.taskId, 'task_1');
  assert.equal(result.characters, text.length);
  assert.ok(result.tokens > 0, 'tokens were actually counted');

  // The count is deterministic and matches an independent count of the same text.
  const expected = messages.filter((m) => m.type === 'progress').pop().tokens;
  assert.equal(result.tokens, expected);

  // Every word and every standalone punctuation mark is one token.
  const words = text.match(/[A-Za-z0-9]+/g).length;
  const punctuation = (text.match(/[,!?]/g) || []).length;
  assert.equal(result.tokens, words + punctuation);
});

test('the device worker measures its own throughput instead of inventing one', () => {
  const messages = runWorker({ type: 'benchmark', chars: 200000 });
  const result = messages.find((m) => m.type === 'benchmark');
  assert.ok(result);
  assert.ok(result.characters >= 200000);
  assert.ok(result.tokens > 0);
  assert.ok(result.elapsedMs >= 1);
  assert.ok(result.charactersPerSecond > 0);
  assert.equal(
    result.charactersPerSecond,
    Math.round(result.characters / (result.elapsedMs / 1000))
  );
});

test('an unknown worker request is reported, never silently ignored', () => {
  const messages = runWorker({ type: 'train-a-neural-network' });
  assert.equal(messages[0].type, 'error');
  assert.match(messages[0].message, /Unknown worker request/);
});

// ------------------------------------------------------------- the agent

test('capabilities say "Not available" for anything the browser does not expose', async () => {
  const app = createApp({});
  const w = app.window;
  // A minimal window: no deviceMemory, no WebGPU, no battery, no storage API.
  const bare = { navigator: { userAgent: 'test-agent' }, document: w.document, screen: { width: 1024, height: 768 } };
  const caps = await w.CORPUS_DEVICE_AGENT.detectCapabilities({ window: bare });

  assert.equal(caps.cpu_cores, null);
  assert.equal(caps.device_memory_gb, null);
  assert.equal(caps.webgpu.supported, false);
  assert.match(caps.webgpu.reason, /navigator\.gpu/);
  assert.equal(caps.battery, null);
  assert.equal(caps.native_bridge.available, false, 'a web page cannot assume a native bridge');
  assert.equal(w.CORPUS_DEVICE_AGENT.na(caps.device_memory_gb), 'Not available');
  assert.equal(caps.execution_method, 'cpu-worker', 'CPU workers are used when WebGPU is absent');
});

test('a device with no GPU is reported as CPU-worker execution and measured speed is real', async () => {
  const app = createApp({});
  const agent = app.window.CORPUS_DEVICE_AGENT;
  const caps = await agent.detectCapabilities();
  assert.equal(caps.webgpu.supported, false);
  assert.equal(caps.execution_method, 'cpu-worker');

  const measured = await agent.runBenchmark();
  assert.ok(measured, 'the benchmark returned a measurement');
  assert.ok(measured.tokens_per_second > 0);
  assert.ok(app.WorkerStub.instances.length >= 1, 'the measurement ran inside a Web Worker');
});

test('connecting registers the device and stores its id for reloads', async () => {
  const app = createApp({});
  const device = await app.window.CORPUS_DEVICE_AGENT.start({ autoStart: false, name: 'Test phone' });

  assert.equal(device.name, 'Test phone');
  assert.equal(device.status, 'online');
  assert.equal(app.window.localStorage.getItem('corpus.device.id'), device.id);

  const registerCall = app.net.deviceCalls.find((call) => call.route === '/api/v1/devices' && call.method === 'POST');
  assert.ok(registerCall, 'a registration request was sent');
  assert.equal(registerCall.body.capabilities.cpu_cores === undefined || typeof registerCall.body.capabilities.cpu_cores === 'number', true);
  assert.equal(registerCall.body.capabilities.wasm_simd !== undefined, true);
  // No credential ever leaves the browser in a capability payload.
  const serialised = JSON.stringify(registerCall.body);
  assert.doesNotMatch(serialised, /token|secret|service_role/i);
});

test('a preprocessing task tokenizes the real shard, reports progress and completes with a count', async () => {
  const app = createApp({ datasetText: 'alpha beta gamma delta.\n'.repeat(2000) });
  const agent = app.window.CORPUS_DEVICE_AGENT;
  const device = await agent.start({ autoStart: false, name: 'Shard worker' });

  // The backend assigned a shard of job job_1 to this device.
  const task = {
    id: 'task_9', device_id: device.id, job_id: 'job_1', kind: 'preprocess',
    status: 'assigned', progress_percent: 0, shard_index: 1, shard_count: 2,
    detail: { mode: 'collaborative-preprocess' },
  };
  app.net.jobs.push({ id: 'job_1', status: 'running', dataset_id: 'ds_1', model_id: 'model_1' });
  device.job = { id: 'job_1', dataset_id: 'ds_1', model_id: 'model_1' };
  device.task = task;
  app.net.deviceTasks.push(task);

  const events = [];
  agent.subscribe((event, payload) => events.push({ event, payload }));
  await agent.executeTask(task);

  const progressCalls = app.net.deviceCalls.filter((call) => /\/tasks\/task_9\/progress$/.test(call.route));
  assert.ok(progressCalls.length >= 1, 'real progress was reported to the backend');
  assert.ok(progressCalls.every((call) => call.body.progress_percent >= 0 && call.body.progress_percent <= 100));

  const completeCall = app.net.deviceCalls.find((call) => /\/tasks\/task_9\/complete$/.test(call.route));
  assert.ok(completeCall, 'the task was completed on the backend');
  assert.equal(completeCall.body.status, 'completed');
  assert.ok(completeCall.body.detail.token_count > 0, 'the token count comes from the worker');
  assert.match(completeCall.body.detail.shard_index.toString(), /^1$/);

  assert.ok(app.WorkerStub.instances.length >= 1, 'the work ran in a Web Worker, not on the UI thread');
  assert.ok(events.some((entry) => entry.event === 'task-complete'));
});

test('device-side training is reported as not executed instead of being faked', async () => {
  const app = createApp({});
  const agent = app.window.CORPUS_DEVICE_AGENT;
  await agent.start({ autoStart: false, name: 'Orchestrator' });
  const events = [];
  agent.subscribe((event, payload) => events.push({ event, payload }));

  await agent.executeTask({ id: 'task_train', kind: 'train', job_id: 'job_1', status: 'assigned' });

  const skipped = events.find((entry) => entry.event === 'task-skipped');
  assert.ok(skipped, 'the device says it did not train the model');
  assert.match(skipped.payload.reason, /backend worker/);
  const completed = app.net.deviceCalls.find((call) => /\/complete$/.test(call.route));
  assert.equal(completed, undefined, 'no completion is claimed for work the device did not do');
});

test('a device that is not allowed to work does not run tasks', async () => {
  const app = createApp({});
  const agent = app.window.CORPUS_DEVICE_AGENT;
  await agent.start({ autoStart: false, name: 'Disabled device' });
  agent.setSettings({ deviceProcessing: false });
  const events = [];
  agent.subscribe((event, payload) => events.push({ event, payload }));

  await agent.executeTask({ id: 'task_x', kind: 'preprocess', job_id: 'job_1', status: 'assigned' });
  const skipped = events.find((entry) => entry.event === 'task-skipped');
  assert.ok(skipped);
  assert.match(skipped.payload.reason, /turned off/);
});

test('a device that fails mid-shard reports the real error to the backend', async () => {
  // An empty stored file is a real failure the device can hit.
  const app = createApp({ datasetText: '' });
  const agent = app.window.CORPUS_DEVICE_AGENT;
  const device = await agent.start({ autoStart: false, name: 'Broken shard worker' });
  // The dataset cannot be read: the API answers 404.
  const task = { id: 'task_bad', device_id: device.id, job_id: 'job_empty', kind: 'preprocess', status: 'assigned', shard_index: 0, shard_count: 1 };
  device.job = { id: 'job_empty', dataset_id: 'ds_empty' };
  app.net.deviceTasks.push(task);

  await agent.executeTask(task);

  const completeCall = app.net.deviceCalls.find((call) => /\/tasks\/task_bad\/complete$/.test(call.route));
  assert.ok(completeCall, 'the failure was reported');
  assert.equal(completeCall.body.status, 'failed');
  assert.ok(completeCall.body.detail.error.length > 0, 'the failure carries the real message');
});

// ------------------------------------------------------- the device pages

test('the Device Compute page renders detected values and marks unknown ones', async () => {
  const app = createApp({});
  await app.window.devices.render();
  await tick(2);

  const root = app.doc.getElementById('device-compute-root');
  assert.ok(root, 'the page rendered');
  assert.match(root.textContent, /This device/);
  assert.match(root.textContent, /Not connected/, 'no invented connection state before registering');
  assert.match(app.doc.getElementById('device-capability-panel').textContent, /Not available/);
  assert.match(app.doc.getElementById('device-controls-panel').textContent, /Device processing/);
  // The page never claims device-side training.
  assert.match(root.textContent, /runs in the backend worker/);
});

test('connecting from the page registers the device and shows the live status', async () => {
  const app = createApp({});
  await app.window.devices.render();
  await tick(2);

  const button = app.doc.getElementById('device-connect');
  await app.window.devices.connectThisDevice(button);
  await tick(3);

  const statusPanel = app.doc.getElementById('device-status-panel');
  assert.match(statusPanel.textContent, /Connected/);
  assert.match(statusPanel.textContent, /CPU via Web Worker/);
  assert.match(statusPanel.textContent, /Worker status/);
  assert.equal(app.net.devices.length, 1);
});

test('measured speed from the device is shown as a measured number', async () => {
  const app = createApp({});
  await app.window.devices.render();
  await tick(2);
  const button = app.doc.getElementById('device-measure');
  await app.window.devices.measureThisDevice(button);
  await tick(3);

  const panel = app.doc.getElementById('device-capability-panel').textContent;
  assert.match(panel, /Measured tokenizer speed/);
  assert.match(panel, /tokens\/s/);
});
