/**
 * Regression tests for the Training page dataset selector.
 *
 * Covers the reported bug: "ValueError: Select a dataset before starting
 * training." because the job was POSTed with dataset_id = null.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp, datasetFixtures, tick } from './harness.mjs';

test('dataset selector lists name, file name, size and upload status', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  const select = app.doc.getElementById('t-dataset');
  assert.ok(select, 'dataset selector exists on the Training page');
  assert.equal(select.disabled, false);

  const options = [...select.querySelectorAll('option')];
  const uploaded = options.find((o) => o.value === 'ds_uploaded');
  const pending = options.find((o) => o.value === 'ds_pending');

  assert.ok(uploaded, 'uploaded dataset is listed');
  assert.match(uploaded.textContent, /Wiki corpus/);
  assert.match(uploaded.textContent, /wiki\.txt/);
  assert.match(uploaded.textContent, /KB|B/);
  assert.match(uploaded.textContent, /uploaded/);
  assert.equal(uploaded.disabled, false);

  assert.ok(pending, 'pending dataset is listed');
  assert.match(pending.textContent, /Book draft/);
  assert.match(pending.textContent, /no file/);
  assert.match(pending.textContent, /pending/);
  assert.equal(pending.disabled, true, 'datasets without a file cannot be selected');

  assert.match(app.doc.getElementById('t-dataset-hint').textContent, /1 of 2 dataset\(s\) ready/);
});

test('start is blocked and no job is created when no dataset is selected', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  const startBtn = app.doc.getElementById('t-start');
  app.doc.getElementById('t-model').value = 'model_1';
  app.window.training.onModelChange();

  app.net.calls.length = 0;
  await app.window.training.startTraining();

  assert.equal(app.doc.getElementById('t-dataset').value, '');
  const error = app.doc.getElementById('t-form-error');
  assert.equal(error.classList.contains('hidden'), false);
  assert.match(error.textContent, /Select a dataset before starting training/i);

  const posts = app.net.calls.filter((c) => c.method === 'POST' && c.route === '/api/v1/training');
  assert.deepEqual(posts, [], 'no training job request must be sent');
  assert.equal(app.window.state.getTrainingJobs().length, 0);
  assert.equal(startBtn.disabled, true, 'Start Training stays disabled');
});

test('selected dataset id is sent as dataset_id in the training request', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  // Pick the model first, then the dataset — both are required.
  app.doc.getElementById('t-model').value = 'model_1';
  app.window.training.onModelChange();
  assert.equal(app.doc.getElementById('t-start').disabled, true, 'still disabled without a dataset');

  const select = app.doc.getElementById('t-dataset');
  select.value = 'ds_uploaded';
  select.dispatchEvent(new app.window.Event('change'));

  assert.equal(app.doc.getElementById('t-start').disabled, false);
  const info = app.doc.getElementById('t-dataset-info').textContent;
  assert.match(info, /Wiki corpus/);
  assert.match(info, /wiki\.txt/);
  assert.match(info, /ds_uploaded/);

  await app.window.training.startTraining();

  const posts = app.net.calls.filter((c) => c.method === 'POST' && c.route === '/api/v1/training');
  assert.equal(posts.length, 1, 'exactly one training job request');
  assert.equal(posts[0].body.dataset_id, 'ds_uploaded');
  assert.equal(posts[0].body.model_id, 'model_1');
  assert.equal(typeof posts[0].body.batch_size, 'number');

  const jobs = app.window.state.getTrainingJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].dataset_id, 'ds_uploaded');

  app.window.training.dispose();
});

test('a dataset that lost its file cannot start training', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  app.doc.getElementById('t-model').value = 'model_1';
  const select = app.doc.getElementById('t-dataset');
  select.value = 'ds_uploaded';
  select.dispatchEvent(new app.window.Event('change'));

  // The selected dataset becomes unusable (e.g. upload was rolled back).
  app.net.datasets[0] = { ...app.net.datasets[0], has_file: false, status: 'pending', file_name: null };
  app.window.dispatchEvent(new app.window.CustomEvent('corpus:datasets-changed'));
  await tick(20);

  app.net.calls.length = 0;
  await app.window.training.startTraining();

  assert.match(app.doc.getElementById('t-form-error').textContent, /Select a dataset before starting training|no uploaded file/i);
  const posts = app.net.calls.filter((c) => c.method === 'POST' && c.route === '/api/v1/training');
  assert.deepEqual(posts, [], 'no job request for an unusable dataset');
});

test('backend rejection is surfaced to the user instead of a silent failed job', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  // Simulate the backend refusing the job.
  const originalFetch = app.window.fetch;
  app.window.fetch = async (url, opts) => {
    if ((opts?.method || 'GET') === 'POST' && String(url).includes('/api/v1/training/')) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => 'application/json' },
        json: async () => ({ detail: 'Dataset \'Wiki corpus\' has no uploaded file yet.' }),
        text: async () => '{}',
      };
    }
    return originalFetch(url, opts);
  };

  const select = app.doc.getElementById('t-dataset');
  select.value = 'ds_uploaded';
  select.dispatchEvent(new app.window.Event('change'));
  app.doc.getElementById('t-model').value = 'model_1';

  await app.window.training.startTraining();

  assert.match(app.doc.getElementById('t-form-error').textContent, /no uploaded file/i);
  assert.equal(app.window.state.getTrainingJobs().length, 0);
  assert.equal(app.doc.getElementById('t-start').disabled, false, 'user can retry');

  app.window.fetch = originalFetch;
  app.window.training.dispose();
});

test('dataset list refreshes automatically after an upload', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  const before = app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'GET').length;

  // The backend now reports the second dataset as uploaded.
  app.net.datasets[1] = {
    ...app.net.datasets[1],
    status: 'uploaded',
    has_file: true,
    file_name: 'book.txt',
    file_size: 4096,
    uploaded_at: new Date().toISOString(),
  };
  app.window.dispatchEvent(new app.window.CustomEvent('corpus:datasets-changed', { detail: { datasetId: 'ds_pending' } }));
  await tick(20);

  const after = app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'GET').length;
  assert.equal(after, before + 1, 'dataset list was re-fetched');

  const option = [...app.doc.querySelectorAll('#t-dataset option')].find((o) => o.value === 'ds_pending');
  assert.equal(option.disabled, false, 'newly uploaded dataset becomes selectable');
  assert.match(option.textContent, /book\.txt/);
});

test('"Use for Training" from Dataset Manager preselects the dataset on Training', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);

  // Datasets page → useDataset() sets the pending id and navigates.
  await app.window.datasets.render();
  app.window.datasets.useDataset('ds_uploaded');
  assert.equal(app.net.navigatedTo, 'training');
  assert.equal(app.window.state.getPendingDatasetId(), 'ds_uploaded');

  // Training page consumes it.
  await app.window.training.render();
  assert.equal(app.doc.getElementById('t-dataset').value, 'ds_uploaded');
  assert.equal(app.window.state.getPendingDatasetId(), null);
  assert.equal(app.doc.getElementById('t-start').disabled, true, 'still needs a model');
});

test('Dataset Manager shows file metadata and status from the API', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.datasets.render();

  const cards = app.doc.querySelectorAll('.dataset-card');
  assert.equal(cards.length, 2);

  const uploadedCard = [...cards].find((c) => c.textContent.includes('Wiki corpus'));
  assert.match(uploadedCard.textContent, /wiki\.txt/);
  assert.match(uploadedCard.textContent, /uploaded/);
  assert.match(uploadedCard.textContent, /KB|B/);
  assert.equal(uploadedCard.querySelector('.status-badge').className.includes('uploaded'), true);

  const pendingCard = [...cards].find((c) => c.textContent.includes('Book draft'));
  assert.match(pendingCard.textContent, /no file uploaded/);
  assert.match(pendingCard.textContent, /pending upload/);
  assert.equal(pendingCard.querySelector('[onclick*="previewDataset"]').disabled, true);
  assert.ok(pendingCard.querySelector('[onclick*="uploadFileFor"]'), 'pending datasets can be completed from the card');
});

test('dataset preview renders real backend text', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.datasets.render();

  await app.window.datasets.previewDataset('ds_uploaded');
  const swal = app.window.__lastSwal;
  assert.ok(swal, 'preview dialog opened');
  assert.match(swal.html, /first line of the corpus/);
  assert.match(swal.html, /corpus\.txt/);
  assert.equal(app.net.calls.some((c) => c.route === '/api/v1/datasets/ds_uploaded/preview'), true);
});

test('training progress socket carries the auth token and real event vocabulary', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  const socket = await app.window.CORPUS_API.connectTrainingWS('job_x', {
    onStatus() {},
    onMetric() {},
  });
  assert.ok(socket, 'socket created');
  assert.match(socket.url, /\/api\/v1\/training\/ws\/job_x\?token=test-token/);
  assert.equal(app.WebSocketStub.opened.length >= 1, true);
});

test('empty dataset library shows guidance and keeps training disabled', async () => {
  const fx = datasetFixtures();
  const app = createApp({ ...fx, datasets: [] });
  await app.window.training.render();

  const select = app.doc.getElementById('t-dataset');
  assert.equal(select.disabled, true);
  assert.match(select.textContent, /No datasets available/);
  assert.match(app.doc.getElementById('t-dataset-hint').textContent, /No datasets yet/);
  assert.equal(app.doc.getElementById('t-start').disabled, true);

  // With a model but no datasets, the dataset message is shown.
  app.doc.getElementById('t-model').value = 'model_1';
  await app.window.training.startTraining();
  assert.match(app.doc.getElementById('t-form-error').textContent, /Select a dataset/i);
  assert.equal(app.net.calls.filter((c) => c.method === 'POST').length, 0);
});

test('backend failure event surfaces the real error message instead of "unknown"', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  app.doc.getElementById('t-model').value = 'model_1';
  const select = app.doc.getElementById('t-dataset');
  select.value = 'ds_uploaded';
  select.dispatchEvent(new app.window.Event('change'));

  await app.window.training.startTraining();
  await tick(10);

  const socket = app.WebSocketStub.opened[app.WebSocketStub.opened.length - 1];
  assert.ok(socket, 'training socket was opened');

  socket.onmessage({
    data: JSON.stringify({
      type: 'training.' + app.window.state.getTrainingJobs()[0].id,
      event: 'error',
      data: {
        job_id: app.window.state.getTrainingJobs()[0].id,
        status: 'failed',
        event: 'failed',
        data: { error: 'Select a dataset before starting training.' },
      },
    }),
  });
  await tick(10);

  assert.match(app.doc.getElementById('t-form-error').textContent, /Select a dataset before starting training/i);
  assert.match(app.doc.getElementById('t-logs').textContent, /Select a dataset before starting training/i);
  assert.doesNotMatch(app.doc.getElementById('t-logs').textContent, /Live stream error: unknown/);
  assert.equal(app.doc.getElementById('t-start').disabled, false, 'user can adjust selection and retry');

  app.window.training.dispose();
});

test('API client uses trailing slashes on collection endpoints to avoid 307 redirects', async () => {
  const fx = datasetFixtures();
  const app = createApp(fx);
  await app.window.training.render();

  const datasetsGet = app.net.calls.find((c) => c.method === 'GET' && c.route === '/api/v1/datasets');
  const modelsGet = app.net.calls.find((c) => c.method === 'GET' && c.route === '/api/v1/models');
  assert.ok(datasetsGet && new URL(datasetsGet.url).pathname.endsWith('/api/v1/datasets/'));
  assert.ok(modelsGet && new URL(modelsGet.url).pathname.endsWith('/api/v1/models/'));
});
