/** P1 / Phase 4 truthfulness — the training UI must not offer fake compute. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, datasetFixtures } from './harness.mjs';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trainingSource = fs.readFileSync(path.join(FRONTEND, 'js/training.js'), 'utf8');
const trainingEndpoint = fs.readFileSync(
  path.resolve(FRONTEND, '..', 'backend', 'app', 'api', 'endpoints', 'training.py'),
  'utf8'
);

const openApps = [];
after(() => {
  while (openApps.length) {
    const app = openApps.pop();
    try { app.dom.window.close(); } catch (e) { /* already closed */ }
  }
});

test('the Compute selector offers only real in-process CPU training', async () => {
  const app = createApp(datasetFixtures());
  openApps.push(app);
  await app.window.training.render();

  const select = app.doc.getElementById('t-compute');
  assert.ok(select, 'the Compute selector still exists');
  const values = Array.from(select.options).map((o) => o.value);
  assert.deepEqual(values, ['local'], 'no cloud/device option can be selected');
  assert.match(select.parentElement.textContent, /preprocess data only/);
  assert.match(select.parentElement.textContent, /do not run gradient training/);
});

test('the estimate states the real execution model', async () => {
  const app = createApp(datasetFixtures());
  openApps.push(app);
  await app.window.training.render();

  const model = app.doc.getElementById('t-model');
  const dataset = app.doc.getElementById('t-dataset');
  model.value = 'model_1';
  dataset.value = 'ds_uploaded';
  app.window.training.updateEstimate();

  const estimate = app.doc.getElementById('t-estimate');
  assert.match(estimate.textContent, /Backend in-process CPU/);
  assert.doesNotMatch(estimate.textContent, /Cloud worker/);
  assert.match(estimate.textContent, /connected-device tasks preprocess data only/i);
});

test('source and backend reject any non-local compute mode', () => {
  assert.doesNotMatch(trainingSource, /value=["']cloud["']/);
  assert.match(trainingSource, /Backend in-process CPU/);
  assert.match(trainingEndpoint, /validate_compute/);
  assert.match(trainingEndpoint, /Only local in-process CPU training is implemented/);
  assert.match(trainingEndpoint, /cloud gradient workers/);
});
