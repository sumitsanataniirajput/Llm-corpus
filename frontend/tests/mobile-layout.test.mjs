/**
 * Mobile layout regressions.
 *
 * The reported bug was overlapping text inside selects and form fields on
 * Android. These tests lock in the CSS contract (stacked labels, no absolute
 * label overlay, select chevron + padding) and the safe-area aware chrome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, datasetFixtures } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const css = (name) => fs.readFileSync(path.join(FRONTEND_DIR, 'css', name), 'utf8');

function ruleBody(source, selector) {
  const index = source.indexOf(selector + ' {');
  assert.notEqual(index, -1, `rule ${selector} exists`);
  const start = source.indexOf('{', index);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

test('input labels are stacked above controls and never absolutely positioned', () => {
  const variables = css('variables.css');

  const field = ruleBody(variables, '.input-field');
  assert.match(field, /display:\s*flex/);
  assert.match(field, /flex-direction:\s*column/);

  const label = ruleBody(variables, '.input-field > label');
  assert.match(label, /order:\s*-1/, 'label is ordered above the control regardless of DOM order');
  assert.doesNotMatch(label, /position:\s*absolute/);

  // No floating-label overlay rules may survive anywhere.
  for (const file of ['variables.css', 'components.css', 'layout.css', 'pages.css', 'responsive.css']) {
    const source = css(file);
    assert.doesNotMatch(
      source,
      /\.input-field[^{]*label[^{]*\{[^}]*position:\s*absolute/,
      `${file} must not absolutely position .input-field labels`
    );
  }
});

test('selects show the selected value with room for the chevron', () => {
  const variables = css('variables.css');
  const base = ruleBody(variables, '.input-field input,\n.input-field select,\n.input-field textarea');
  assert.match(base, /-webkit-appearance:\s*none/);
  assert.match(base, /appearance:\s*none/);
  assert.match(base, /min-height:\s*2\.75rem/);

  const select = ruleBody(variables, '.input-field select');
  assert.match(select, /padding-right:\s*2\.4rem/);
  assert.match(select, /text-overflow:\s*ellipsis/);
  assert.match(select, /background-position:\s*right/);
});

test('the navigation drawer respects the Android viewport and safe areas', () => {
  const variables = css('variables.css');
  const layout = css('layout.css');
  const responsive = css('responsive.css');
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');

  assert.match(variables, /--safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(variables, /--safe-top:\s*env\(safe-area-inset-top/);

  // The drawer, its scrolling list and the page behind it are all safe-area aware.
  const sidebar = ruleBody(layout, '.sidebar');
  assert.match(sidebar, /padding-top:\s*var\(--safe-top\)/);
  assert.match(sidebar, /padding-bottom:\s*var\(--safe-bottom\)/);
  assert.match(sidebar, /100dvh/, 'the drawer follows the dynamic viewport, not 100vh');

  const nav = ruleBody(layout, '.sidebar-nav');
  assert.match(nav, /overflow-y:\s*auto/, 'a long menu scrolls inside the drawer');
  assert.match(nav, /overscroll-behavior:\s*contain/, 'scrolling the menu never scrolls the page');
  assert.match(nav, /-webkit-overflow-scrolling:\s*touch/, 'momentum scrolling on iOS');

  const main = ruleBody(layout, '.main-content');
  assert.match(main, /padding-bottom:\s*calc\(var\(--safe-bottom\)/, 'content clears the home indicator');
  assert.doesNotMatch(main, /bottom-nav/, 'no space is reserved for a bottom bar any more');

  // The bar itself is gone from the markup and from every stylesheet.
  assert.doesNotMatch(html, /bottom-nav/, 'index.html has no bottom navigation');
  for (const file of ['layout.css', 'responsive.css', 'components.css', 'variables.css']) {
    assert.doesNotMatch(css(file), /bottom-nav/, `${file} has no bottom-navigation rules`);
  }

  // Touch targets stay thumb-sized.
  const item = ruleBody(layout, '.nav-item');
  assert.match(item, /min-height:\s*2\.75rem/);
  const summary = ruleBody(layout, '.nav-group-summary');
  assert.match(summary, /min-height:\s*2\.75rem/);

  assert.match(responsive, /@media \(max-width: 379px\)/);
  assert.match(responsive, /@media \(max-width: 429px\)/);
  assert.match(responsive, /@media \(max-width: 768px\)/);
});

test('long names cannot force horizontal scrolling', () => {
  const pages = css('pages.css');
  const title = ruleBody(pages, '.model-info h3');
  assert.match(title, /overflow-wrap:\s*anywhere/);

  const datasetTitle = ruleBody(pages, '.dataset-title');
  assert.match(datasetTitle, /overflow-wrap:\s*anywhere/);

  const components = css('components.css');
  const fileRow = ruleBody(components, '.file-row-name');
  assert.match(fileRow, /text-overflow:\s*ellipsis/);

  const variables = css('variables.css');
  assert.match(ruleBody(variables, 'body'), /overflow-x:\s*hidden/);
});

test('training and dataset selects keep their labels associated and visible', async () => {
  const app = createApp(datasetFixtures());
  await app.window.training.render();

  for (const id of ['t-model', 't-dataset', 't-engine', 't-compute']) {
    const select = app.doc.getElementById(id);
    assert.ok(select, `${id} exists`);
    const field = select.closest('.input-field');
    assert.ok(field, `${id} is wrapped in .input-field`);
    const label = field.querySelector('label');
    assert.ok(label, `${id} has a label`);
    assert.equal(label.getAttribute('for'), id);
    assert.equal(field.firstElementChild.tagName, 'LABEL', 'label is the first child (CSS also forces order)');
  }

  app.window.training.dispose();
});

test('advanced training settings are collapsible but still rendered', async () => {
  const app = createApp(datasetFixtures());
  await app.window.training.render();

  const accordion = app.doc.querySelector('details.accordion');
  assert.ok(accordion, 'advanced settings use a details element');
  assert.equal(accordion.open, false, 'collapsed by default');
  for (const id of ['t-accum', 't-clip', 't-seed']) {
    assert.ok(accordion.querySelector('#' + id), `${id} lives inside advanced settings`);
  }

  app.window.training.dispose();
});
