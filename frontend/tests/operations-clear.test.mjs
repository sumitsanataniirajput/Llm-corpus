/**
 * Phase 7 / P1 — Operations Clear & Clear All.
 *
 * A visible control is not enough: each row must really remove its own
 * operation, active work must be cancelled rather than orphaned, and "Clear
 * all" must be confirmed before it destroys the whole history.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, tick } from './harness.mjs';

const openApps = [];
after(() => {
  while (openApps.length) {
    const app = openApps.pop();
    try { app.dom.window.close(); } catch (e) { /* already closed */ }
  }
});

function freshApp() {
  const app = createApp();
  openApps.push(app);
  app.window.CORPUS_UTILS.dismissAllToasts();
  app.window.CORPUS_ACTIONS.clearFinished();
  return app;
}

function operationList(app) {
  return app.doc.getElementById('operation-list');
}

function makeButton(app) {
  const btn = app.doc.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Start';
  app.doc.getElementById('page-container').appendChild(btn);
  return btn;
}

test('the Operations panel exposes both Clear finished and Clear all', () => {
  const app = freshApp();
  assert.ok(app.doc.getElementById('operation-clear'), 'Clear finished exists');
  assert.ok(app.doc.getElementById('operation-clear-all'), 'Clear all exists');
  assert.equal(
    app.window.CORPUS_ACTIONS.clearAll(),
    false,
    'an empty list has nothing to confirm or clear'
  );
});

test('a row Clear button removes only that operation and persists the change', () => {
  const app = freshApp();
  const a = app.window.CORPUS_ACTIONS.beginOperation({ name: 'First upload', state: 'processing' });
  app.window.CORPUS_ACTIONS.finishOperation(a.id, 'completed', { result: 'Done.' });
  const b = app.window.CORPUS_ACTIONS.beginOperation({ name: 'Second upload', state: 'processing' });
  app.window.CORPUS_ACTIONS.finishOperation(b.id, 'completed', { result: 'Done.' });

  const clearA = operationList(app).querySelector('[data-operation-clear="' + a.id + '"]');
  assert.ok(clearA, 'each finished row has its own Clear control');
  clearA.click();

  const remaining = app.window.CORPUS_ACTIONS.operations();
  assert.equal(remaining.length, 1, 'only one operation was removed');
  assert.equal(remaining[0].id, b.id);
  assert.equal(app.window.CORPUS_ACTIONS.getOperation(a.id), null);
  assert.doesNotMatch(operationList(app).textContent, /First upload/);
  assert.match(operationList(app).textContent, /Second upload/);

  const stored = JSON.parse(app.window.localStorage.getItem('corpus:operations:v1'));
  assert.equal(stored.length, 1, 'localStorage reflects the removal');
  assert.equal(stored[0].id, b.id);
});

test('a row Cancel button settles an active operation without deleting it', () => {
  const app = freshApp();
  const op = app.window.CORPUS_ACTIONS.beginOperation({ name: 'Long export', state: 'processing' });
  const cancelBtn = operationList(app).querySelector('[data-operation-cancel="' + op.id + '"]');
  assert.ok(cancelBtn, 'active rows offer Cancel');
  cancelBtn.click();

  const settled = app.window.CORPUS_ACTIONS.getOperation(op.id);
  assert.equal(settled.state, 'cancelled');
  assert.match(settled.result, /Cancelled from the Operations panel/);
  assert.ok(settled.endedAt, 'the cancelled operation has a finish time');
  assert.match(operationList(app).textContent, /Cancelled/);
});

test('clearing an active row cancels its real work before removing it', async () => {
  const app = freshApp();
  const btn = makeButton(app);
  let aborted = false;
  const promise = app.window.CORPUS_ACTIONS.run({
    name: 'Never ending',
    key: 'never-ending',
    track: true,
    element: btn,
    run: (ctx) => new Promise((resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
        const err = new Error('Cancelled');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  await tick(0);

  const op = app.window.CORPUS_ACTIONS.operations().find(o => o.name === 'Never ending');
  assert.ok(op, 'the tracked operation is listed');
  assert.equal(op.key, 'never-ending', 'the operation remembers its dedupe key');
  const clearBtn = operationList(app).querySelector('[data-operation-clear="' + op.id + '"]');
  assert.ok(clearBtn, 'active rows also have a per-operation Clear');
  clearBtn.click();

  const outcome = await promise;
  assert.equal(aborted, true, 'the underlying AbortController was aborted');
  assert.equal(outcome.state, 'cancelled');
  assert.equal(app.window.CORPUS_ACTIONS.getOperation(op.id), null);
  assert.equal(app.window.CORPUS_ACTIONS.operations().length, 0);
});

test('Clear all waits for confirmation, then cancels active work and empties the list', async () => {
  const app = freshApp();
  const finished = app.window.CORPUS_ACTIONS.beginOperation({ name: 'Old upload', state: 'processing' });
  app.window.CORPUS_ACTIONS.finishOperation(finished.id, 'completed', { result: 'Done.' });

  const btn = makeButton(app);
  let aborted = false;
  const promise = app.window.CORPUS_ACTIONS.run({
    name: 'Still running',
    key: 'still-running',
    track: true,
    element: btn,
    run: (ctx) => new Promise((resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
        const err = new Error('Cancelled');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  await tick(0);
  assert.equal(app.window.CORPUS_ACTIONS.operations().length, 2);

  app.doc.getElementById('operation-clear-all').click();
  const dialog = app.doc.getElementById('confirm-dialog');
  assert.equal(dialog.classList.contains('hidden'), false, 'confirmation is shown');
  assert.equal(app.window.CORPUS_ACTIONS.operations().length, 2, 'nothing is cleared yet');

  // Dismissing the dialog must not clear anything.
  dialog.querySelector('.modal-backdrop').click();
  assert.equal(dialog.classList.contains('hidden'), true);
  assert.equal(app.window.CORPUS_ACTIONS.operations().length, 2);

  app.doc.getElementById('operation-clear-all').click();
  app.doc.getElementById('confirm-ok').click();

  const outcome = await promise;
  assert.equal(aborted, true, 'active work was cancelled by Clear all');
  assert.equal(outcome.state, 'cancelled');
  assert.equal(app.window.CORPUS_ACTIONS.operations().length, 0);
  assert.equal(app.window.localStorage.getItem('corpus:operations:v1'), '[]');
  assert.match(operationList(app).textContent, /No operations yet/);
});

test('Clear finished still clears only terminal operations', () => {
  const app = freshApp();
  const done = app.window.CORPUS_ACTIONS.beginOperation({ name: 'Done', state: 'processing' });
  app.window.CORPUS_ACTIONS.finishOperation(done.id, 'completed', { result: 'Done.' });
  const active = app.window.CORPUS_ACTIONS.beginOperation({ name: 'Active', state: 'processing' });

  app.doc.getElementById('operation-clear').click();
  assert.equal(app.window.CORPUS_ACTIONS.getOperation(done.id), null);
  assert.ok(app.window.CORPUS_ACTIONS.getOperation(active.id), 'active work is untouched');
});
