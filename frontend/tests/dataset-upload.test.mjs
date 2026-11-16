/**
 * Dataset Manager upload tests.
 *
 * The old UI accepted `multiple` files but uploaded only `files[0]`, silently
 * dropping the rest. The new flow uploads every selected file sequentially,
 * creating one dataset record per file and reporting real progress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, datasetFixtures } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');

/** Return the declaration block of the first rule whose selector starts with `selector`. */
function ruleBody(source, selector) {
  const index = source.indexOf(selector);
  assert.notEqual(index, -1, `rule ${selector} exists`);
  const start = source.indexOf('{', index);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

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

test('drop zone is a plain container (never a <label>) wrapping one native file input', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();

  const drop = app.doc.getElementById('datasets-drop');
  const input = app.doc.getElementById('datasets-file');
  assert.equal(drop.tagName, 'DIV', 'a <label for> would add a second browser activation path');
  assert.equal(drop.hasAttribute('for'), false, 'no label forwarding to fight with the JS fallback');
  assert.equal(input.type, 'file');
  assert.equal(input.id, 'datasets-file');
  assert.ok(input.getAttribute('accept').includes('.pdf'));
  assert.ok(input.getAttribute('accept').includes('application/pdf'));
  assert.equal(drop.getAttribute('role'), 'group');
  assert.equal(input.getAttribute('aria-labelledby'), 'datasets-drop-title');

  let clickCount = 0;
  input.addEventListener('click', () => { clickCount += 1; });

  // Open, close, and re-open the upload panel (must not re-bind a second
  // handler), then tap the drop-zone CTA.
  app.window.datasets.showUpload();
  app.window.datasets.showUpload();
  app.window.datasets.showUpload();
  const cta = drop.querySelector('.drop-zone-cta');
  cta.click();
  assert.equal(clickCount, 1, 'tapping the CTA opens the native picker exactly once');
});

test('a tap anywhere in the drop zone opens the picker exactly once', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const drop = app.doc.getElementById('datasets-drop');
  const input = app.doc.getElementById('datasets-file');

  let opens = 0;
  input.addEventListener('click', () => { opens += 1; });

  // Every visible part of the zone: the icon, the copy, the CTA pill, and the
  // zone itself (the gap between them). This is the fallback path used when the
  // overlay input is not the topmost hit target on a real phone.
  const targets = [
    ['the icon', drop.querySelector('i')],
    ['the heading', app.doc.getElementById('datasets-drop-title')],
    ['the meta copy', app.doc.getElementById('datasets-drop-meta')],
    ['the CTA pill', drop.querySelector('.drop-zone-cta')],
    ['the zone itself', drop],
  ];
  for (const [label, target] of targets) {
    opens = 0;
    target.click();
    assert.equal(opens, 1, `tapping ${label} opens the picker exactly once`);
  }

  // A tap that lands on the real input is already native: the forwarding
  // handler must not add a second click.
  opens = 0;
  input.click();
  assert.equal(opens, 1, 'the native path stays a single click');
});

test('the real file input is a full-size transparent overlay, not a 1px clipped control', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const drop = app.doc.getElementById('datasets-drop');
  const input = app.doc.getElementById('datasets-file');

  // Structure: one input, a direct child of the drop zone, enabled, multi-file.
  assert.equal(app.doc.querySelectorAll('#datasets-upload-area input[type="file"]').length, 1);
  assert.equal(input.parentElement, drop, 'the input is a direct child of the drop zone');
  assert.equal(input.hasAttribute('disabled'), false, 'the input must stay enabled');
  assert.equal(input.multiple, true, 'multi-file selection is preserved');
  assert.equal(drop.querySelectorAll('button').length, 0, 'no nested interactive button inside the zone');

  // Tap target: nothing in the zone may have pointer-events:none applied inline
  // to the input, and no inline handler may open the picker programmatically.
  assert.equal(input.style.pointerEvents, '', 'no inline pointer-events override on the input');
  assert.equal(input.getAttribute('onclick'), null, 'no inline click handler on the input');
  assert.equal(drop.getAttribute('onclick'), null, 'no inline click handler on the drop zone');
  assert.equal(input.tabIndex >= 0, true, 'the input is keyboard focusable');

  // Every decorative child stays out of the tap path.
  for (const child of drop.children) {
    if (child === input) continue;
    assert.notEqual(child.tagName, 'INPUT');
  }

  // CSS contract — the fix only works if the stylesheet makes the input a
  // real overlay that receives real taps.
  const components = fs.readFileSync(path.join(FRONTEND_DIR, 'css', 'components.css'), 'utf8');
  const responsive = fs.readFileSync(path.join(FRONTEND_DIR, 'css', 'responsive.css'), 'utf8');

  const zone = ruleBody(components, '.drop-zone');
  assert.match(zone, /position:\s*relative/, 'the drop zone anchors the overlay');

  const overlay = ruleBody(components, '.drop-zone > input[type="file"]');
  assert.match(overlay, /position:\s*absolute/, 'overlay is positioned');
  assert.match(overlay, /inset:\s*0/, 'overlay covers the whole zone');
  assert.match(overlay, /width:\s*100%/);
  assert.match(overlay, /height:\s*100%/);
  assert.match(overlay, /opacity:\s*0/);
  assert.match(overlay, /pointer-events:\s*auto/, 'the input must receive the tap');
  assert.match(overlay, /z-index:\s*\d+/, 'the input sits above the decorative content');
  assert.match(overlay, /cursor:\s*pointer/);

  // Regression guards for the two broken approaches.
  assert.doesNotMatch(overlay, /pointer-events:\s*none/, 'never disable pointer events on the real input');
  assert.doesNotMatch(overlay, /clip:\s*rect/, 'the input must not be clipped to 1px');
  assert.doesNotMatch(overlay, /width:\s*1px/);
  assert.doesNotMatch(overlay, /display:\s*none/);
  assert.doesNotMatch(overlay, /visibility:\s*hidden/);
  // Stripping the native widget rendering can stop Android Chrome from opening
  // the picker at all; opacity:0 already hides it.
  assert.doesNotMatch(overlay, /(^|[^-])appearance:\s*none/, 'keep the native file-input rendering');
  assert.doesNotMatch(overlay, /-webkit-appearance:\s*none/, 'keep the native file-input rendering');

  // Decorative children are inert, and the overlay rule comes after that rule
  // so it wins the cascade.
  assert.match(ruleBody(components, '.drop-zone > *'), /pointer-events:\s*none/);
  assert.ok(
    components.indexOf('.drop-zone > * {') < components.indexOf('.drop-zone > input[type="file"]'),
    'the overlay rule must override .drop-zone > *'
  );

  // The phone breakpoint keeps the overlay covering the taller mobile zone.
  assert.match(
    responsive,
    /\.drop-zone > input\[type="file"\][^{]*\{[^}]*pointer-events:\s*auto/s
  );
});

test('the picker never opens twice and keyboard activation stays native', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const drop = app.doc.getElementById('datasets-drop');
  const input = app.doc.getElementById('datasets-file');

  let opens = 0;
  input.addEventListener('click', () => { opens += 1; });

  // A tap that lands on the transparent overlay itself opens the picker once.
  input.click();
  assert.equal(opens, 1, 'the real input opens the picker exactly once per tap');

  // Keyboard Enter/Space on the real control is handled natively — the old
  // JS keydown handler called input.click() and produced a second dialog.
  opens = 0;
  drop.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(opens, 0, 'no JS handler synthesises a click on keydown');

  // Re-binding after a re-render must not stack handlers (that is the other way
  // a single tap ends up opening two dialogs).
  await app.window.datasets.render();
  app.window.datasets.showUpload();
  const rebornDrop = app.doc.getElementById('datasets-drop');
  const rebornInput = app.doc.getElementById('datasets-file');
  let rebornOpens = 0;
  rebornInput.addEventListener('click', () => { rebornOpens += 1; });
  rebornDrop.querySelector('.drop-zone-cta').click();
  assert.equal(rebornOpens, 1, 'one tap, one dialog, after a re-render');
});

test('pdf upload works and oversized files are rejected client-side', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  app.doc.getElementById('datasets-name').value = 'Paper PDF';
  const pdfFile = new app.window.File(['%PDF-1.4\nhello'], 'paper.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [pdfFile], configurable: true });
  input.dispatchEvent(new app.window.Event('change'));

  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();

  const posts = app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.format, 'pdf');
  assert.equal(app.XHRStub.instances.length, 1);

  // Oversized file (>100 MB) is rejected without any POST/XHR.
  app.window.datasets.showUpload();
  const bigFile = new app.window.File(['x'], 'huge.txt', { type: 'text/plain' });
  Object.defineProperty(bigFile, 'size', { value: 101 * 1024 * 1024 });
  Object.defineProperty(input, 'files', { value: [bigFile], configurable: true });
  input.dispatchEvent(new app.window.Event('change'));

  app.net.calls.length = 0;
  app.XHRStub.instances.length = 0;
  await app.window.datasets.handleUpload();
  assert.equal(app.net.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(app.XHRStub.instances.length, 0);
  assert.match(app.doc.getElementById('toast-container').textContent, /too large/i);
});

test('failed upload stays visible and retry reuses the created dataset record', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();

  app.doc.getElementById('datasets-name').value = 'Flaky corpus';
  const input = app.doc.getElementById('datasets-file');
  setFiles(app, input, ['flaky.txt']);

  app.XHRStub.nextResponder = (xhr) => {
    xhr.status = 502;
    xhr.responseText = JSON.stringify({ detail: 'Storage upload failed' });
    if (xhr.onload) xhr.onload();
  };
  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();

  // First attempt created one dataset record and failed upload, keeping queue visible.
  assert.equal(app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST').length, 1);
  assert.equal(app.doc.getElementById('datasets-upload-area').style.display, 'block');
  assert.match(app.doc.getElementById('datasets-progress').textContent, /Storage upload failed/);

  // Retry succeeds without creating a duplicate dataset record.
  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();
  assert.equal(app.net.calls.filter((c) => c.route === '/api/v1/datasets' && c.method === 'POST').length, 0);
  assert.equal(app.XHRStub.instances.length, 2);
  assert.match(app.doc.getElementById('toast-container').textContent, /1 dataset uploaded/i);
});


test('returning from Android file selection keeps the datasets route and selected file queue', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.location.hash = '#/datasets';
  app.window.datasets.showUpload();

  const input = app.doc.getElementById('datasets-file');
  let submitCount = 0;
  app.doc.addEventListener('submit', () => { submitCount += 1; });
  setFiles(app, input, ['mobile-selection.txt']);

  assert.equal(app.window.location.hash, '#/datasets');
  assert.equal(submitCount, 0, 'file selection must not submit or reload the page');
  assert.equal(app.doc.querySelectorAll('#datasets-file-list .file-row').length, 1);
  assert.match(app.doc.getElementById('datasets-file-list').textContent, /mobile-selection\.txt/);
});
