/** P2 — Supabase access tokens must never appear in WebSocket URLs. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './harness.mjs';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = fs.readFileSync(path.join(FRONTEND, 'js/api.js'), 'utf8');
const trainingWs = fs.readFileSync(
  path.resolve(FRONTEND, '..', 'backend', 'app', 'api', 'endpoints', 'training.py'), 'utf8'
);
const inferenceWs = fs.readFileSync(
  path.resolve(FRONTEND, '..', 'backend', 'app', 'api', 'endpoints', 'inference.py'), 'utf8'
);
const socketAuth = fs.readFileSync(
  path.resolve(FRONTEND, '..', 'backend', 'app', 'core', 'websocket_auth.py'), 'utf8'
);

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
  app.WebSocketStub.opened.length = 0;
  return app;
}

test('no WebSocket client builds a ?token= URL', () => {
  assert.doesNotMatch(apiSource, /new WebSocket\([^)]*\?token=/);
  assert.doesNotMatch(apiSource, /\+ '\?token=' \+ encodeURIComponent/);
  assert.match(apiSource, /type: 'auth', token: resolvedToken/);
  assert.match(apiSource, /type: 'auth', token/);
});

test('backend sockets share the first-frame auth helper, not a query token', () => {
  assert.doesNotMatch(trainingWs, /token: Optional\[str\] = Query\(default=None\)/);
  assert.match(trainingWs, /authenticate_socket\(websocket\)/);
  assert.match(inferenceWs, /authenticate_socket\(websocket\)/);
  assert.match(socketAuth, /receive_json\(\), timeout=timeout\)/);
  assert.match(socketAuth, /frame\.get\("token"\)/);
  assert.match(socketAuth, /verify_supabase_token\(token\)/);
});

test('inferStream uses the real /ws route and authenticates in-band', async () => {
  const app = freshApp();
  const socket = await app.window.CORPUS_API.inferStream(
    'model_1', { text: 'hello' }, () => {}, () => {}, () => {}, 'secret-token'
  );
  assert.match(socket.url, /\/api\/v1\/inference\/model_1\/ws$/);
  assert.doesNotMatch(socket.url, /token=/);
  socket.onopen();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'auth', token: 'secret-token' });
  assert.deepEqual(JSON.parse(socket.sent[1]), { text: 'hello' });
});

test('connectWS authenticates in-band, not through the legacy query string', async () => {
  const app = freshApp();
  await app.window.CORPUS_API.connectWS('secret-token', () => {}, () => {});
  const socket = app.WebSocketStub.opened[0];
  assert.ok(socket);
  assert.match(socket.url, /\/api\/v1\/ws$/);
  assert.doesNotMatch(socket.url, /token=/);
  socket.onopen();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'auth', token: 'secret-token' });
  app.window.CORPUS_API.disconnectWS();
});
