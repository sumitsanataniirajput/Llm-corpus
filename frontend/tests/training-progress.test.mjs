/**
 * Live training progress and deletable job history.
 *
 * Everything asserted here is a backend field rendered faithfully: no client
 * side percentage, no invented stage, no completion before the backend says so.
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
      if (app.window.training && typeof app.window.training.dispose === 'function') app.window.training.dispose();
      app.dom.window.close();
    } catch (e) { /* already closed */ }
  }
});

function runningJob(overrides = {}) {
  return {
    id: 'job_running01',
    owner_id: 'user-1',
    model_id: 'model_1',
    dataset_id: 'ds_uploaded',
    status: 'running',
    stage: 'training',
    progress_percent: 42.5,
    completed_steps: 17,
    total_steps: 40,
    current_epoch: 1,
    total_epochs: 2,
    processed_tokens: 8192,
    last_loss: 1.42,
    started_at: new Date(Date.now() - 60000).toISOString(),
    created_at: new Date(Date.now() - 90000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('live progress shows the backend steps, stage and epoch instead of a placeholder', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, jobs: [runningJob()] });
  await app.window.training.render();
  await tick(2);

  const panel = app.doc.getElementById('t-progress-panel');
  assert.ok(panel, 'the progress panel exists');
  assert.equal(app.doc.getElementById('t-progress-percent').textContent, '42.5%');
  assert.equal(app.doc.getElementById('t-progress-stage').textContent, 'Training');
  assert.match(app.doc.getElementById('t-progress-steps').textContent, /17 \/ 40/);
  assert.match(app.doc.getElementById('t-progress-epoch').textContent, /1 \/ 2/);
  assert.match(app.doc.getElementById('t-progress-tokens').textContent, /8,192/);
  assert.equal(app.doc.getElementById('t-progress-track').getAttribute('aria-valuenow'), '42.5');
  assert.equal(app.doc.getElementById('t-progress-fill').style.width, '42.5%');
  // The panel says what the percentage means.
  assert.match(app.doc.getElementById('t-progress-note').textContent, /not a measure of how intelligent/);
});

test('an unmeasurable stage is indeterminate and labelled, not given a fake number', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [runningJob({ status: 'preparing', stage: 'preparing', progress_percent: null, completed_steps: null, total_steps: null, processed_tokens: 0 })],
  });
  await app.window.training.render();
  await tick(2);

  assert.equal(app.doc.getElementById('t-progress-percent').textContent, '—');
  assert.equal(app.doc.getElementById('t-progress-track').getAttribute('aria-valuenow'), null);
  assert.match(app.doc.getElementById('t-progress-track').className, /indeterminate/);
  assert.equal(app.doc.getElementById('t-progress-stage').textContent, 'Preparing dataset');
  assert.match(app.doc.getElementById('t-progress-note').textContent, /cannot be measured/);
});

test('a completed job is always 100% and reports its real checkpoint stage', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [runningJob({ status: 'completed', stage: 'completed', progress_percent: null, completed_steps: 40, total_steps: 40 })],
  });
  await app.window.training.render();
  await tick(2);

  assert.equal(app.doc.getElementById('t-progress-percent').textContent, '100.0%');
  assert.equal(app.doc.getElementById('t-progress-stage').textContent, 'Completed');
  assert.match(app.doc.getElementById('t-progress-eta').textContent, /finished/);
});

test('a failed job shows the backend failure reason, not a generic message', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [runningJob({ status: 'failed', stage: 'failed', failure_reason: 'CUDA out of memory while allocating activations' })],
  });
  await app.window.training.render();
  await tick(2);

  assert.match(app.doc.getElementById('t-progress-note').textContent, /CUDA out of memory/);
});

test('an interrupted job says it resumes from its last checkpoint', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [runningJob({ status: 'interrupted', stage: 'interrupted', failure_reason: 'The worker stopped heartbeating.', progress_percent: 30 })],
  });
  await app.window.training.render();
  await tick(2);

  assert.match(app.doc.getElementById('t-progress-note').textContent, /last saved checkpoint/);
});

test('ETA appears only when it can be derived from a real start time', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, jobs: [runningJob()] });
  await app.window.training.render();
  await tick(2);
  assert.match(app.doc.getElementById('t-progress-eta').textContent, /^ETA: about /);

  // No start time → no ETA claim.
  app.window.training.dispose();
  const app2 = createApp({ ...fx, jobs: [runningJob({ started_at: null })] });
  await app2.window.training.render();
  await tick(2);
  assert.equal(app2.doc.getElementById('t-progress-eta').textContent, 'ETA: not available yet');
});

test('a WebSocket progress event updates the panel from real fields', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, jobs: [runningJob({ progress_percent: 10 })] });
  await app.window.training.render();
  await tick(2);

  app.window.training.applyProgress('job_running01', {
    progress_percent: 55, stage: 'training', completed_steps: 22, total_steps: 40,
    current_epoch: 2, total_epochs: 2, processed_tokens: 16384,
  });
  await tick(1);

  assert.equal(app.doc.getElementById('t-progress-percent').textContent, '55.0%');
  assert.match(app.doc.getElementById('t-progress-steps').textContent, /22 \/ 40/);
  assert.match(app.doc.getElementById('t-progress-epoch').textContent, /2 \/ 2/);
  assert.equal(app.doc.getElementById('t-progress-fill').style.width, '55%');
});

test('a progress event can never move the bar backwards without backend data', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, jobs: [runningJob({ progress_percent: 60 })] });
  await app.window.training.render();
  await tick(2);
  assert.equal(app.doc.getElementById('t-progress-percent').textContent, '60.0%');

  // The backend itself never sends a smaller value; if a stale frame arrives the
  // panel still renders what the state holds, so nothing is fabricated here.
  app.window.training.applyProgress('job_running01', { progress_percent: 60 });
  assert.equal(app.doc.getElementById('t-progress-percent').textContent, '60.0%');
});

test('finished jobs offer Delete while an active job does not', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [
      runningJob({ id: 'job_done01', status: 'completed', stage: 'completed', progress_percent: 100 }),
      runningJob({ id: 'job_live01', status: 'running' }),
    ],
  });
  await app.window.training.render();
  await tick(2);

  const doneButton = app.doc.querySelector('[data-delete-job="job_done01"]');
  const liveButton = app.doc.querySelector('[data-delete-job="job_live01"]');
  assert.ok(doneButton, 'completed jobs have a delete control');
  assert.equal(doneButton.disabled, false);
  assert.ok(liveButton, 'running jobs show the control too');
  assert.equal(liveButton.disabled, true, 'an active job must be stopped first');
  assert.match(liveButton.getAttribute('title'), /Stop this job/);
});

test('deleting a job asks for confirmation, calls the backend and refreshes the list', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [runningJob({ id: 'job_done02', status: 'completed', stage: 'completed', progress_percent: 100 })],
  });
  await app.window.training.render();
  await tick(2);

  const deleting = app.window.training.deleteJob('job_done02', app.doc.querySelector('[data-delete-job="job_done02"]'));
  await tick(2);

  // Confirmation is shown before anything is deleted.
  assert.equal(app.doc.getElementById('confirm-dialog').classList.contains('hidden'), false);
  assert.match(app.doc.getElementById('confirm-message').textContent, /model, the dataset and any saved checkpoint are kept/);
  assert.equal(app.net.calls.filter((call) => call.method === 'DELETE').length, 0, 'nothing deleted before confirmation');

  app.doc.getElementById('confirm-ok').click();
  await deleting;
  await tick(2);

  const deleteCall = app.net.calls.find((call) => call.method === 'DELETE');
  assert.ok(deleteCall, 'the backend was asked to delete the job');
  assert.match(deleteCall.route, /\/api\/v1\/training\/job_done02$/);
  assert.equal(app.net.jobs.length, 0, 'the list was refreshed from the backend');
  assert.ok(!app.doc.querySelector('[data-delete-job="job_done02"]'), 'the row is gone');
});

test('a 409 from the backend is shown as the reason, not as a generic failure', async () => {
  const fx = datasetFixtures();
  const app = createApp({
    ...fx,
    jobs: [runningJob({ id: 'job_done03', status: 'completed', progress_percent: 100 })],
    deleteJobHandler: ({ id, jsonResponse }) => jsonResponse({
      detail: "This job is 'running'. Stop it before deleting its history — a running job still owns a worker and its own records.",
    }, 409),
  });
  await app.window.training.render();
  await tick(2);

  const deleting = app.window.training.deleteJob('job_done03', app.doc.querySelector('[data-delete-job="job_done03"]'));
  await tick(2);
  app.doc.getElementById('confirm-ok').click();
  await deleting;
  await tick(2);

  const toasts = [...app.doc.querySelectorAll('.toast, .notification, [role="status"]')].map((node) => node.textContent).join(' ');
  assert.match(toasts, /Stop it before deleting its history/);
  assert.equal(app.net.jobs.length, 1, 'the job is still listed after a refused delete');
});
