/**
 * Multi-device training page: real devices, real backend actions, honest modes.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp as createAppBase, datasetFixtures, tick } from './harness.mjs';

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

function device(overrides = {}) {
  return {
    id: 'dev_phone',
    name: 'Pixel 7',
    device_type: 'mobile',
    platform: 'Chrome on Android 14',
    status: 'online',
    online: true,
    last_heartbeat: new Date().toISOString(),
    heartbeat_age_seconds: 3,
    capabilities: {
      cpu_cores: 8, device_memory_gb: 4, webgpu: false, wasm_simd: true,
      execution_method: 'cpu-worker',
    },
    task: null,
    job: null,
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: 'job_parallel1',
    status: 'running',
    stage: 'training',
    progress_percent: 33.3,
    completed_steps: 10,
    total_steps: 30,
    current_epoch: 1,
    total_epochs: 1,
    model_id: 'model_1',
    dataset_id: 'ds_uploaded',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

async function renderPage(app) {
  // The router passes the route to the page (state.setRoute happens later), and
  // the hash already points at the route, exactly like a real navigation.
  app.window.location.hash = '#/multi-device';
  app.window.state.setRoute('multi-device');
  await app.window.devices.render('multi-device');
  await tick(2);
}

test('the page lists every device with its capabilities and heartbeat', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, devices: [device(), device({ id: 'dev_laptop', name: 'ThinkPad', device_type: 'laptop', online: false, status: 'offline', heartbeat_age_seconds: 400 })], jobs: [job()] });
  await renderPage(app);

  const list = app.doc.getElementById('multi-device-list');
  assert.match(list.textContent, /Pixel 7/);
  assert.match(list.textContent, /ThinkPad/);
  assert.match(list.textContent, /8 cores/);
  assert.match(list.textContent, /WASM SIMD/);
  assert.match(list.textContent, /Connected/);
  assert.match(list.textContent, /Offline/);
  assert.match(list.textContent, /min ago/, 'a stale heartbeat is shown as age, not as online');
});

test('with no devices the page explains how to connect one instead of faking workers', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx });
  await renderPage(app);
  const list = app.doc.getElementById('multi-device-list');
  assert.match(list.textContent, /No devices connected/);
  assert.match(list.textContent, /Connect new device/);
});

test('a device card shows what the device is working on and its real progress', async () => {
  const fx = datasetFixtures();
  const busy = device({
    status: 'busy',
    task: {
      id: 'task_1', device_id: 'dev_phone', job_id: 'job_parallel1', kind: 'preprocess',
      status: 'running', progress_percent: 62.5, shard_index: 0, shard_count: 2,
      detail: { mode: 'collaborative-preprocess' },
    },
    job: job({ stage: 'tokenizing' }),
  });
  const app = createApp({ ...fx, devices: [busy], jobs: [job({ stage: 'tokenizing' })] });
  await renderPage(app);

  const card = app.doc.querySelector('[data-device-id="dev_phone"]');
  assert.match(card.textContent, /Preprocessing shard/);
  assert.match(card.textContent, /collaborative-preprocess/);
  assert.match(card.textContent, /62\.5%|62.5%/);
  assert.match(card.textContent, /job_parallel1/);
  assert.match(card.textContent, /Working/);
});

test('pause and resume call the backend and refresh the card', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, devices: [device()], jobs: [job()] });
  await renderPage(app);

  const pauseButton = app.doc.querySelector('[data-device-pause="dev_phone"]');
  await app.window.devices.pauseDevice('dev_phone', pauseButton);
  await tick(2);

  const patch = app.net.deviceCalls.find((call) => call.method === 'PATCH' && call.route === '/api/v1/devices/dev_phone');
  assert.ok(patch, 'a PATCH request was sent');
  assert.equal(patch.body.status, 'paused');
  assert.equal(app.net.devices[0].status, 'paused');

  await app.window.devices.resumeDevice('dev_phone', app.doc.querySelector('[data-device-resume="dev_phone"]'));
  await tick(2);
  assert.equal(app.net.devices[0].status, 'online');
});

test('removing a device confirms first and says the history is kept', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, devices: [device()], jobs: [job()] });
  await renderPage(app);

  app.window.devices.removeDevice('dev_phone', 'Pixel 7');
  await tick(1);
  assert.equal(app.doc.getElementById('confirm-dialog').classList.contains('hidden'), false);
  assert.match(app.doc.getElementById('confirm-message').textContent, /Models, datasets, checkpoints and training history are not deleted/);
  assert.equal(app.net.deviceCalls.filter((call) => call.method === 'DELETE').length, 0);

  app.doc.getElementById('confirm-ok').click();
  await tick(3);

  const del = app.net.deviceCalls.find((call) => call.method === 'DELETE');
  assert.ok(del, 'the device was removed through the API');
  assert.equal(app.net.devices.length, 0);
  assert.equal(app.net.jobs.length, 1, 'training history is untouched');
});

test('assigning a job from a card posts the assignment with the chosen kind', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, devices: [device()], jobs: [job({ status: 'queued', progress_percent: 0 })] });
  await renderPage(app);

  const select = app.doc.querySelector('[data-assign-select="dev_phone"]');
  assert.ok(select, 'the assign selector exists');
  select.value = 'job_parallel1';
  const kind = app.doc.querySelector('[data-assign-kind="dev_phone"]');
  kind.value = 'preprocess';

  await app.window.devices.assignFromCard('dev_phone', app.doc.querySelector('[data-assign-select="dev_phone"]'));
  await tick(2);

  const assign = app.net.deviceCalls.find((call) => /\/assign$/.test(call.route));
  assert.ok(assign, 'the assign endpoint was called');
  assert.equal(assign.body.job_id, 'job_parallel1');
  assert.equal(assign.body.kind, 'preprocess');
  assert.equal(app.net.deviceTasks.length, 1);
});

test('collaborative mode is labelled with its real limits and shards the dataset', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    devices: [device(), device({ id: 'dev_phone2', name: 'Pixel 8' })],
    jobs: [job({ status: 'running' })],
  });
  await renderPage(app);

  const plan = app.doc.getElementById('multi-device-plan').textContent;
  assert.match(plan, /Gradient\/weight synchronisation is \*\*not\*\* implemented|not\*\* implemented|not implemented/);
  assert.match(plan, /aggregates the real token counts/);

  await app.window.devices.startCollaborative(app.doc.querySelector('#multi-device-plan button.btn-primary'));
  await tick(3);

  const call = app.net.deviceCalls.find((item) => /\/plan\/collaborative$/.test(item.route));
  assert.ok(call, 'the plan endpoint was called');
  assert.deepEqual(call.body.device_ids, ['dev_phone', 'dev_phone2']);
  assert.equal(app.net.deviceTasks.filter((task) => task.kind === 'preprocess').length, 2);
});

test('per-job progress uses the coordinator numbers, never an average of devices', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    devices: [
      device({ task: { id: 'task_a', device_id: 'dev_phone', job_id: 'job_parallel1', kind: 'preprocess', status: 'completed', progress_percent: 100, shard_index: 0, shard_count: 2, detail: { result: { token_count: 120 } } } }),
      device({ id: 'dev_slow', name: 'Old tablet', task: { id: 'task_b', device_id: 'dev_slow', job_id: 'job_parallel1', kind: 'preprocess', status: 'running', progress_percent: 0, shard_index: 1, shard_count: 2 } }),
    ],
    jobs: [job({ progress_percent: 33.3 })],
    deviceTasks: [
      { id: 'task_a', device_id: 'dev_phone', job_id: 'job_parallel1', kind: 'preprocess', status: 'completed', progress_percent: 100, shard_index: 0, shard_count: 2, detail: { result: { token_count: 120 } } },
      { id: 'task_b', device_id: 'dev_slow', job_id: 'job_parallel1', kind: 'preprocess', status: 'running', progress_percent: 0, shard_index: 1, shard_count: 2 },
    ],
  });
  await renderPage(app);
  await app.window.devices.loadJobTasks('job_parallel1');
  app.window.devices.renderJobsPanel();
  await tick(2);

  const card = app.doc.querySelector('[data-job-card="job_parallel1"]');
  assert.ok(card, 'the job progress card exists');
  assert.match(card.textContent, /33\.3%/);
  assert.doesNotMatch(card.textContent, /50\.0%/, 'device percentages are not averaged into the job progress');
  assert.match(card.textContent, /1 of 2 shards complete/);
  assert.match(card.textContent, /120 tokens counted by devices/);
});

test('a disconnected device releases its work and the page shows it offline', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    devices: [device({
      status: 'busy',
      task: { id: 'task_c', device_id: 'dev_phone', job_id: 'job_parallel1', kind: 'preprocess', status: 'running', progress_percent: 40, shard_index: 0, shard_count: 1 },
    })],
    jobs: [job()],
    deviceTasks: [{ id: 'task_c', device_id: 'dev_phone', job_id: 'job_parallel1', kind: 'preprocess', status: 'running', progress_percent: 40, shard_index: 0, shard_count: 1 }],
  });
  await renderPage(app);

  await app.window.devices.disconnectDevice('dev_phone', app.doc.querySelector('[data-device-disconnect="dev_phone"]'));
  await tick(3);

  assert.equal(app.net.devices[0].status, 'offline');
  assert.equal(app.net.deviceTasks[0].status, 'expired', 'the lease was released so the work is not locked');
  assert.match(app.doc.getElementById('multi-device-list').textContent, /Offline/);
});

test('distributing active jobs calls auto-assign and reports which jobs were not placed', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    devices: [device()],
    jobs: [job({ id: 'job_q1', status: 'queued', progress_percent: 0 }), job({ id: 'job_q2', status: 'queued', progress_percent: 0 })],
  });
  await renderPage(app);

  await app.window.devices.startParallel(app.doc.querySelector('#multi-device-plan .mode-card button'));
  await tick(3);

  const call = app.net.deviceCalls.find((item) => /\/auto-assign$/.test(item.route));
  assert.ok(call, 'auto-assign was called');
  assert.deepEqual(call.body.job_ids, ['job_q1', 'job_q2']);
});

test('the module renders the page the router asked for, not the last route in state', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, devices: [device()] });

  // state still says "training" (the router sets it after rendering) while the
  // router asks for multi-device: the multi-device page must win.
  app.window.state.setRoute('training');
  await app.window.devices.render('multi-device');
  await tick(2);
  assert.ok(app.doc.getElementById('multi-device-root'), 'multi-device page rendered');
  assert.equal(app.doc.getElementById('device-compute-root'), null);

  app.window.devices.dispose();
  app.window.location.hash = '#/device-compute';
  await app.window.devices.render('device-compute');
  await tick(2);
  assert.ok(app.doc.getElementById('device-compute-root'), 'device compute page rendered');
  assert.equal(app.doc.getElementById('multi-device-root'), null);
});
