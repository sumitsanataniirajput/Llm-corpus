/** Phase 2 — persistent active model, chat selector and Prediction Lab wiring. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './harness.mjs';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRA_MODULES = ['js/chat.js', 'js/prediction.js'];
const MODELS = [
  { id: 'model_trained', name: 'Trained corpus', status: 'trained', config: {} },
  { id: 'model_idle', name: 'Fresh corpus', status: 'idle', config: {} },
];

const openApps = [];
after(() => {
  while (openApps.length) {
    const app = openApps.pop();
    try { app.dom.window.close(); } catch (e) { /* already closed */ }
  }
});

function boot(options = {}) {
  const app = createApp({ models: MODELS, ...options });
  for (const rel of EXTRA_MODULES) {
    app.window.eval(fs.readFileSync(path.join(FRONTEND, rel), 'utf8'));
  }
  openApps.push(app);
  return app;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('state persists the active model per account and restores it after models load', async () => {
  const app = boot();
  const state = app.window.state;
  app.window.localStorage.setItem('corpus:active-model:v1:user-1', 'model_trained');
  state.setUser({ id: 'user-1', email: 'tester@example.com' });

  // The id is remembered even before the model list arrives.
  assert.equal(state.getActiveModel(), null);
  await state.ensureModels();
  assert.equal(state.getActiveModel().id, 'model_trained');

  state.setActiveModel(MODELS[1]);
  assert.equal(app.window.localStorage.getItem('corpus:active-model:v1:user-1'), 'model_idle');
  state.setActiveModel(null);
  assert.equal(app.window.localStorage.getItem('corpus:active-model:v1:user-1'), null);
});

test('chat renders a model selector with checkpoint readiness and updates without a repaint', async () => {
  const app = boot();
  await app.window.chat.render();

  const select = app.doc.getElementById('chat-model-select');
  assert.ok(select, 'chat model selector exists');
  assert.equal(select.options.length, 3);
  assert.match(select.textContent, /Trained corpus · trained/);
  assert.match(select.textContent, /Fresh corpus · no checkpoint/);

  const input = app.doc.getElementById('chat-input');
  input.value = 'hello';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  input.focus();

  app.window.chat.selectModel('model_trained');
  assert.equal(app.window.state.getActiveModel().id, 'model_trained');
  assert.match(app.doc.getElementById('chat-model-readiness').textContent, /Checkpoint ready/);
  assert.equal(app.doc.getElementById('chat-send').disabled, false);
  assert.equal(app.doc.activeElement, input, 'selector did not repaint the composer');
  assert.equal(input.value, 'hello');
  assert.equal(app.doc.getElementById('chat-no-model').classList.contains('hidden'), true);

  app.window.chat.selectModel('model_idle');
  assert.match(app.doc.getElementById('chat-model-readiness').textContent, /No checkpoint/);
  assert.equal(app.window.localStorage.getItem('corpus:active-model:v1:user-1'), 'model_idle');
});

test('Prediction Lab has its own model selector and calls the mounted inference route', async () => {
  const app = boot();
  app.window.state.setActiveModel(MODELS[0]);
  await app.window.prediction.render();

  const select = app.doc.getElementById('pred-model-select');
  assert.ok(select, 'Prediction Lab selector exists');
  assert.equal(select.value, 'model_trained');
  app.window.prediction.selectModel('model_idle');
  assert.equal(app.window.state.getActiveModel().id, 'model_idle');
  assert.equal(select.value, 'model_idle');

  app.doc.getElementById('pred-text').value = 'ab';
  let nextTokenArgs = null;
  const realNextToken = app.window.CORPUS_API.nextToken;
  app.window.CORPUS_API.nextToken = async (...args) => {
    nextTokenArgs = args;
    return {
      status: 'available',
      predictions: [{ token: 'a', id: 4, probability: 0.91, logit: 100, rank: 1 }],
      tokens: [{ token: 'a', id: 4 }, { token: 'b', id: 5 }],
    };
  };
  await app.window.prediction.runPrediction();
  await tick();
  assert.ok(nextTokenArgs, 'nextToken was called');
  assert.equal(nextTokenArgs[0], 'model_idle');
  assert.match(app.doc.getElementById('pred-results').textContent, /a/);
  assert.match(app.doc.getElementById('pred-tokenization').textContent, /#4/);

  // Restore the real API client to prove the mounted route, not the stub.
  app.window.CORPUS_API.nextToken = realNextToken;
  await assert.rejects(
    () => app.window.CORPUS_API.nextToken('model_trained', { text: 'ab' }, 'test-token')
  ).catch(() => {});
  await tick();
  assert.equal(
    app.net.calls.some((call) => call.route === '/api/v1/inference/predict/model_trained'),
    true
  );
  await assert.rejects(
    () => app.window.CORPUS_API.tokenize('model_trained', 'ab', 'test-token')
  ).catch(() => {});
  await tick();
  assert.equal(
    app.net.calls.some((call) => call.route === '/api/v1/inference/tokenize/model_trained'),
    true
  );
});

test('chat surfaces an explicit checkpoint-unavailable message from the backend', async () => {
  const app = boot();
  app.window.state.setActiveModel(MODELS[0]);
  await app.window.chat.render();
  app.window.CORPUS_API.infer = async () => ({
    status: 'unavailable', response: '', message: 'Train it first to generate real responses.',
  });
  app.doc.getElementById('chat-input').value = 'hello';
  await app.window.chat.sendMessage();
  await tick();
  assert.match(app.doc.getElementById('chat-messages').textContent, /Train it first/);
});
