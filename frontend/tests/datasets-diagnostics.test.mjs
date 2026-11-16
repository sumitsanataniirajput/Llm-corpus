/**
 * Regression tests — Issues reported after the Android Datasets incident:
 *
 *   1. "Datasets module not loaded." with no diagnostics — the page must show
 *      the actual recorded error (script URL / line / message) instead of a
 *      bare generic message, and script 404s must be captured at all.
 *   2. The file <input> change handler must be async-safe end to end, and a
 *      selection must survive Android recreating the page (IndexedDB).
 *   3. Retrying an interrupted upload must reuse the dataset record created
 *      before the interruption, never create a duplicate.
 *
 * These tests load the REAL frontend modules into jsdom and stub only the
 * network boundary, exactly like dataset-upload.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, datasetFixtures, tick } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');

function setFiles(app, input, names) {
  const files = names.map((name) => new app.window.File([`content of ${name}`], name, { type: 'text/plain' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new app.window.Event('change'));
  return files;
}

/**
 * Minimal in-memory IndexedDB. Real devices persist structured-cloned records;
 * this fake keeps object references, which is sufficient for the queue logic.
 */
function createFakeIndexedDB() {
  const databases = new Map();

  function entryFor(name) {
    if (!databases.has(name)) databases.set(name, { version: 0, stores: new Map() });
    return databases.get(name);
  }

  function request(result) {
    return { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  }

  function storeApi(store) {
    return {
      put(record) {
        const key = record[store.keyPath];
        store.data.set(String(key), record);
        return request(key);
      },
      get(key) {
        const req = request(store.data.get(String(key)));
        setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
        return req;
      },
      delete(key) {
        store.data.delete(String(key));
        return request(undefined);
      },
    };
  }

  function transaction(entry, storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(storeName) {
        const store = entry.stores.get(storeName);
        if (!store) throw new Error(`object store "${storeName}" does not exist`);
        return storeApi(store);
      },
    };
    setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
    return tx;
  }

  return {
    open(name, version) {
      const entry = entryFor(name);
      const req = request(null);
      const connection = {
        name,
        version,
        objectStoreNames: { contains: (s) => entry.stores.has(s) },
        createObjectStore(storeName, opts) {
          const store = { keyPath: (opts && opts.keyPath) || 'id', data: new Map() };
          entry.stores.set(storeName, store);
          return storeApi(store);
        },
        transaction(storeNames) { return transaction(entry, storeNames); },
        close() {},
      };
      const oldVersion = entry.version;
      entry.version = version;
      setTimeout(() => {
        if (oldVersion < version && req.onupgradeneeded) {
          req.result = connection;
          req.onupgradeneeded();
        }
        req.result = connection;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

test('the Datasets page renders the complete upload UI controls', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  // Header actions
  const headerButtons = [...app.doc.querySelectorAll('.page-header-actions button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
  assert.ok(headerButtons.some((b) => /Upload dataset/i.test(b)), 'header has Upload dataset button');
  assert.ok(headerButtons.some((b) => /Refresh/i.test(b)), 'header has Refresh button');

  // Upload panel controls
  const upload = app.doc.getElementById('datasets-upload-area');
  assert.equal(upload.style.display, 'block', 'upload panel toggles visible');
  const input = app.doc.getElementById('datasets-file');
  assert.equal(input.type, 'file');
  assert.equal(input.multiple, true);
  assert.match(input.getAttribute('accept'), /\.txt/);
  assert.match(input.getAttribute('accept'), /\.pdf/);
  assert.ok(app.doc.getElementById('datasets-name'), 'dataset name field present');
  assert.match(app.doc.getElementById('datasets-format-note').value, /TXT/);
  assert.match(app.doc.getElementById('datasets-format-note').value, /PDF/);
  assert.equal(app.doc.getElementById('datasets-upload-btn').disabled, false);
  assert.match(app.doc.getElementById('datasets-upload-btn').textContent, /Upload/);
  assert.match(app.doc.getElementById('datasets-drop').textContent, /tap to browse/i);
  assert.match(app.doc.querySelector('.drop-zone-cta').textContent, /Tap to choose files/i);
  assert.equal(app.doc.getElementById('datasets-progress').getAttribute('aria-live'), 'polite');

  // Library + skeleton → loaded state
  assert.ok(app.doc.getElementById('datasets-library'), 'dataset library container present');
  assert.equal(app.doc.querySelectorAll('.dataset-card').length, 2);
  assert.match(app.doc.getElementById('datasets-count').textContent, /2 datasets/);
});

test('a selected file and the dataset name survive the page being recreated (Android IndexedDB)', async () => {
  const fakeIdb = createFakeIndexedDB();

  // First "page life": select a file and type a name, like a user about to upload.
  const app1 = createApp(datasetFixtures());
  app1.window.indexedDB = fakeIdb;
  await app1.window.datasets.render();
  app1.window.datasets.showUpload();
  app1.doc.getElementById('datasets-name').value = 'Rescue corpus';
  setFiles(app1, app1.doc.getElementById('datasets-file'), ['rescue.txt']);
  await tick(50);

  // Second "page life" (Android recreated the WebView): same device storage.
  const app2 = createApp(datasetFixtures());
  app2.window.indexedDB = fakeIdb;
  await app2.window.datasets.render();

  const rows = app2.doc.querySelectorAll('#datasets-file-list .file-row');
  assert.equal(rows.length, 1, 'the pending file was restored from this device');
  assert.match(rows[0].textContent, /rescue\.txt/);
  assert.equal(app2.doc.getElementById('datasets-name').value, 'Rescue corpus', 'dataset name restored');
  assert.match(app2.doc.getElementById('toast-container').textContent, /restored from this device/i);
});

test('retry after an interrupted upload reuses the dataset id persisted before the crash', async () => {
  const fakeIdb = createFakeIndexedDB();

  // First page life: create the dataset record, fail the file upload (502).
  const app1 = createApp(datasetFixtures());
  app1.window.indexedDB = fakeIdb;
  await app1.window.datasets.render();
  app1.window.datasets.showUpload();
  app1.doc.getElementById('datasets-name').value = 'Flaky corpus';
  setFiles(app1, app1.doc.getElementById('datasets-file'), ['flaky.txt']);
  await tick(50);

  app1.XHRStub.nextResponder = (xhr) => {
    xhr.status = 502;
    xhr.responseText = JSON.stringify({ detail: 'Storage upload failed' });
    if (xhr.onload) xhr.onload();
  };
  app1.net.calls.length = 0;
  await app1.window.datasets.handleUpload();
  const created = app1.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST');
  assert.equal(created.length, 1, 'one dataset record created before the interruption');

  // Second page life: restore, then retry — no duplicate record may be created.
  const app2 = createApp(datasetFixtures());
  app2.window.indexedDB = fakeIdb;
  await app2.window.datasets.render();
  app2.net.calls.length = 0;
  await app2.window.datasets.handleUpload();

  const reposts = app2.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST');
  assert.equal(reposts.length, 0, 'retry reuses the persisted dataset id instead of creating a duplicate');
  assert.equal(app2.XHRStub.instances.length, 1, 'the file bytes were uploaded to the same dataset');
  assert.match(app2.doc.getElementById('toast-container').textContent, /1 dataset uploaded/i);
});

test('clearing the queue empties the device store, so nothing is restored later', async () => {
  const fakeIdb = createFakeIndexedDB();

  const app1 = createApp(datasetFixtures());
  app1.window.indexedDB = fakeIdb;
  await app1.window.datasets.render();
  app1.window.datasets.showUpload();
  setFiles(app1, app1.doc.getElementById('datasets-file'), ['gone.txt', 'gone2.txt']);
  await tick(50);
  await app1.window.datasets.clearSelection();

  const app2 = createApp(datasetFixtures());
  app2.window.indexedDB = fakeIdb;
  await app2.window.datasets.render();
  assert.equal(app2.doc.querySelectorAll('#datasets-file-list .file-row').length, 0, 'cleared queue is not restored');
});

test('a device without usable storage still selects files and warns instead of failing silently', async () => {
  const app = createApp(datasetFixtures());
  app.window.indexedDB = { open() { throw new Error('storage blocked'); } };
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  setFiles(app, input, ['local-only.txt']);
  await tick(50);

  assert.equal(app.doc.querySelectorAll('#datasets-file-list .file-row').length, 1, 'selection kept in memory');
  assert.match(app.doc.getElementById('toast-container').textContent, /could not save/i);
});

test('index.html loads datasets.js exactly once, before the bootstrap, with build-stamped URLs', () => {
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'version.json'), 'utf8'));

  const datasetsTags = html.match(/<script src="js\/datasets\.js[^"]*"><\/script>/g) || [];
  assert.equal(datasetsTags.length, 1, 'datasets.js included exactly once');
  assert.ok(datasetsTags[0].includes(`?v=${version.buildId}`), 'datasets.js URL carries the current buildId');

  const order = ['js/config.js', 'js/supabase-client.js', 'js/api.js', 'js/router.js', 'js/datasets.js', 'js/app-bootstrap.js'];
  let lastIndex = -1;
  for (const rel of order) {
    const index = html.indexOf(`src="${rel}`);
    assert.ok(index !== -1, `${rel} is included`);
    assert.ok(index > lastIndex, `${rel} loads after the previous prerequisite`);
    lastIndex = index;
  }

  // Every local css/js asset carries the same ?v=<buildId> (cache-busting contract).
  const assets = [...html.matchAll(/(?:src|href)="(css\/[^"]+|js\/[^"]+|version\.json)"/g)].map((m) => m[1]);
  const unversioned = assets.filter((asset) => !asset.includes(`?v=${version.buildId}`));
  assert.deepEqual(unversioned, [], 'all local assets carry the current buildId');
});

test('the router reports the captured script error instead of a bare generic message', () => {
  const router = fs.readFileSync(path.join(FRONTEND_DIR, 'js', 'router.js'), 'utf8');
  assert.match(router, /missingModulePanel/, 'missing-module branches use the diagnostics panel');
  assert.match(router, /getDiagnostics/, 'the panel reads the diagnostics ring buffer');
  assert.match(router, /resource-error/, 'script/stylesheet load failures are surfaced');
  assert.match(router, /uncaught-error/, 'uncaught exceptions are surfaced with file and line');
  assert.match(router, /Reload page/, 'the user gets a reload action');
  assert.doesNotMatch(router, /<p>Datasets module not loaded\.<\/p><\/div>';/, 'the generic-only Datasets branch is gone');

  const bootstrap = fs.readFileSync(path.join(FRONTEND_DIR, 'js', 'app-bootstrap.js'), 'utf8');
  assert.match(bootstrap, /uncaught-error/, 'bootstrap records uncaught errors with filename:line:col');
  assert.match(bootstrap, /resource-error/, 'bootstrap records failed script/link downloads');
  assert.match(bootstrap, /,\s*true\s*\)/, 'resource errors are captured in the capture phase');
});
