/**
 * Dashboard data-honesty tests.
 *
 * The dashboard must show backend values only: models, datasets, jobs and
 * checkpoints come from the API, and an offline backend produces em dashes
 * plus an explanation — never invented statistics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp, datasetFixtures, tick } from './harness.mjs';

function dashboardFixtures() {
  const fx = datasetFixtures();
  const now = Date.now();
  return {
    ...fx,
    jobs: [
      {
        id: 'job_done01',
        model_id: 'model_1',
        dataset_id: 'ds_uploaded',
        status: 'completed',
        created_at: new Date(now - 3600_000).toISOString(),
        updated_at: new Date(now - 3000_000).toISOString(),
      },
      {
        id: 'job_running01',
        model_id: 'model_2',
        dataset_id: 'ds_uploaded',
        status: 'running',
        created_at: new Date(now - 60_000).toISOString(),
        updated_at: new Date(now - 30_000).toISOString(),
      },
    ],
    checkpoints: [
      { id: 'ckpt_a', model_id: 'model_1', job_id: 'job_done01', step: 1, loss: 2.31, created_at: new Date(now - 3000_000).toISOString() },
      { id: 'ckpt_b', model_id: 'model_1', job_id: 'job_done01', step: 2, loss: 1.82, created_at: new Date(now - 2900_000).toISOString() },
    ],
    health: { status: 'ok' },
  };
}

function statValue(doc, label) {
  const cards = [...doc.querySelectorAll('#dashboard-stats .stat-card')];
  const card = cards.find((c) => c.querySelector('.stat-label')?.textContent.trim().toLowerCase() === label);
  assert.ok(card, `stat card "${label}" exists`);
  return card.querySelector('.stat-value').textContent.trim();
}

test('dashboard reads every statistic from the backend', async () => {
  const app = createApp(dashboardFixtures());
  await app.window.dashboard.render();

  assert.equal(statValue(app.doc, 'total models'), '2');
  assert.equal(statValue(app.doc, 'datasets'), '2');
  assert.equal(statValue(app.doc, 'completed jobs'), '1');
  assert.equal(statValue(app.doc, 'active jobs'), '1');
  assert.equal(statValue(app.doc, 'checkpoints'), '2');

  // The requests really happened.
  const routes = app.net.calls.map((c) => c.method + ' ' + c.route);
  for (const expected of [
    'GET /api/v1/models',
    'GET /api/v1/datasets',
    'GET /api/v1/training',
    'GET /api/v1/training/checkpoints',
    'GET /api/v1/health',
  ]) {
    assert.ok(routes.includes(expected), `dashboard called ${expected}`);
  }
});

test('dashboard lists real activity and model overview values', async () => {
  const app = createApp(dashboardFixtures());
  await app.window.dashboard.render();

  const activity = app.doc.getElementById('dashboard-activity').textContent;
  assert.match(activity, /job_running01/);
  assert.match(activity, /job_done01/);
  assert.match(activity, /Wiki corpus/);
  assert.match(activity, /Dataset uploaded/);

  const overview = app.doc.getElementById('dashboard-models').textContent;
  assert.match(overview, /Corpus Small/);
  assert.match(overview, /params \(computed\)/);
  assert.match(overview, /2 layers/);

  const connectivity = app.doc.getElementById('dashboard-connectivity-body').textContent;
  assert.match(connectivity, /Online/);
});

test('dashboard shows em dashes and an error state when the backend is offline', async () => {
  const app = createApp({ ...dashboardFixtures(), datasets: [], models: [], jobs: [], checkpoints: [] });
  // Every request fails at the network level.
  app.window.fetch = async () => {
    const err = new Error('Failed to fetch');
    err.networkError = true;
    throw err;
  };

  await app.window.dashboard.render();
  await tick(1);

  for (const label of ['total models', 'datasets', 'completed jobs', 'active jobs', 'checkpoints']) {
    assert.equal(statValue(app.doc, label), '—', `${label} must not show a fake number`);
  }

  const body = app.doc.getElementById('dashboard-stats').textContent;
  assert.doesNotMatch(body, /[1-9]/);
  assert.match(app.doc.getElementById('dashboard-activity').textContent, /Activity unavailable/i);
  assert.match(app.doc.getElementById('dashboard-connectivity-body').textContent, /Unavailable|Offline/i);
});

test('dashboard refresh re-reads the backend', async () => {
  const app = createApp(dashboardFixtures());
  await app.window.dashboard.render();

  const before = app.net.calls.filter((c) => c.route === '/api/v1/models' && c.method === 'GET').length;
  app.net.models.push({ id: 'model_3', name: 'Corpus Tiny', status: 'idle', config: {} });
  await app.window.dashboard.refresh();

  const after = app.net.calls.filter((c) => c.route === '/api/v1/models' && c.method === 'GET').length;
  assert.equal(after, before + 1);
  assert.equal(statValue(app.doc, 'total models'), '3');
});
