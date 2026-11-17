/**
 * Session-survival and upload-resilience regression tests.
 *
 * Reported symptoms:
 *   1. "After uploading a dataset, or reloading, I get bounced to the dashboard
 *      or the login screen as if I had just signed in."
 *   2. "The upload does not complete successfully."
 *
 * Causes covered here:
 *   - a backend 401 used to clear the Supabase session even while that session
 *     was perfectly valid (the "backend misconfigured" error was thrown inside
 *     the very try block meant to detect it, so its own catch wiped the user);
 *   - a Supabase SIGNED_IN event re-emitted on session restore forced
 *     router.navigate('dashboard'), losing the page the user was on;
 *   - uploads had no timeout and no token refresh, so a long transfer on a
 *     phone failed with a bare "Upload failed" and no recovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp, datasetFixtures } from './harness.mjs';

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function setFiles(app, input, names) {
  const files = names.map((name) => new app.window.File([`content of ${name}`], name, { type: 'text/plain' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new app.window.Event('change'));
  return files;
}

test('a backend 401 never signs out a user whose Supabase session is valid', async () => {
  const app = createApp(datasetFixtures());
  assert.ok(app.window.state.getUser(), 'precondition: signed in');

  app.window.fetch = async () => jsonResponse({ detail: 'Authentication required' }, 401);

  await assert.rejects(
    () => app.window.CORPUS_API.listDatasets(),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.backendAuthError, true, 'flagged as a backend auth problem, not a logout');
      assert.match(err.message, /backend rejected your session/i);
      assert.match(err.message, /still valid/i);
      return true;
    }
  );

  assert.ok(app.window.state.getUser(), 'the user must stay signed in');
  assert.equal(app.window.state.getUser().id, 'user-1');
});

test('a 401 with no Supabase session does end the session with a clear message', async () => {
  const app = createApp(datasetFixtures());
  app.window.CORPUS_SUPABASE.getSession = async () => ({ data: { session: null }, error: null });
  app.window.fetch = async () => jsonResponse({ detail: 'Authentication required' }, 401);

  await assert.rejects(
    () => app.window.CORPUS_API.listDatasets(),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.sessionExpired, true);
      assert.match(err.message, /session has ended/i);
      return true;
    }
  );
  assert.equal(app.window.state.getUser(), null, 'user cleared only when Supabase has no session');
});

test('a 401 on an idempotent GET refreshes the token and retries once', async () => {
  const app = createApp(datasetFixtures());
  let attempts = 0;
  let rotated = 0;
  app.window.CORPUS_SUPABASE.getSession = async () => ({
    data: { session: { access_token: 'tok-' + (++rotated), user: { id: 'user-1' } } },
  });
  app.window.fetch = async (url, opts = {}) => {
    attempts += 1;
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    if (attempts === 1) {
      assert.match(auth, /tok-\d+$/);
      return jsonResponse({ detail: 'Authentication required' }, 401);
    }
    assert.ok(!/tok-1$/.test(auth), 'the retry must use the refreshed token');
    return jsonResponse(datasetFixtures().datasets);
  };

  const data = await app.window.CORPUS_API.listDatasets();
  assert.equal(attempts, 2, 'exactly one retry');
  assert.equal(data.length, datasetFixtures().datasets.length);
  assert.ok(app.window.state.getUser(), 'still signed in');
});

test('an upload that is rejected with 401 refreshes the token and retries without a new dataset record', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();
  app.doc.getElementById('datasets-name').value = 'Token expiry corpus';
  setFiles(app, app.doc.getElementById('datasets-file'), ['token.txt']);

  let rotated = 0;
  app.window.CORPUS_SUPABASE.getSession = async () => ({
    data: { session: { access_token: 'tok-' + (++rotated), user: { id: 'user-1' } } },
  });

  app.XHRStub.nextResponder = (xhr) => {
    xhr.status = 401;
    xhr.responseText = JSON.stringify({ detail: 'Authentication required' });
    if (xhr.onload) xhr.onload();
  };

  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();

  assert.equal(app.XHRStub.instances.length, 2, 'one rejected attempt plus one retry');
  const created = app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST');
  assert.equal(created.length, 1, 'the retry must reuse the dataset record');
  assert.match(app.doc.getElementById('toast-container').textContent, /1 dataset uploaded/i);
});

test('uploads carry a timeout so a stalled transfer cannot hang forever', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();
  app.doc.getElementById('datasets-name').value = 'Timeout corpus';
  setFiles(app, app.doc.getElementById('datasets-file'), ['slow.txt']);

  app.XHRStub.instances.length = 0;
  await app.window.datasets.handleUpload();
  const xhr = app.XHRStub.instances[0];
  assert.ok(typeof xhr.timeout === 'number' && xhr.timeout >= 60000, 'upload XHR has a real timeout');
});

test('a failed upload keeps the dataset id and explains that the record is kept', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();
  app.doc.getElementById('datasets-name').value = 'Interrupted corpus';
  setFiles(app, app.doc.getElementById('datasets-file'), ['interrupted.txt']);

  app.XHRStub.nextResponder = (xhr) => {
    if (xhr.onerror) xhr.onerror();
  };
  await app.window.datasets.handleUpload();

  assert.equal(app.doc.getElementById('datasets-upload-area').style.display, 'block', 'queue stays visible');
  assert.match(app.doc.getElementById('datasets-progress').textContent, /network|interrupted|kept/i);

  // Retry: the record created by the first attempt is reused.
  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();
  assert.equal(app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST').length, 0);
  assert.match(app.doc.getElementById('toast-container').textContent, /1 dataset uploaded/i);
});
