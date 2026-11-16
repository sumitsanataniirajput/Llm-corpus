/**
 * AI Models delete flow regression tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp, datasetFixtures } from './harness.mjs';

test('confirming delete sends authenticated DELETE, updates state, clears active model, and refreshes list', async () => {
  const app = createApp(datasetFixtures());
  app.window.state.setActiveModel(app.net.models[0]);
  await app.window.models.render();

  const deleteBtn = app.doc.querySelector('[data-delete-model="model_1"]');
  assert.ok(deleteBtn, 'delete button has data-delete-model attribute');
  assert.match(deleteBtn.getAttribute('aria-label'), /Corpus Small/);

  deleteBtn.click();
  const dialog = app.doc.getElementById('confirm-dialog');
  assert.equal(dialog.classList.contains('hidden'), false, 'confirm dialog opens');

  app.net.calls.length = 0;
  await app.doc.getElementById('confirm-ok').click();
  await new Promise((r) => setTimeout(r, 20));

  const deletes = app.net.calls.filter((c) => c.method === 'DELETE' && c.route === '/api/v1/models/model_1');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].headers.Authorization, 'Bearer test-token');
  assert.equal(app.window.state.getActiveModel(), null, 'active model cleared when deleted');
  assert.equal(app.doc.querySelectorAll('[data-delete-model="model_1"]').length, 0);
  assert.match(app.doc.getElementById('toast-container').textContent, /Model deleted/i);
});

test('canceling confirmation dialog does not send DELETE', async () => {
  const app = createApp(datasetFixtures());
  await app.window.models.render();

  app.doc.querySelector('[data-delete-model="model_1"]').click();
  app.net.calls.length = 0;
  app.doc.querySelector('#confirm-dialog .modal-close').click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(app.net.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(app.doc.querySelectorAll('[data-delete-model="model_1"]').length, 1);
});

test('double-clicking confirm or delete while in flight sends only one DELETE', async () => {
  const app = createApp(datasetFixtures());
  let resolveDelete;
  app.net.deleteModelHandler = ({ id, state, jsonResponse }) => new Promise((resolve) => {
    resolveDelete = () => {
      state.models = state.models.filter((m) => m.id !== id);
      resolve(jsonResponse({ ok: true, model_id: id }));
    };
  });

  await app.window.models.render();
  app.doc.querySelector('[data-delete-model="model_1"]').click();
  app.net.calls.length = 0;

  const okBtn = app.doc.getElementById('confirm-ok');
  okBtn.click();
  okBtn.click();
  app.doc.querySelector('[data-delete-model="model_1"]').click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(app.net.calls.filter((c) => c.method === 'DELETE').length, 1);
  resolveDelete();
  await new Promise((r) => setTimeout(r, 20));
});

test('403 Not authorized keeps model in UI and surfaces clear error toast', async () => {
  const app = createApp(datasetFixtures());
  app.net.deleteModelHandler = ({ jsonResponse }) => jsonResponse({ detail: 'Not authorized' }, 403);
  await app.window.models.render();

  app.doc.querySelector('[data-delete-model="model_1"]').click();
  await app.doc.getElementById('confirm-ok').click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(app.doc.querySelectorAll('[data-delete-model="model_1"]').length, 1);
  assert.match(app.doc.getElementById('toast-container').textContent, /Not authorized/i);
});

test('409 active training conflict prompts user and retries with stop_active=true', async () => {
  const app = createApp(datasetFixtures());
  app.net.deleteModelHandler = ({ id, stopActive, state, jsonResponse }) => {
    if (!stopActive) {
      return jsonResponse({ detail: 'Model has an active training job.' }, 409);
    }
    state.models = state.models.filter((m) => m.id !== id);
    return jsonResponse({ ok: true, model_id: id });
  };

  await app.window.models.render();
  app.doc.querySelector('[data-delete-model="model_1"]').click();
  app.net.calls.length = 0;

  // First confirm sends DELETE without stop_active -> 409 opens second confirm dialog.
  await app.doc.getElementById('confirm-ok').click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(app.doc.getElementById('confirm-dialog').classList.contains('hidden'), false);
  assert.match(app.doc.getElementById('confirm-title').textContent, /Active training/i);

  // Confirming stop & delete sends ?stop_active=true and removes the model.
  await app.doc.getElementById('confirm-ok').click();
  await new Promise((r) => setTimeout(r, 20));

  const stopCall = app.net.calls.find((c) => c.method === 'DELETE' && c.url.includes('stop_active=true'));
  assert.ok(stopCall, 'second DELETE passed stop_active=true');
  assert.equal(app.doc.querySelectorAll('[data-delete-model="model_1"]').length, 0);
});
