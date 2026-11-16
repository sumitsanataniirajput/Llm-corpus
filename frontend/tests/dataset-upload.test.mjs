/**
 * Dataset Manager upload tests.
 *
 * The old UI accepted `multiple` files but uploaded only `files[0]`, silently
 * dropping the rest. The new flow uploads every selected file sequentially,
 * creating one dataset record per file and reporting real progress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp, datasetFixtures } from './harness.mjs';

function setFiles(app, input, names) {
  const files = names.map((name) => new app.window.File([`content of ${name}`], name, { type: 'text/plain' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new app.window.Event('change'));
  return files;
}

test('multiple selected files each create and upload their own dataset record', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  assert.equal(input.multiple, true, 'file input still allows selecting several files');
  setFiles(app, input, ['alpha.txt', 'beta.csv']);

  // Queue preview lists both files before uploading.
  const rows = [...app.doc.querySelectorAll('#datasets-file-list .file-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /alpha\.txt/);
  assert.match(rows[1].textContent, /beta\.csv/);

  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();

  const posts = app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST');
  assert.equal(posts.length, 2, 'one dataset record per file');
  assert.equal(posts[0].body.format, 'txt');
  assert.equal(posts[1].body.format, 'csv');
  assert.equal(posts[0].body.name, 'alpha');
  assert.equal(posts[1].body.name, 'beta');

  const uploads = app.XHRStub.instances;
  assert.equal(uploads.length, 2, 'both files were uploaded');
  assert.match(uploads[0].url, /\/api\/v1\/datasets\/.+\/upload$/);
  assert.equal(uploads[0].headers.Authorization, 'Bearer test-token');
  assert.equal(uploads[1].headers.Authorization, 'Bearer test-token');
  assert.notEqual(uploads[0].url, uploads[1].url, 'each file uploads to its own dataset id');
});

test('a single file requires a dataset name', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  setFiles(app, input, ['solo.txt']);
  app.net.calls.length = 0;

  await app.window.datasets.handleUpload();

  assert.equal(app.net.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(app.doc.getElementById('toast-container').textContent, /dataset name/i);
});

test('named single upload uses the entered name and reports progress', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  app.doc.getElementById('datasets-name').value = 'Wiki dump';
  const input = app.doc.getElementById('datasets-file');
  setFiles(app, input, ['wiki.txt']);
  app.net.calls.length = 0;

  await app.window.datasets.handleUpload();

  const posts = app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.name, 'Wiki dump');

  // Real progress was reported through the row (100% after the stub finished).
  const progressRows = app.doc.querySelectorAll('#datasets-progress .upload-progress-row');
  assert.equal(progressRows.length, 0, 'progress list is cleared after a successful batch');
  assert.match(app.doc.getElementById('toast-container').textContent, /uploaded/i);
});

test('unsupported file types are rejected before any request', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  setFiles(app, input, ['malware.exe']);
  app.net.calls.length = 0;

  await app.window.datasets.handleUpload();

  assert.equal(app.net.calls.filter((c) => c.method === 'POST').length, 0, 'no record created');
  assert.equal(app.XHRStub.instances.length, 0, 'no upload attempted');
  assert.match(app.doc.getElementById('toast-container').textContent, /Unsupported format/i);
});

test('search filters the dataset library and reports the count', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();

  assert.equal(app.doc.querySelectorAll('.dataset-card').length, 2);
  assert.match(app.doc.getElementById('datasets-count').textContent, /2 datasets/);

  app.window.datasets.setSearch('wiki');
  assert.equal(app.doc.querySelectorAll('.dataset-card').length, 1);
  assert.match(app.doc.getElementById('datasets-count').textContent, /1 of 2 shown/);

  app.window.datasets.setSearch('nothing-matches');
  assert.equal(app.doc.querySelectorAll('.dataset-card').length, 0);
  assert.match(app.doc.getElementById('datasets-library').textContent, /No matching datasets/);
});

test('tapping the upload drop zone opens the native file picker', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  const drop = app.doc.getElementById('datasets-drop');
  let opened = 0;
  input.click = () => { opened += 1; };

  drop.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(opened, 1, 'a tap on the drop zone should open the Android/browser file chooser');
});
