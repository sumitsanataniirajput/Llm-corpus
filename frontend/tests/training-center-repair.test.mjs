/* Regression coverage for the Training Center `t is not iterable` crash.
 * One suite uses the real Chart.js 4.4.0 UMD bundle and a real 2D renderer;
 * the lightweight stub in full-app-harness could never reproduce the resolver
 * Proxy failure that blanked the production page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootFullApp, waitFor } from './full-app-harness.mjs';
import { installChartCanvas, installRealChartJs } from './chartjs-canvas.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TRAINING_IDS = new Set(['training-loss-chart', 'training-throughput-chart']);

function captureErrors(app) {
  const errors = [];
  const originalRecord = app.window.CORPUS_APP.recordError;
  app.window.CORPUS_APP.recordError = function recordError(source, message, error) {
    errors.push(`recordError ${source}: ${message}\n${error && error.stack ? error.stack : ''}`);
    return originalRecord.call(this, source, message, error);
  };
  const onWindowError = event => errors.push(`window.error: ${event.message || 'unknown'}`);
  app.window.addEventListener('error', onWindowError);
  const onJsdomError = error => errors.push(`jsdomError: ${error && error.message ? error.message : error}\n${error && error.stack ? error.stack : ''}`);
  app.dom.virtualConsole.on('jsdomError', onJsdomError);
  return {
    errors,
    restore() {
      app.window.CORPUS_APP.recordError = originalRecord;
      app.window.removeEventListener('error', onWindowError);
      if (typeof app.dom.virtualConsole.off === 'function') {
        app.dom.virtualConsole.off('jsdomError', onJsdomError);
      }
    },
  };
}

function boot(options = {}, withRealChartJs = false) {
  const app = bootFullApp({ hash: '#/dashboard', ...options });
  const captured = captureErrors(app);
  if (withRealChartJs) {
    installChartCanvas(app.window);
    installRealChartJs(app.window);
  }
  return { app, ...captured };
}

function cleanup(fixture) {
  try { fixture.app.window.training.dispose(); } catch (e) { /* already gone */ }
  try { fixture.app.window.charts.destroyAll(); } catch (e) { /* already gone */ }
  fixture.restore();
  fixture.app.close();
}

function trainingChartIds(app) {
  return Object.keys(app.window.charts.instances()).filter(id => TRAINING_IDS.has(id));
}

async function openTraining(fixture) {
  await fixture.app.window.router.navigate('training');
  await waitFor(() => !!fixture.app.doc.getElementById('t-model') || /Page failed to load/.test(fixture.app.container.textContent), { timeoutMs: 1500 });
  await sleep(25);
}

function assertTrainingControls(fixture, label) {
  const { app, errors } = fixture;
  assert.doesNotMatch(app.container.textContent, /Page failed to load|t is not iterable/, `${label}: no router error panel`);
  assert.equal(errors.length, 0, `${label}: no uncaught/render errors\n${errors.join('\n---\n')}`);
  ['t-model', 't-dataset', 't-start', 'training-loss-chart', 'training-throughput-chart'].forEach((id) => {
    assert.ok(app.doc.getElementById(id), `${label}: #${id} remains available`);
  });
}

function model(id, name) {
  return { id, name, status: 'idle', config: { hidden_size: 128, num_hidden_layers: 2, vocab_size: 32000 } };
}

function dataset(id, name) {
  return { id, name, file_name: `${id}.txt`, size: 2048, status: 'uploaded', has_file: true };
}

function job(id, status, overrides = {}) {
  return {
    id,
    owner_id: 'user-1',
    model_id: 'model_fresh',
    dataset_id: 'ds_fresh',
    status,
    stage: status === 'completed' ? 'completed' : 'training',
    progress_percent: status === 'completed' ? 100 : 40,
    completed_steps: status === 'completed' ? 20 : 8,
    total_steps: 20,
    current_epoch: 1,
    total_epochs: 2,
    processed_tokens: 4096,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('real Chart.js 4.4.0: first Training Center load keeps all controls and both charts', async (t) => {
  const fixture = boot({ datasets: 2, models: 2, jobs: 2 }, true);
  t.after(() => cleanup(fixture));
  await sleep(40);
  await openTraining(fixture);

  assert.equal(fixture.app.window.__CORPUS_TEST_CHART_VERSION, '4.4.0');
  assertTrainingControls(fixture, 'first load');
  assert.equal(trainingChartIds(fixture.app).length, 2, 'both optional charts initialized');
  const state = fixture.app.window.charts.chartState('training-loss-chart');
  assert.ok(state, 'chart state is readable after an empty-label update');
  assert.equal(state.labels.length, 0, 'empty labels remain empty after the real Chart.js update');
  assert.equal(state.xType, 'category');
});

test('open → leave → reopen is repeatable and leaves no live Training chart instances', async (t) => {
  const fixture = boot({ datasets: 2, models: 2, jobs: 1 }, true);
  t.after(() => cleanup(fixture));
  await sleep(40);

  for (let visit = 1; visit <= 3; visit += 1) {
    await openTraining(fixture);
    assertTrainingControls(fixture, `visit ${visit}`);
    assert.equal(trainingChartIds(fixture.app).length, 2, `visit ${visit} has exactly two charts`);

    const modelSelect = fixture.app.doc.getElementById('t-model');
    modelSelect.value = modelSelect.options[1] ? modelSelect.options[1].value : '';
    modelSelect.dispatchEvent(new fixture.app.window.Event('change', { bubbles: true }));
    assert.ok(fixture.app.doc.getElementById('t-estimate'), `visit ${visit} selectors remain interactive`);

    await fixture.app.window.router.navigate('dashboard');
    await sleep(20);
    assert.equal(trainingChartIds(fixture.app).length, 0, `visit ${visit} disposes both charts`);
  }
});

test('renderCharts and dispose are safe to call repeatedly with real Chart.js', async (t) => {
  const fixture = boot({ datasets: 1, models: 1 }, true);
  t.after(() => cleanup(fixture));
  await sleep(40);
  await openTraining(fixture);

  fixture.app.window.training.renderCharts();
  fixture.app.window.training.renderCharts();
  assert.equal(trainingChartIds(fixture.app).length, 2, 'idempotent render does not leak chart instances');
  fixture.app.window.training.dispose();
  fixture.app.window.training.dispose();
  assert.equal(trainingChartIds(fixture.app).length, 0, 'idempotent dispose removes chart instances');
  assert.equal(fixture.errors.length, 0, `no chart errors\n${fixture.errors.join('\n---\n')}`);
});

test('Training controls stay usable when Chart.js is missing', async (t) => {
  const fixture = boot({ datasets: 1, models: 1 });
  t.after(() => cleanup(fixture));
  fixture.app.window.Chart = undefined;
  await sleep(30);
  await openTraining(fixture);

  assertTrainingControls(fixture, 'Chart.js missing');
  assert.equal(trainingChartIds(fixture.app).length, 0);
  assert.match(fixture.app.doc.getElementById('training-loss-empty').textContent, /Charting is unavailable/);
});

test('a throwing Chart.js constructor cannot blank the Training Center', async (t) => {
  const fixture = boot({ datasets: 1, models: 1 });
  t.after(() => cleanup(fixture));
  fixture.app.window.Chart = class ThrowingChart {
    constructor() { throw new Error('Chart constructor unavailable'); }
  };
  await sleep(30);
  await openTraining(fixture);

  assertTrainingControls(fixture, 'Chart.js constructor throws');
  assert.equal(trainingChartIds(fixture.app).length, 0);
  assert.match(fixture.app.doc.getElementById('training-throughput-empty').textContent, /Charting is unavailable/);
});

test('empty, populated and malformed list shapes all render without assuming iterability', async (t) => {
  const empty = boot();
  t.after(() => cleanup(empty));
  empty.app.window.CORPUS_API.listModels = async () => [];
  empty.app.window.CORPUS_API.listDatasets = async () => [];
  empty.app.window.CORPUS_API.listTrainingJobs = async () => [];
  await sleep(30);
  await openTraining(empty);
  assertTrainingControls(empty, 'empty lists');
  assert.match(empty.app.doc.getElementById('t-model').textContent, /No models available/);
  assert.match(empty.app.doc.getElementById('t-dataset').textContent, /No datasets available/);

  const populated = boot();
  t.after(() => cleanup(populated));
  populated.app.window.CORPUS_API.listModels = async () => ({ models: [model('model_fresh', 'Fresh model')] });
  populated.app.window.CORPUS_API.listDatasets = async () => ({ datasets: [dataset('ds_fresh', 'Fresh corpus')] });
  populated.app.window.CORPUS_API.listTrainingJobs = async () => ({ jobs: [job('job_done01', 'completed')] });
  populated.app.window.CORPUS_API.getTrainingJob = async () => job('job_done01', 'completed');
  populated.app.window.CORPUS_API.listTrainingLogs = async () => ({ events: [{ event: 'completed' }] });
  populated.app.window.CORPUS_API.listTrainingMetrics = async () => ({ metrics: [{ step: 1, loss: 1.25, tokens_per_second: 42 }] });
  populated.app.window.CORPUS_API.listCheckpoints = async () => ({ checkpoints: [{ id: 'ckpt_1', step: 20, created_at: new Date().toISOString() }] });
  await sleep(30);
  await openTraining(populated);
  await sleep(50);
  assertTrainingControls(populated, 'populated lists');
  assert.match(populated.app.doc.getElementById('t-model').textContent, /Fresh model/);
  assert.match(populated.app.doc.getElementById('t-dataset').textContent, /Fresh corpus/);
  assert.match(populated.app.doc.getElementById('t-jobs').textContent, /Completed|completed/i);
  assert.match(populated.app.doc.getElementById('t-checkpoints').textContent, /ckpt_1/);
  assert.match(populated.app.doc.getElementById('t-logs').textContent, /Step 1/);

  const malformed = boot();
  t.after(() => cleanup(malformed));
  malformed.app.window.CORPUS_API.listModels = async () => ({ models: 'not iterable' });
  malformed.app.window.CORPUS_API.listDatasets = async () => ({ datasets: { length: 2 } });
  malformed.app.window.CORPUS_API.listTrainingJobs = async () => ({ jobs: { length: 2 } });
  malformed.app.window.CORPUS_API.getTrainingJob = async () => ({ detail: 'not a job' });
  malformed.app.window.CORPUS_API.listTrainingLogs = async () => ({ events: 'not iterable' });
  malformed.app.window.CORPUS_API.listTrainingMetrics = async () => 'not iterable';
  malformed.app.window.CORPUS_API.listCheckpoints = async () => ({ checkpoints: 7 });
  await sleep(30);
  await openTraining(malformed);
  assertTrainingControls(malformed, 'malformed lists');
  assert.match(malformed.app.doc.getElementById('t-model').textContent, /No models available/);
  assert.match(malformed.app.doc.getElementById('t-dataset').textContent, /No datasets available/);
});

test('active and completed jobs preserve status, progress and metrics with malformed event envelopes', async (t) => {
  const fixture = boot();
  t.after(() => cleanup(fixture));
  const active = job('job_live01', 'running');
  const completed = job('job_done01', 'completed');
  fixture.app.window.CORPUS_API.listModels = async () => [model('model_fresh', 'Fresh model')];
  fixture.app.window.CORPUS_API.listDatasets = async () => [dataset('ds_fresh', 'Fresh corpus')];
  fixture.app.window.CORPUS_API.listTrainingJobs = async () => [active, completed];
  fixture.app.window.CORPUS_API.getTrainingJob = async id => (id === active.id ? active : completed);
  fixture.app.window.CORPUS_API.listTrainingMetrics = async () => ({ metrics: null });
  fixture.app.window.CORPUS_API.listTrainingLogs = async () => ({ events: 5 });
  fixture.app.window.CORPUS_API.listCheckpoints = async () => 'unavailable';
  await sleep(30);
  await openTraining(fixture);
  await sleep(50);

  assertTrainingControls(fixture, 'active/completed jobs');
  const jobsText = fixture.app.doc.getElementById('t-jobs').textContent;
  assert.match(jobsText, /Running|running/i);
  assert.match(jobsText, /Completed|completed/i);
  assert.match(fixture.app.doc.getElementById('t-monitor-status').textContent, /job_live01/);
  assert.match(fixture.app.doc.getElementById('t-progress-steps').textContent, /8 \/ 20/);
});

test('a stale async list response cannot overwrite a newly opened Training Center', async (t) => {
  const fixture = boot();
  t.after(() => cleanup(fixture));
  let resolveStale;
  const stalePromise = new Promise(resolve => { resolveStale = resolve; });
  let modelCalls = 0;
  fixture.app.window.CORPUS_API.listModels = async () => {
    modelCalls += 1;
    if (modelCalls === 1) return stalePromise;
    return [model('model_fresh', 'Fresh model')];
  };
  fixture.app.window.CORPUS_API.listDatasets = async () => [];
  fixture.app.window.CORPUS_API.listTrainingJobs = async () => [];
  await sleep(30);

  const firstNavigation = fixture.app.window.router.navigate('training');
  await waitFor(() => !!fixture.app.doc.getElementById('t-model'), { timeoutMs: 1000 });
  await fixture.app.window.router.navigate('dashboard');
  await fixture.app.window.router.navigate('training');
  await waitFor(() => /Fresh model/.test(fixture.app.doc.getElementById('t-model').textContent), { timeoutMs: 1000 });

  resolveStale([model('model_stale', 'STALE MODEL')]);
  await firstNavigation.catch(() => {});
  await sleep(30);

  assertTrainingControls(fixture, 'stale response');
  assert.match(fixture.app.doc.getElementById('t-model').textContent, /Fresh model/);
  assert.doesNotMatch(fixture.app.doc.getElementById('t-model').textContent, /STALE MODEL/);
});
