/**
 * Global action lifecycle — the guarantees the whole app now depends on.
 *
 * Every scenario below is one of the situations a user actually hits:
 * success, backend rejection, no network, timeout, navigating away mid-action,
 * a double tap, a background job that finishes later, a background job that
 * fails, and a duplicated completion event (WebSocket + polling).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, datasetFixtures, tick } from './harness.mjs';

function makeButton(app, html = '<i class="fas fa-save"></i> Save') {
  const btn = app.doc.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.innerHTML = html;
  app.doc.getElementById('page-container').appendChild(btn);
  return btn;
}

function toasts(app, type) {
  const selector = type ? '#toast-container .toast.' + type : '#toast-container .toast';
  return Array.from(app.doc.querySelectorAll(selector));
}

function freshApp() {
  const app = createApp();
  app.window.CORPUS_UTILS.dismissAllToasts();
  app.window.CORPUS_ACTIONS.clearFinished();
  return app;
}

/* ---------------------------------------------------------------- success */

test('A. success: the control reports the work, is restored, and one success toast appears', async () => {
  const app = freshApp();
  const btn = makeButton(app);

  let release;
  const outcomePromise = app.window.CORPUS_ACTIONS.run({
    name: 'Save settings',
    element: btn,
    label: 'Saving…',
    success: 'Settings saved successfully!',
    run: () => new Promise((resolve) => { release = resolve; }),
  });

  // Immediately: the user sees what is happening and cannot press it again.
  assert.match(btn.textContent, /Saving…/);
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.equal(btn.getAttribute('data-busy'), 'true');
  assert.doesNotMatch(btn.textContent, /Save$/);

  await tick(0);
  assert.equal(typeof release, 'function', 'the work started');
  release({ ok: true });
  const outcome = await outcomePromise;

  assert.equal(outcome.state, 'success');
  assert.equal(outcome.ok, true);
  // Restored to the exact markup it had, including the icon.
  assert.equal(btn.innerHTML, '<i class="fas fa-save"></i> Save');
  assert.equal(btn.hasAttribute('data-busy'), false);
  assert.equal(btn.hasAttribute('aria-busy'), false);
  const success = toasts(app, 'success');
  assert.equal(success.length, 1, 'exactly one success notification');
  assert.match(success[0].textContent, /Settings saved successfully!/);
  assert.equal(success[0].querySelector('.fa-check-circle') !== null, true, 'green tick icon');
});

/* ---------------------------------------------------------------- failure */

test('B. failed request: the backend error is shown once and the control is restored', async () => {
  const app = freshApp();
  const btn = makeButton(app, '<i class="fas fa-trash"></i> Delete');

  const outcome = await app.window.CORPUS_ACTIONS.run({
    name: 'Delete model',
    element: btn,
    label: 'Deleting…',
    success: 'Model deleted successfully!',
    failure: 'Delete failed.',
    run: async () => { throw Object.assign(new Error('Model is used by an active job'), { status: 409 }); },
  });

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.ok, false);
  assert.equal(btn.innerHTML, '<i class="fas fa-trash"></i> Delete');
  const errors = toasts(app, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].textContent, /Model is used by an active job/);
  assert.equal(toasts(app, 'success').length, 0, 'a failure is never reported as a success');
});

test('C. network disconnected: the user is told the request could not reach the backend', async () => {
  const app = freshApp();
  const btn = makeButton(app);

  const outcome = await app.window.CORPUS_ACTIONS.run({
    name: 'Create model',
    element: btn,
    label: 'Creating…',
    run: async () => { throw new TypeError('Failed to fetch'); },
  });

  assert.equal(outcome.state, 'failed');
  assert.match(toasts(app, 'error')[0].textContent, /Failed to fetch/);
  assert.equal(btn.hasAttribute('data-busy'), false);
});

test('D. timeout: a request that never answers ends the action instead of spinning forever', async () => {
  const app = freshApp();
  const btn = makeButton(app);

  const outcome = await app.window.CORPUS_ACTIONS.run({
    name: 'Save checkpoint',
    element: btn,
    label: 'Saving…',
    timeoutMs: 25,
    run: () => new Promise(() => {}),      // never resolves, never rejects
  });

  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /timed out/i);
  assert.equal(btn.hasAttribute('data-busy'), false);
  assert.match(toasts(app, 'error')[0].textContent, /timed out/i);
});

/* ------------------------------------------------------------- navigation */

test('E. navigating away cancels the action quietly and restores the control', async () => {
  const app = freshApp();
  const btn = makeButton(app);

  const promise = app.window.CORPUS_ACTIONS.run({
    name: 'Upload dataset',
    element: btn,
    label: 'Uploading…',
    run: (ctx) => new Promise((resolve, reject) => {
      if (!ctx.signal) return reject(new Error('no signal'));
      ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });

  assert.match(btn.textContent, /Uploading…/);
  app.window.dispatchEvent(new app.window.Event('hashchange'));   // leave the page
  const outcome = await promise;

  assert.equal(outcome.state, 'cancelled');
  assert.equal(btn.innerHTML, '<i class="fas fa-save"></i> Save');
  assert.equal(toasts(app, 'error').length, 0, 'a cancelled action is not an error');
  assert.equal(toasts(app, 'success').length, 0);
});

/* ------------------------------------------------------------- double press */

test('F. double click: one execution, one request, one notification', async () => {
  const app = freshApp();
  const btn = makeButton(app);
  let executions = 0;

  const first = app.window.CORPUS_ACTIONS.run({
    name: 'Create API key',
    element: btn,
    label: 'Creating…',
    success: 'API key created successfully!',
    run: async () => { executions += 1; await tick(20); return { key: 'abc' }; },
  });
  const second = app.window.CORPUS_ACTIONS.run({
    name: 'Create API key',
    element: btn,
    label: 'Creating…',
    success: 'API key created successfully!',
    run: async () => { executions += 1; return { key: 'duplicate' }; },
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(executions, 1, 'the work ran once');
  assert.equal(a, b, 'both presses resolve to the same outcome');
  assert.equal(a.state, 'success');
  assert.equal(toasts(app, 'success').length, 1, 'one confirmation, not two');
});

test('F2. a busy control does not fire its click handler again', async () => {
  const app = freshApp();
  const btn = makeButton(app);
  let clicks = 0;
  btn.addEventListener('click', () => { clicks += 1; });

  app.window.CORPUS_ACTIONS.beginButton(btn, 'Working…');
  btn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(clicks, 0, 'the press never reaches the page handler');
  app.window.CORPUS_ACTIONS.resetButton(btn);
  btn.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(clicks, 1, 'and it works again once restored');
});

/* --------------------------------------------------- background job states */

test('G. accepted background job is queued — not reported as completed', async () => {
  const app = freshApp();
  const job = { id: 'job_1', status: 'queued', model_id: 'model_1', dataset_id: 'ds_uploaded' };

  const op = app.window.CORPUS_ACTIONS.syncJob(job, { name: 'Training Corpus Small' });
  assert.ok(op, 'operation was recorded');
  assert.equal(op.state, 'queued');
  assert.ok(app.window.CORPUS_ACTIONS.BUSY.has('queued'));
  assert.equal(toasts(app, 'success').length, 0, 'acceptance is not completion');
});

test('H. a job that completes later reports Completed exactly once, with its result', async () => {
  const app = freshApp();
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_2', status: 'queued' }, { name: 'Training run' });
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_2', status: 'running' }, { name: 'Training run' });

  assert.equal(toasts(app, 'success').length, 0, 'still running: nothing to announce');

  // WebSocket says completed…
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_2', status: 'completed' }, { name: 'Training run' });
  // …and the polling fallback says the same thing afterwards.
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_2', status: 'completed' }, { name: 'Training run' });

  const op = app.window.CORPUS_ACTIONS.getOperation('job-job_2');
  assert.equal(op.state, 'completed');
  assert.ok(op.endedAt, 'completion time recorded');
  const success = toasts(app, 'success');
  assert.equal(success.length, 1, 'duplicate completion events collapse into one notification');
});

test('I. a failed background job records the failure and does not look finished', async () => {
  const app = freshApp();
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_3', status: 'running' }, { name: 'Training run' });
  app.window.CORPUS_ACTIONS.syncJob(
    { id: 'job_3', status: 'failed', error: 'CUDA out of memory' },
    { name: 'Training run' }
  );

  const op = app.window.CORPUS_ACTIONS.getOperation('job-job_3');
  assert.equal(op.state, 'failed');
  assert.match(op.error, /CUDA out of memory/);
  assert.equal(toasts(app, 'success').length, 0);
});

test('J. the WebSocket drops during completion and polling still settles the job once', async () => {
  const app = freshApp();
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_4', status: 'running' }, { name: 'Training run' });
  // The stream is gone; the poll returns the terminal state twice (it retried).
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_4', status: 'completed' }, { name: 'Training run' });
  app.window.CORPUS_ACTIONS.syncJob({ id: 'job_4', status: 'completed' }, { name: 'Training run' });

  assert.equal(toasts(app, 'success').length, 1);
  const op = app.window.CORPUS_ACTIONS.getOperation('job-job_4');
  assert.equal(op.state, 'completed');
  // A terminal state is final: a stale "running" event cannot revive it.
  app.window.CORPUS_ACTIONS.updateOperation('job-job_4', { state: 'running' });
  assert.equal(app.window.CORPUS_ACTIONS.getOperation('job-job_4').state, 'completed');
});

/* --------------------------------------------------- button/state integrity */

test('two actions on one control do not steal each other\'s state', async () => {
  const app = freshApp();
  const btn = makeButton(app, '<i class="fas fa-check"></i> Apply');
  let releaseFirst;
  let releaseSecond;

  const first = app.window.CORPUS_ACTIONS.run({
    name: 'First',
    key: 'first',
    element: btn,
    label: 'First…',
    silent: true,
    run: () => new Promise((resolve) => { releaseFirst = resolve; }),
  });
  const second = app.window.CORPUS_ACTIONS.run({
    name: 'Second',
    key: 'second',
    element: btn,
    label: 'Second…',
    silent: true,
    run: () => new Promise((resolve) => { releaseSecond = resolve; }),
  });

  await tick(0);
  releaseFirst();
  await first;
  // The outer action is still running: the control must stay busy.
  assert.equal(btn.getAttribute('data-busy'), 'true');

  releaseSecond();
  await second;
  assert.equal(btn.innerHTML, '<i class="fas fa-check"></i> Apply');
  assert.equal(btn.hasAttribute('data-busy'), false);
});

test('setButtonLoading restores markup even when a page enables it twice', async () => {
  const app = freshApp();
  const btn = makeButton(app, '<i class="fas fa-upload"></i> Upload');
  app.window.ui.setButtonLoading(btn, true, 'Uploading…');
  app.window.ui.setButtonLoading(btn, true, 'Uploading…');
  assert.match(btn.textContent, /Uploading…/);
  app.window.ui.setButtonLoading(btn, false);
  assert.equal(btn.innerHTML, '<i class="fas fa-upload"></i> Upload');
  assert.equal(btn.hasAttribute('data-busy'), false);
});

test('a page that owns disabled state keeps it: actions never rewrite it', async () => {
  const app = freshApp();
  const btn = makeButton(app, 'Start Training');
  btn.disabled = true;                     // page logic decided this

  const outcome = await app.window.CORPUS_ACTIONS.run({
    name: 'Start training',
    element: btn,
    label: 'Starting…',
    silent: true,
    run: async () => 'ok',
  });

  assert.equal(outcome.state, 'success');
  assert.equal(btn.disabled, true, 'still disabled because the page disabled it');
  assert.equal(btn.textContent, 'Start Training');
});

/* ------------------------------------------------------- operation centre */

test('the operation centre records real timings, progress and results', async () => {
  const app = freshApp();
  const op = app.window.CORPUS_ACTIONS.beginOperation({ kind: 'upload', name: 'Upload corpus.txt', state: 'processing' });
  app.window.CORPUS_ACTIONS.updateOperation(op.id, { progress: 42 });
  app.window.CORPUS_ACTIONS.finishOperation(op.id, 'completed', { result: 'Upload completed successfully!' });

  const stored = app.window.CORPUS_ACTIONS.getOperation(op.id);
  assert.equal(stored.state, 'completed');
  assert.equal(stored.progress, 100);
  assert.match(stored.result, /Upload completed successfully!/);
  assert.ok(stored.startedAt && stored.endedAt);

  // It is listed for the user, with a readable state, and can be cleared.
  const panel = app.doc.getElementById('operation-center');
  assert.ok(panel, 'operation centre exists');
  const list = app.doc.getElementById('operation-list');
  assert.match(list.textContent, /Upload corpus\.txt/);
  assert.match(list.textContent, /Completed/);
  app.window.CORPUS_ACTIONS.clearFinished();
  assert.equal(app.window.CORPUS_ACTIONS.operations().length, 0);
  assert.match(app.doc.getElementById('operation-list').textContent, /No operations yet/);
});

test('an operation is settled once: a second finish call is a no-op', async () => {
  const app = freshApp();
  const op = app.window.CORPUS_ACTIONS.beginOperation({ name: 'Export workspace', state: 'processing' });
  app.window.CORPUS_ACTIONS.finishOperation(op.id, 'completed', { result: 'Export completed successfully!' });
  app.window.CORPUS_ACTIONS.finishOperation(op.id, 'failed', { error: 'late error' });
  assert.equal(app.window.CORPUS_ACTIONS.getOperation(op.id).state, 'completed');
  assert.equal(toasts(app, 'success').length, 1);
  assert.equal(toasts(app, 'error').length, 0);
});

/* ------------------------------------------------------------ api wiring */

test('the API cache is invalidated by a write, so the refreshed page shows the change', async () => {
  const app = freshApp();
  const api = app.window.CORPUS_API;
  const token = 'test-token';
  app.net.models.push({ id: 'model_cached', name: 'Cached model' });

  await api.listModels(token);
  const before = app.net.calls.length;
  await api.listModels(token);
  assert.equal(app.net.calls.length, before, 'the repeat read is served from the cache');

  await api.deleteModel('model_cached', token);
  const afterWrite = app.net.calls.length;
  const models = await api.listModels(token);
  assert.equal(app.net.calls.length, afterWrite + 1, 'the write dropped the cache entry');
  assert.equal(models.some((model) => model.id === 'model_cached'), false, 'the list reflects the delete');
});

/* ------------------------------------------------------- real page wiring */

test('creating a model through the real page confirms once and restores the button', async () => {
  const app = freshApp();
  await app.window.models.render();
  app.window.models.openCreateModal();

  const nameInput = app.doc.getElementById('m-name');
  assert.ok(nameInput, 'create form is open');
  nameInput.value = 'Feedback model';

  const form = app.doc.getElementById('model-form');
  const submit = app.doc.querySelector('#model-form button[type="submit"]');
  const original = submit.innerHTML;
  const pending = app.window.models.handleCreateSubmit(new app.window.Event('submit'));
  assert.match(submit.textContent, /Creating…/, 'the button says what it is doing immediately');
  assert.equal(submit.getAttribute('data-busy'), 'true');
  submit.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await tick(10);
  assert.equal(
    app.net.calls.filter((call) => call.method === 'POST' && call.route === '/api/v1/models').length,
    1,
    'a second press made no second request'
  );

  await pending;
  await tick(20);
  assert.equal(
    app.net.calls.filter((call) => call.method === 'POST' && call.route === '/api/v1/models').length,
    1,
    'exactly one create request in total'
  );

  assert.equal(submit.innerHTML, original, 'the label and icon are back');
  assert.equal(submit.hasAttribute('data-busy'), false);
  assert.equal(submit.hasAttribute('aria-busy'), false);
  const success = toasts(app, 'success').filter((el) => /Model created successfully!/.test(el.textContent));
  assert.equal(success.length, 1, 'exactly one confirmation');
  assert.ok(
    app.window.state.getModels().some((model) => model.name === 'Feedback model'),
    'state updated immediately from the backend response'
  );
});

test('training: the accepted job runs queued → completed with one notification, using the real module', async () => {
  const app = createApp(datasetFixtures());
  app.window.CORPUS_UTILS.dismissAllToasts();
  app.window.CORPUS_ACTIONS.clearFinished();
  try {
    await app.window.training.render();

    app.doc.getElementById('t-model').value = 'model_1';
    const select = app.doc.getElementById('t-dataset');
    select.value = 'ds_uploaded';
    select.dispatchEvent(new app.window.Event('change'));

    await app.window.training.startTraining();
    await tick(10);

    const job = app.window.state.getTrainingJobs()[0];
    assert.ok(job, 'a job was created');
    const op = app.window.CORPUS_ACTIONS.getOperation('job-' + job.id);
    assert.ok(op, 'the job is tracked as an operation');
    assert.ok(['queued', 'running'].includes(op.state), 'acceptance is not completion');
    assert.equal(
      toasts(app, 'success').filter((el) => /completed successfully/i.test(el.textContent)).length,
      0,
      'a queued job is not announced as finished'
    );

    // The worker finishes; the monitor learns about it over the live stream.
    const socket = app.WebSocketStub.opened[app.WebSocketStub.opened.length - 1];
    assert.ok(socket, 'a live stream was opened for the job');
    const event = {
      data: JSON.stringify({
        type: 'training.' + job.id,
        event: 'status',
        data: { job_id: job.id, status: 'completed', model_id: 'model_1', dataset_id: 'ds_uploaded' },
      }),
    };
    socket.onmessage(event);
    await tick(20);

    const settled = app.window.CORPUS_ACTIONS.getOperation('job-' + job.id);
    assert.equal(settled.state, 'completed');
    const completedToasts = () =>
      toasts(app, 'success').filter((el) => /Training .* completed successfully!/i.test(el.textContent));
    assert.equal(completedToasts().length, 1, 'one completion notification');

    // A duplicated event (the polling fallback catching up) must stay silent.
    socket.onmessage(event);
    await tick(20);
    assert.equal(completedToasts().length, 1, 'no duplicate notification');
  } finally {
    app.window.training.dispose();
  }
});
