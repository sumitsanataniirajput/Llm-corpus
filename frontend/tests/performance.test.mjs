/**
 * Interaction performance regressions.
 *
 * Every test here corresponds to a symptom the user reported as "the app
 * freezes": a click that does nothing, a page that blocks navigation, data that
 * is re-fetched on every visit, a list that stalls the main thread, metrics that
 * flood the DOM, and buttons that fire twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { bootFullApp, waitFor } from './full-app-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(options = {}) {
  const settings = { latencyMs: 40, datasets: 6, models: 4, jobs: 2, ...options };
  const app = bootFullApp(settings);
  // Let the bootstrap render its first route (and finish its own reads, which
  // take `latencyMs` each), then start every test from a cold cache with a
  // clean request log, so the bootstrap's traffic is never counted as the test's.
  await sleep(settings.latencyMs * 2 + 150);
  app.window.CORPUS_API.invalidateCache();
  app.calls.length = 0;
  return app;
}

test('a click during a slow page load still navigates to the page that was clicked', async () => {
  const app = await boot({ latencyMs: 300 });

  // Open Models (slow), and immediately click Datasets — the old router returned
  // early while `isNavigating` was true, so this click was silently swallowed.
  app.window.router.navigate('models');
  await app.window.router.navigate('datasets');

  assert.equal(app.window.location.hash, '#/datasets', 'the last click wins');
  const text = app.container.textContent;
  assert.match(text, /Dataset Manager/i, 'the clicked page is on screen');
  assert.doesNotMatch(text, /Model library/i, 'the abandoned page did not paint over it');
  app.close();
});

test('a late response from an abandoned page cannot replace the current page', async () => {
  const app = await boot({ latencyMs: 250 });

  app.window.router.navigate('models');
  await app.window.router.navigate('settings');
  // Wait long enough that the abandoned Models render would have finished.
  await sleep(700);

  assert.match(app.container.textContent, /Settings|Preferences/i);
  assert.doesNotMatch(app.container.textContent, /Create model/i);
  app.close();
});

test('repeated views of the same collection are served from cache, and invalidation re-fetches', async () => {
  const app = await boot();

  await app.window.CORPUS_API.listModels('test-token');
  await app.window.CORPUS_API.listModels('test-token');
  await app.window.CORPUS_API.listModels('test-token');
  const gets = app.calls.filter((call) => call.route === '/api/v1/models' && call.method === 'GET');
  assert.equal(gets.length, 1, 'three views, one request');

  app.window.CORPUS_API.invalidateCache();
  await app.window.CORPUS_API.listModels('test-token');
  const after = app.calls.filter((call) => call.route === '/api/v1/models' && call.method === 'GET');
  assert.equal(after.length, 2, 'invalidating forces a fresh read');
  app.close();
});

test('two identical reads in flight share one request', async () => {
  const app = await boot({ latencyMs: 120 });
  const [first, second] = await Promise.all([
    app.window.CORPUS_API.listDatasets('test-token'),
    app.window.CORPUS_API.listDatasets('test-token'),
  ]);
  const gets = app.calls.filter((call) => call.route === '/api/v1/datasets' && call.method === 'GET');
  assert.equal(gets.length, 1, 'de-duplicated');
  assert.equal(first.length, second.length);
  app.close();
});

test('cached data is scoped per user, so one account never sees another account list', async () => {
  const app = await boot();
  await app.window.CORPUS_API.listModels('test-token');
  app.window.state.setUser({ id: 'user-2', email: 'other@example.com' });
  await app.window.CORPUS_API.listModels('test-token');
  const gets = app.calls.filter((call) => call.route === '/api/v1/models' && call.method === 'GET');
  assert.equal(gets.length, 2, 'a different user must not be served the first user cache');
  app.close();
});

test('a write invalidates cached reads', async () => {
  const app = await boot();
  await app.window.CORPUS_API.listDatasets('test-token');
  await app.window.CORPUS_API.createDataset({ name: 'New corpus', format: 'txt', size: 0 }, 'test-token');
  await app.window.CORPUS_API.listDatasets('test-token');
  const gets = app.calls.filter((call) => call.route === '/api/v1/datasets' && call.method === 'GET');
  assert.equal(gets.length, 2, 'the list after a create is not the pre-create cache');
  app.close();
});

test('a long list renders a bounded page of rows, and Show more reveals the rest', async () => {
  const app = await boot({ datasets: 0, models: 120, latencyMs: 0 });
  await app.window.router.navigate('models');
  await sleep(120);

  const cards = app.container.querySelectorAll('.model-card').length;
  assert.ok(cards > 0 && cards <= 30, `expected a bounded first page, got ${cards}`);
  const more = app.container.querySelector('[data-show-more]');
  assert.ok(more, 'a Show more control is offered');

  more.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  const after = app.container.querySelectorAll('.model-card').length;
  assert.ok(after > cards, 'Show more appends the next page');
  app.close();
});

test('the training log cannot grow without bound', async () => {
  const app = await boot();
  await app.window.router.navigate('training');
  await sleep(120);
  await app.window.training.render();
  for (let i = 0; i < 400; i += 1) app.window.training.appendLog('line ' + i, 'info');
  const panel = app.doc.getElementById('t-logs');
  assert.ok(panel.childElementCount <= 300, `log capped, got ${panel.childElementCount}`);
  app.close();
});

test('a burst of live metrics does one DOM/chart flush per frame, not one per metric', async () => {
  const app = await boot({ jobs: 1 });
  await app.window.router.navigate('training');
  await sleep(120);

  let chartUpdates = 0;
  const observer = app.window.Chart;
  const originalUpdate = observer.prototype.update;
  observer.prototype.update = function countingUpdate(...args) {
    chartUpdates += 1;
    return originalUpdate.apply(this, args);
  };

  for (let step = 1; step <= 60; step += 1) {
    app.window.training.applyMetric({ step, loss: 2 - step / 100, tokens_per_second: 900 });
  }
  await sleep(80);
  assert.ok(chartUpdates <= 4, `charts updated ${chartUpdates} times for 60 metrics (expected ≤ 4)`);
  observer.prototype.update = originalUpdate;
  app.close();
});

test('presses give immediate visual feedback and buttons never fire twice', async () => {
  const app = await boot();
  await app.window.router.navigate('models');
  await sleep(120);

  const button = app.container.querySelector('.btn');
  assert.ok(button, 'page has a button');
  button.dispatchEvent(new app.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.ok(button.classList.contains('is-pressed'), 'press feedback is applied on pointerdown');
  button.dispatchEvent(new app.window.MouseEvent('pointerup', { bubbles: true }));
  assert.ok(!button.classList.contains('is-pressed'), 'feedback is cleared on pointerup');

  let runs = 0;
  const slow = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve(); }, 30));
  await Promise.all([
    app.window.ui.guard(button, slow),
    app.window.ui.guard(button, slow),
    app.window.ui.guard(button, slow),
  ]);
  assert.equal(runs, 1, 'a double/triple tap performs the action once');
  app.close();
});

test('leaving the Training page destroys its charts instead of leaking them', async () => {
  const app = await boot({ jobs: 1 });
  await app.window.router.navigate('training');
  await sleep(120);
  const training = app.window.training;
  assert.ok(training && typeof training.render === 'function');
  await training.render();
  await app.window.router.navigate('dashboard');
  await sleep(60);
  // charts.destroyChart is idempotent; the point is that dispose ran on the way
  // out and no chart instance is still registered for the training canvases.
  const registered = Object.keys(app.window.charts.instances());
  assert.deepEqual(registered.filter((id) => id.indexOf('training-') === 0), []);
  app.close();
});

test('a cancelled request is reported as cancelled, never as a backend failure', async () => {
  const app = await boot({ latencyMs: 200 });
  const controller = new app.window.AbortController();
  // A route the bootstrap does not read, so the cache cannot answer it.
  const promise = app.window.CORPUS_API.request('/api/v1/experiments/', { token: 'test-token', signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, 'ABORTED');
    assert.equal(err.aborted, true);
    return true;
  });
  // An abort must not poison the whole app with "backend unavailable".
  const ok = await app.window.CORPUS_API.listModels('test-token');
  assert.ok(Array.isArray(ok), 'later requests still work after a cancelled one');
  app.close();
});
