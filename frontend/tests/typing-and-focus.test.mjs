/**
 * Phase 1 — global text input / keyboard regression suite.
 *
 * The reported bug was "I cannot type into the AI API Key form, Prediction Lab
 * and other fields" on Android Chrome. The root cause is not an overlay: pages
 * replace their whole container with `innerHTML = ...` while a job is polling
 * or Supabase re-emits SIGNED_IN, which destroys the focused input, its value,
 * its caret and the soft keyboard. Bare-`<label>` inputs also had no styles at
 * all (no focus ring, no caret colour, no 44px target).
 *
 * These tests pin the shared fix in js/components.js + app-bootstrap.js and
 * exercise real page modules at 360x800, 390x844 and 1440x900.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { createApp } from './harness.mjs';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');
const css = (name) => read('css/' + name);
const js = (name) => read('js/' + name);

const openApps = [];
after(() => {
  while (openApps.length) {
    const app = openApps.pop();
    try {
      const root = app.window.document.getElementById('page-container');
      if (root && root.__corpusMobileHintObserver) root.__corpusMobileHintObserver.disconnect();
    } catch (e) { /* already torn down */ }
    try { app.dom.window.close(); } catch (e) { /* already closed */ }
  }
});

function ruleBody(source, selector) {
  const index = source.indexOf(selector + ' {');
  assert.notEqual(index, -1, `rule ${selector} exists`);
  const start = source.indexOf('{', index);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

/** Extract a single tag by its id/name so attribute assertions stay precise. */
function tagWith(source, attribute, value) {
  const re = new RegExp(
    '<(?:input|textarea|select)\\b[^>]*' + attribute + '=["\']' + value + '["\'][^>]*>',
    'i'
  );
  const match = source.match(re);
  return match ? match[0] : null;
}

function allTagsWith(source, attribute, value) {
  const re = new RegExp(
    '<(?:input|textarea|select)\\b[^>]*' + attribute + '=["\']' + value + '["\'][^>]*>',
    'gi'
  );
  return source.match(re) || [];
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

/** Boots index.html exactly like a browser: every local script, in order. */
function bootAll({ hash = '#/prediction-lab', width = 390, height = 844, fetchImpl = null } = {}) {
  const authListeners = [];
  const dom = new JSDOM(INDEX.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/' + hash,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });

  window.Chart = class { constructor() { this.data = {}; } update() {} destroy() {} };
  window.Swal = { fire: async () => ({ isConfirmed: false }) };
  window.AOS = { init() {}, refresh() {} };
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.scrollTo = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }), measureText: () => ({ width: 0 }) };
  };
  window.fetch = fetchImpl || (async () => jsonResponse({}));

  for (const match of INDEX.matchAll(/<script\s+src="(js\/[^"]+)"/g)) {
    const rel = match[1].split('?')[0];
    window.eval(fs.readFileSync(path.join(FRONTEND, rel), 'utf8'));
  }

  window.CORPUS_SUPABASE = {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-1', email: 'tester@example.com' } } } }),
    init() {},
    signIn: async () => ({ data: {}, error: null }),
    signOut: async () => ({}),
    onAuthStateChange(fn) {
      authListeners.push(fn);
      return { unsubscribe() {} };
    },
  };

  const container = window.document.getElementById('page-container');
  if (window.CORPUS_APP && window.CORPUS_APP.setPageContainer) {
    window.CORPUS_APP.setPageContainer(container);
  }
  const app = { dom, window, doc: window.document, container, authListeners };
  openApps.push(app);
  return app;
}

async function startAll(app) {
  app.window.state.setUser({ id: 'user-1', email: 'tester@example.com' });
  app.window.state.setAuthReady(true);
  await new Promise((resolve) => setTimeout(resolve, 120));
}

function enterKey(window, { isComposing = false, keyCode = 13 } = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  });
  Object.defineProperty(event, 'isComposing', { value: isComposing });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  return event;
}

/* ------------------------------------------------------------ CSS contract */

test('a visible focus ring and caret exist at every viewport width', () => {
  const variables = css('variables.css');
  const focus = ruleBody(variables, ':focus-visible');
  assert.doesNotMatch(focus, /outline:\s*none/);
  assert.match(focus, /outline:\s*2px solid/);
  assert.match(variables, /input:focus:not\(\[type="checkbox"\]\)/);

  const base = ruleBody(variables, 'input,\nselect,\ntextarea');
  assert.match(base, /box-sizing:\s*border-box/);
  assert.match(base, /caret-color:\s*var\(--color-accent\)/);
  assert.match(base, /max-width:\s*100%/);
});

test('bare-label and inline forms get a real, focusable 44px control', () => {
  const variables = css('variables.css');
  const shared = variables.slice(variables.indexOf('label > input:not('));
  assert.match(shared, /min-height:\s*2\.75rem/);
  assert.match(shared, /caret-color:\s*var\(--color-accent\)/);
  assert.match(shared, /label > textarea/);
  assert.match(shared, /label > input:focus/);

  const components = css('components.css');
  assert.match(components, /\.inline-form,\s*\n\.filter-row\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(components, /\.filter-row > input,\s*\n\.filter-row > select/);
});

test('labels are tappable and important controls meet the 44px target', () => {
  const variables = css('variables.css');
  const label = ruleBody(variables, '.input-field > label');
  assert.match(label, /order:\s*-1/);
  assert.match(label, /pointer-events:\s*auto/);
  assert.doesNotMatch(label, /pointer-events:\s*none/);
  assert.doesNotMatch(label, /position:\s*absolute/);

  assert.match(
    variables,
    /\.icon-btn,[\s\S]{0,260}min-height:\s*2\.75rem/,
    'icon buttons, copy buttons, chat send and modal controls are 44px'
  );
});

test('phone forms go single-column with 16px text (no IME zoom, no overflow)', () => {
  const responsive = css('responsive.css');
  const phoneBlock = responsive.slice(
    responsive.indexOf('@media (max-width: 768px)'),
    responsive.indexOf('@media (max-width: 430px)') > 0
      ? responsive.indexOf('@media (max-width: 430px)')
      : responsive.length
  );
  assert.match(phoneBlock, /font-size:\s*16px/);
  assert.match(phoneBlock, /\.inline-form > label,[\s\S]{0,300}flex:\s*1 1 100%/);
  assert.match(phoneBlock, /\.form-grid,[\s\S]{0,120}grid-template-columns:\s*minmax\(0, 1fr\)/);
});

/* ---------------------------------------------------------- source contract */

test('no typing field is disabled or readonly', () => {
  for (const [file, id] of [
    ['chat.js', 'chat-input'],
    ['prediction.js', 'pred-text'],
    ['distillation.js', 'kd-extra'],
    ['settings.js', 'settings-key-name'],
  ]) {
    const tag = tagWith(js(file), 'id', id);
    assert.ok(tag, `${file} still renders #${id}`);
    assert.doesNotMatch(tag, /\bdisabled\b/, `#${id} must accept typing`);
    assert.doesNotMatch(tag, /\breadonly\b/, `#${id} must accept typing`);
  }
  for (const tag of allTagsWith(js('teachers.js'), 'name', 'api_key')) {
    assert.doesNotMatch(tag, /\bdisabled\b|\breadonly\b/);
  }
});

test('password fields stay masked and declare mobile keyboard hints', () => {
  for (const tag of [
    ...allTagsWith(js('teachers.js'), 'name', 'api_key'),
    tagWith(js('auth.js'), 'id', 'login-password'),
    tagWith(js('auth.js'), 'id', 'signup-password'),
  ]) {
    assert.ok(tag);
    assert.match(tag, /type="password"/, 'masking preserved');
    assert.match(tag, /autocomplete="[^"]+"/);
    assert.match(tag, /enterkeyhint="[^"]+"/);
    assert.match(tag, /inputmode="text"/);
  }
});

test('Chat Enter is IME-composition safe and the composer is never disabled', () => {
  const chat = js('chat.js');
  assert.match(chat, /e\.isComposing \|\| e\.keyCode === 229/);
  assert.match(chat, /if \(!activeModel \|\| isGenerating\) return;/);
  assert.match(chat, /enterkeyhint="send"/);
  assert.doesNotMatch(chat, /\$\{activeModel \? '' : 'disabled'\}/);
  assert.match(chat, /The composer is never disabled/);
});

test('the distillation poller repaints only live sections, never the form', () => {
  const source = js('distillation.js');
  const watch = source.match(/function watch\(jobId\) \{[\s\S]*?\n  \}/);
  assert.ok(watch, 'watch() exists');
  assert.match(watch[0], /updateLiveSections\(\)/);
  assert.doesNotMatch(watch[0], /renderDistillation\(\)/);
  assert.match(source, /id="kd-progress"/);
  assert.match(source, /id="kd-jobs"/);
});

test('auth re-renders only when the signed-in identity actually changes', () => {
  const source = js('auth.js');
  assert.match(source, /lastRenderedUserId/);
  assert.match(source, /rerenderForIdentity\(session, false\)/);
  assert.match(source, /repaintPreservingForms/);
});

test('the shared guard is exported and installed by the bootstrap', () => {
  const components = js('components.js');
  for (const name of [
    'captureFormState', 'restoreFormState', 'repaintPreservingForms',
    'installFormStateGuard', 'applyMobileInputHints',
  ]) {
    assert.match(components, new RegExp('\\b' + name + '\\b'));
  }
  assert.match(js('app-bootstrap.js'), /installFormStateGuard\(container\)/);
});

/* -------------------------------------------------------------- behaviour */

const FORM_MARKUP = `
  <div class="input-field">
    <label for="tf-a">Name</label>
    <input id="tf-a" name="name" type="text">
  </div>
  <textarea id="tf-b" name="notes"></textarea>
  <label><input id="tf-c" type="checkbox"> Consent</label>
  <select id="tf-d" name="mode"><option value="a">A</option><option value="b">B</option></select>
  <input id="tf-secret" type="password" name="api_key">
`;

test('the guard preserves typed values, caret, selection, checkbox and focus', async () => {
  const app = createApp();
  openApps.push(app);
  const container = app.doc.getElementById('page-container');
  container.innerHTML = FORM_MARKUP;

  const name = app.doc.getElementById('tf-a');
  const notes = app.doc.getElementById('tf-b');
  const consent = app.doc.getElementById('tf-c');
  const mode = app.doc.getElementById('tf-d');
  const secret = app.doc.getElementById('tf-secret');

  name.value = 'sk-my-long-value';
  name.focus();
  name.setSelectionRange(3, 8);
  notes.value = 'first line\nsecond line';
  consent.checked = true;
  mode.value = 'b';
  secret.value = 'sk-super-secret';

  const result = await app.window.ui.repaintPreservingForms(container, () => {
    container.innerHTML = FORM_MARKUP;
    return 'done';
  });

  assert.equal(result, 'done');
  assert.equal(app.doc.getElementById('tf-a').value, 'sk-my-long-value', 'value survives repaint');
  assert.equal(app.doc.getElementById('tf-a').selectionStart, 3, 'caret start survives repaint');
  assert.equal(app.doc.getElementById('tf-a').selectionEnd, 8, 'caret end survives repaint');
  assert.equal(app.doc.getElementById('tf-b').value, 'first line\nsecond line', 'multiline text survives');
  assert.equal(app.doc.getElementById('tf-c').checked, true, 'checkbox survives');
  assert.equal(app.doc.getElementById('tf-d').value, 'b', 'select survives');
  assert.equal(app.doc.getElementById('tf-secret').type, 'password', 'masking survives');
  assert.equal(app.doc.getElementById('tf-secret').value, 'sk-super-secret', 'typed credential survives');
  assert.equal(app.doc.activeElement, app.doc.getElementById('tf-a'), 'focus returns to the same field');

  // Credentials are never written to storage by the guard.
  assert.doesNotMatch(JSON.stringify(app.window.localStorage || {}), /sk-super-secret/);
});

test('the guard never carries typed values into a different form', () => {
  const app = createApp();
  openApps.push(app);
  const container = app.doc.getElementById('page-container');
  container.innerHTML = FORM_MARKUP;
  app.doc.getElementById('tf-a').value = 'private value';
  app.doc.getElementById('tf-secret').value = 'sk-super-secret';

  const snapshot = app.window.ui.captureFormState(container);
  container.innerHTML = '<input id="other-name"><textarea id="other-note"></textarea>';
  app.window.ui.restoreFormState(container, snapshot);

  assert.equal(app.doc.getElementById('other-name').value, '');
  assert.equal(app.doc.getElementById('other-note').value, '');
});

test('copyText fallback returns focus to the field being edited', async () => {
  const app = createApp();
  openApps.push(app);
  const container = app.doc.getElementById('page-container');
  container.innerHTML = '<input id="copy-focus" type="text">';
  const field = app.doc.getElementById('copy-focus');
  field.value = 'keep this';
  field.focus();
  app.doc.execCommand = () => true;

  await app.window.ui.copyText('copied text');

  assert.equal(app.doc.activeElement, field, 'focus is not stolen by the hidden textarea');
  assert.equal(field.value, 'keep this');
  assert.equal(app.doc.querySelectorAll('body > textarea').length, 0, 'helper element is removed');
});

test('a busy control never swallows a tap on an editable field', () => {
  const app = createApp();
  openApps.push(app);
  const container = app.doc.getElementById('page-container');
  container.innerHTML = '<div data-busy="true"><input id="busy-input" type="text"></div>';
  const field = app.doc.getElementById('busy-input');
  const event = new app.window.MouseEvent('click', { bubbles: true, cancelable: true });
  field.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'the tap reaches the input');
});

test('a refused provider save keeps every typed value and still shows the reason', async () => {
  const routes = [
    { method: 'GET', match: '/api/v1/teachers/types', respond: () => jsonResponse({ provider_types: [{ key: 'openai', label: 'OpenAI' }] }) },
    { method: 'GET', match: '/api/v1/teachers/providers', respond: () => jsonResponse({ providers: [] }) },
    { method: 'GET', match: '/api/v1/teachers/models', respond: () => jsonResponse({ models: [] }) },
    { method: 'GET', match: '/api/v1/teachers/credential-status', respond: () => jsonResponse({ encryption_configured: true }) },
    { method: 'POST', match: '/api/v1/teachers/providers', respond: () => jsonResponse({ detail: 'CREDENTIAL_ENCRYPTION_KEY is not configured.' }, 409) },
  ];
  const app = createApp({ extraRoutes: routes });
  openApps.push(app);
  await app.window.teachers.render('provider-management');
  app.window.teachers.openAddForm();

  const form = app.doc.querySelector('#provider-add-form form');
  assert.ok(form, 'the API-key form opens');
  form.querySelector('input[name="name"]').value = 'My provider';
  form.querySelector('input[name="api_key"]').value = 'sk-test-12345678';
  form.querySelector('input[name="base_url"]').value = 'https://api.example.com/v1';

  await app.window.teachers.submitProvider({ preventDefault() {}, target: form });

  assert.ok(app.doc.getElementById('provider-add-form'), 'the form was not replaced on failure');
  assert.equal(app.doc.querySelector('#provider-add-form input[name="name"]').value, 'My provider');
  assert.equal(app.doc.querySelector('#provider-add-form input[name="api_key"]').value, 'sk-test-12345678');
  assert.equal(app.doc.querySelector('#provider-add-form input[name="base_url"]').value, 'https://api.example.com/v1');
  assert.match(app.doc.getElementById('page-container').innerHTML, /CREDENTIAL_ENCRYPTION_KEY/);
});

/* ------------------------------------------------- real pages at 3 sizes */

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test(`Prediction Lab typing, paste and focus survive a repaint — ${viewport.name}`, async () => {
    const app = bootAll({ hash: '#/prediction-lab', ...viewport });
    await startAll(app);
    await app.window.prediction.render();

    const field = app.doc.getElementById('pred-text');
    assert.ok(field, 'Prediction Lab renders its textarea');
    assert.equal(field.disabled, false);
    assert.equal(field.readOnly, false);
    assert.equal(field.tagName, 'TEXTAREA');

    // Typing then a paste-style replacement: both are just value/input events
    // and the final caret sits in the middle of the pasted text.
    field.focus();
    field.value = 'The quick brown fox ';
    field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    field.value = 'The quick brown fox jumps';
    field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    field.setSelectionRange(4, 9);

    await app.window.prediction.render();

    const after = app.doc.getElementById('pred-text');
    assert.equal(after.value, 'The quick brown fox jumps', 'typed/pasted text survives a full repaint');
    assert.equal(app.doc.activeElement, after, 'focus survives a full repaint');
    assert.equal(after.selectionStart, 4, 'caret/selection start survives a full repaint');
    assert.equal(after.selectionEnd, 9, 'caret/selection end survives a full repaint');
  });

  test(`Chat composer stays editable with no model and respects IME Enter — ${viewport.name}`, async () => {
    const app = bootAll({ hash: '#/chat', ...viewport });
    await startAll(app);
    app.window.state.setActiveModel(null);
    await app.window.chat.render();

    const input = app.doc.getElementById('chat-input');
    assert.ok(input, 'Chat renders its composer');
    assert.equal(input.disabled, false, 'composer is editable even with no active model');
    assert.equal(input.readOnly, false);
    assert.equal(app.doc.getElementById('chat-send').disabled, true, 'only Send is gated');

    input.value = 'नमस्ते';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    input.focus();

    // Devanagari/IME composition: Enter must not submit or swallow the key.
    const composing = enterKey(app.window, { isComposing: true, keyCode: 229 });
    input.dispatchEvent(composing);
    assert.equal(composing.defaultPrevented, false);
    assert.equal(input.value, 'नमस्ते');

    // With no model selected, a plain Enter must not send either.
    const plain = enterKey(app.window);
    input.dispatchEvent(plain);
    assert.equal(plain.defaultPrevented, false);
    assert.equal(input.value, 'नमस्ते');

    // Backspace/selection remain native editing operations.
    input.setSelectionRange(0, 3);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, 3);
  });
}

test('a selected model makes Enter send, but the composer is still never disabled', async () => {
  const app = bootAll({ hash: '#/chat', width: 390, height: 844 });
  await startAll(app);
  app.window.state.setActiveModel({ id: 'model_1', name: 'Trained model' });
  app.window.CORPUS_API.infer = async () => ({ response: 'Acknowledged.' });
  await app.window.chat.render();

  const input = app.doc.getElementById('chat-input');
  assert.equal(input.disabled, false);
  input.value = 'Hello model';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  input.focus();

  const event = enterKey(app.window);
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'Enter sends when a model is selected');
  assert.equal(app.doc.getElementById('chat-input').disabled, false, 'composer stays editable while generating');

  // Let the stubbed send finish before the JSDOM window is closed, so no
  // dangling async work can touch a torn-down document.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(app.doc.getElementById('chat-messages').textContent, /Acknowledged/);
});

test('a busy container never makes an editable field untappable', () => {
  const layout = css('layout.css');
  assert.match(
    layout,
    /\[data-busy="true"\] input,[\s\S]{0,220}pointer-events:\s*auto/,
    'editable descendants stay targetable even when an ancestor is busy'
  );
});

test('mobile keyboard hints are filled in for every dynamically rendered field', async () => {
  const app = createApp();
  openApps.push(app);
  const container = app.doc.getElementById('page-container');
  container.innerHTML = '<div id="dynamic-form"></div>';
  await new Promise((resolve) => setTimeout(resolve, 0));

  app.doc.getElementById('dynamic-form').innerHTML = `
    <input id="hint-number" type="number" step="0.01">
    <input id="hint-email" type="email">
    <textarea id="hint-notes"></textarea>
    <input id="hint-password" type="password" inputmode="text" enterkeyhint="go"
           autocomplete="current-password" autocapitalize="off" spellcheck="false">
  `;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(app.doc.getElementById('hint-number').getAttribute('inputmode'), 'decimal');
  assert.equal(app.doc.getElementById('hint-email').getAttribute('inputmode'), 'email');
  assert.equal(app.doc.getElementById('hint-notes').getAttribute('enterkeyhint'), 'enter');
  assert.equal(app.doc.getElementById('hint-notes').getAttribute('autocapitalize'), 'sentences');
  assert.equal(app.doc.getElementById('hint-email').getAttribute('spellcheck'), 'false');
  const password = app.doc.getElementById('hint-password');
  assert.equal(password.getAttribute('enterkeyhint'), 'go', 'explicit hints are not overwritten');
  assert.equal(password.getAttribute('autocomplete'), 'current-password');
  assert.equal(password.getAttribute('spellcheck'), 'false');
});

test('paste, backspace and selection events are never globally intercepted', () => {
  const app = createApp();
  openApps.push(app);
  const container = app.doc.getElementById('page-container');
  container.innerHTML = '<input id="edit-ops" type="text">';
  const field = app.doc.getElementById('edit-ops');
  field.focus();
  field.value = 'Hello';
  field.setSelectionRange(2, 4);

  const paste = new app.window.Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'inputType', { value: 'insertFromPaste' });
  Object.defineProperty(paste, 'data', { value: 'XYZ' });
  field.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false, 'paste reaches the field');

  field.value = 'HeXYZllo';
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  field.setSelectionRange(4, 7);

  const backspace = new app.window.KeyboardEvent('keydown', {
    key: 'Backspace', bubbles: true, cancelable: true,
  });
  field.dispatchEvent(backspace);
  assert.equal(backspace.defaultPrevented, false, 'backspace reaches the field');
  field.value = 'HeXYllo';
  // Assigning .value moves the caret to the end in jsdom; put the selection
  // back so the input event is checked against a real selection.
  field.setSelectionRange(4, 7);
  field.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(field.value, 'HeXYllo', 'the value is not reset by a global handler');
  assert.equal(field.selectionStart, 4, 'selection is intact');
});

test('a repeated SIGNED_IN / token refresh does not replace the focused field', async () => {
  const app = bootAll({ hash: '#/prediction-lab', width: 390, height: 844 });
  await startAll(app);
  assert.ok(app.authListeners.length >= 1, 'auth subscribed to Supabase events');
  await app.window.prediction.render();

  const field = app.doc.getElementById('pred-text');
  field.value = 'typing while Supabase refreshes';
  field.focus();
  field.setSelectionRange(7, 13);

  const session = { access_token: 'test-token', user: { id: 'user-1', email: 'tester@example.com' } };
  const listener = app.authListeners[0];
  listener('SIGNED_IN', session);
  listener('TOKEN_REFRESHED', session);

  assert.equal(app.doc.getElementById('pred-text'), field, 'the same input is still in the DOM');
  assert.equal(app.doc.activeElement, field, 'focus was not lost');
  assert.equal(field.value, 'typing while Supabase refreshes', 'typed text was not wiped');
  assert.equal(field.selectionStart, 7, 'caret was not lost');
});

test('typed values never follow the user to a different route', () => {
  const app = createApp();
  openApps.push(app);
  // A fresh, unguarded element lets us exercise restoreFormState directly.
  const raw = app.doc.createElement('div');
  app.doc.body.appendChild(raw);
  const markup = '<input id="route-secret" type="password">';
  raw.innerHTML = markup;
  raw.querySelector('input').value = 'sk-do-not-leak';
  const snapshot = app.window.ui.captureFormState(raw);

  app.window.location.hash = '#/somewhere-else';
  raw.innerHTML = markup;
  assert.equal(app.window.ui.restoreFormState(raw, snapshot), false, 'route change invalidates the snapshot');
  assert.equal(raw.querySelector('input').value, '', 'no credential crosses the navigation');
});

test('the one-time API key and key name are removed from the DOM on modal close', async () => {
  const app = bootAll({ hash: '#/settings', width: 390, height: 844 });
  await startAll(app);
  // The bootstrap may already have rendered the real Settings modal. Remove
  // it so the test has exactly one element per id (as a real page does).
  app.doc.querySelectorAll('#settings-create-key-modal').forEach((el) => el.remove());
  app.doc.body.insertAdjacentHTML('beforeend', `
    <div id="settings-create-key-modal" class="hidden">
      <form id="settings-key-form"><input id="settings-key-name" type="text"></form>
      <div id="settings-key-result" style="display:flex">sk-one-time-secret</div>
    </div>
  `);

  app.window.settings.openCreateKeyModal();
  assert.equal(app.doc.getElementById('settings-key-result').innerHTML, '', 'reopening clears a previous secret');
  assert.equal(app.doc.getElementById('settings-key-result').style.display, 'none');

  app.doc.getElementById('settings-key-result').innerHTML = 'sk-one-time-secret';
  app.doc.getElementById('settings-key-result').style.display = 'flex';
  app.doc.getElementById('settings-key-name').value = 'my laptop';
  app.window.settings.closeCreateKeyModal();

  assert.equal(app.doc.getElementById('settings-key-result').innerHTML, '', 'closing clears the secret');
  assert.equal(app.doc.getElementById('settings-key-name').value, '', 'closing clears the key name');
  assert.doesNotMatch(app.doc.body.innerHTML, /sk-one-time-secret/);
});

test('a successful provider save removes the API key from the DOM', async () => {
  const routes = [
    { method: 'GET', match: '/api/v1/teachers/types', respond: () => jsonResponse({ provider_types: [{ key: 'openai', label: 'OpenAI' }] }) },
    { method: 'GET', match: '/api/v1/teachers/providers', respond: () => jsonResponse({ providers: [{ id: 'p1', name: 'My provider', provider_type: 'openai', status: 'connected' }] }) },
    { method: 'GET', match: '/api/v1/teachers/models', respond: () => jsonResponse({ models: [] }) },
    { method: 'GET', match: '/api/v1/teachers/credential-status', respond: () => jsonResponse({ encryption_configured: true }) },
    { method: 'POST', match: '/api/v1/teachers/providers', respond: () => jsonResponse({ id: 'p1', name: 'My provider', status: 'connected' }) },
  ];
  const app = createApp({ extraRoutes: routes });
  openApps.push(app);
  await app.window.teachers.render('provider-management');
  app.window.teachers.openAddForm();

  const form = app.doc.querySelector('#provider-add-form form');
  form.querySelector('input[name="name"]').value = 'My provider';
  form.querySelector('input[name="api_key"]').value = 'sk-success-secret';
  await app.window.teachers.submitProvider({ preventDefault() {}, target: form });

  const html = app.doc.getElementById('page-container').innerHTML;
  assert.doesNotMatch(html, /sk-success-secret/, 'the secret is not left in the page');
  assert.equal(
    app.doc.querySelector('#provider-add-form input[name="api_key"]'),
    null,
    'the add form is closed after a successful save'
  );
  assert.match(html, /My provider/, 'the saved provider is shown');
});

test('every hand-written editable field declares an Android keyboard contract', () => {
  const skipTypes = /type=["'](?:checkbox|radio|range|file|hidden|submit|button|reset|image|color)["']/i;
  const files = fs.readdirSync(path.join(FRONTEND, 'js')).filter((name) => name.endsWith('.js'));
  let checked = 0;
  for (const name of files) {
    // components.js contains a prose comment with a literal `<input>`.
    if (name === 'components.js') continue;
    const source = read('js/' + name);
    const tags = source.match(/<(?:input|textarea)\b[^>]*>/gi) || [];
    for (const tag of tags) {
      if (skipTypes.test(tag) || /\breadonly\b/i.test(tag)) continue;
      checked += 1;
      assert.match(tag, /\binputmode=/, `${name}: ${tag.slice(0, 80)} needs inputmode`);
      assert.match(tag, /\benterkeyhint=/, `${name}: ${tag.slice(0, 80)} needs enterkeyhint`);
      assert.match(tag, /\bautocapitalize=/, `${name}: ${tag.slice(0, 80)} needs autocapitalize`);
      assert.match(tag, /\bspellcheck=/, `${name}: ${tag.slice(0, 80)} needs spellcheck`);
      assert.doesNotMatch(tag, /\bdisabled\b/i, `${name}: ${tag.slice(0, 80)} must accept typing`);
    }
  }
  assert.ok(checked >= 45, `checked ${checked} editable fields across all page modules`);
});

function phase1FetchStub(url) {
  const route = new URL(url, 'http://localhost').pathname.replace(/\/$/, '');
  if (route.startsWith('/api/v1/models')) return jsonResponse([]);
  if (route.startsWith('/api/v1/datasets')) return jsonResponse([]);
  if (route.startsWith('/api/v1/training')) return jsonResponse([]);
  if (route.startsWith('/api/v1/devices')) return jsonResponse({ devices: [], sweep: {} });
  if (route.startsWith('/api/v1/teachers/providers')) return jsonResponse({ providers: [] });
  if (route.startsWith('/api/v1/teachers/types')) return jsonResponse({ provider_types: [{ key: 'openai', label: 'OpenAI' }] });
  if (route.startsWith('/api/v1/teachers/models')) return jsonResponse({ models: [] });
  if (route.startsWith('/api/v1/teachers/credential-status')) return jsonResponse({ encryption_configured: true });
  if (route.startsWith('/api/v1/distillation')) return jsonResponse({ options: { task_types: {}, output_formats: [] }, jobs: [], records: [], summary: {} });
  if (route.startsWith('/api/v1/students')) return jsonResponse({ configs: [], methods: {}, system: { methods: {} } });
  if (route.startsWith('/api/v1/budgets')) return jsonResponse({ budgets: [] });
  if (route.startsWith('/api/v1/evaluation')) return jsonResponse([]);
  if (route.startsWith('/api/v1/compute')) return jsonResponse({ workers: [] });
  if (route.startsWith('/api/v1/api-keys')) return jsonResponse({ keys: [] });
  if (route.startsWith('/api/v1/statistics')) return jsonResponse({ jobs: [], metrics: [] });
  if (route.startsWith('/api/v1/experiments')) return jsonResponse([]);
  return jsonResponse({});
}

const FORM_PAGE_RENDERERS = [
  ['dashboard', (app) => app.window.dashboard.render()],
  ['models', (app) => app.window.models.render()],
  ['training', (app) => app.window.training.render()],
  ['datasets', (app) => app.window.datasets.render()],
  ['prediction', (app) => app.window.prediction.render()],
  ['settings', (app) => app.window.settings.render()],
  ['auth login', (app) => app.window.auth.openModal()],
  ['auth signup', (app) => app.window.auth.switchTab('signup')],
  ['teachers list', (app) => app.window.teachers.render('ai-teachers')],
  ['teachers provider form', async (app) => {
    await app.window.teachers.render('provider-management');
    app.window.teachers.openAddForm();
  }],
  ['distillation create', (app) => app.window.distillation.render('knowledge-distillation')],
  ['distillation review', (app) => app.window.distillation.render('dataset-review')],
  ['students', (app) => app.window.students.render()],
  ['budgets', (app) => app.window.budgets.render()],
  ['evaluation', (app) => app.window.evaluation.render()],
  ['compute', (app) => app.window.compute.render()],
  ['device compute', (app) => app.window.devices.render('device-compute')],
  ['multi device', (app) => app.window.devices.render('multi-device')],
  ['intelligence', (app) => app.window.intelligence.render()],
  ['teacher selection', (app) => app.window.teacherSelection.render('teacher-selection')],
  ['neural lab', (app) => app.window.neuralLab.render()],
  ['ai information', (app) => app.window.aiInfo.render()],
  ['experiments', (app) => app.window.experiments.render()],
  ['statistics', (app) => app.window.statistics.render()],
];

for (const viewport of VIEWPORTS) {
  test(`major forms are editable and keyboard-ready at ${viewport.name}`, async () => {
    const app = bootAll({
      hash: '#/dashboard',
      width: viewport.width,
      height: viewport.height,
      fetchImpl: phase1FetchStub,
    });
    await startAll(app);
    app.window.state.setActiveModel({ id: 'model_1', name: 'Test model' });

    const errors = [];
    let checked = 0;
    for (const [name, render] of FORM_PAGE_RENDERERS) {
      try {
        await render(app);
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (err) {
        errors.push(name + ': ' + (err && err.message ? err.message : String(err)));
        continue;
      }
      const fields = Array.from(app.doc.querySelectorAll('input, textarea')).filter((el) => {
        const type = String(el.type || '').toLowerCase();
        return !['checkbox', 'radio', 'range', 'file', 'hidden', 'submit', 'button', 'reset', 'image', 'color'].includes(type)
          && !el.readOnly;
      });
      for (const el of fields) {
        assert.equal(el.disabled, false, `${name}: ${el.id || el.name || el.tagName} must accept typing`);
        assert.ok(el.getAttribute('inputmode'), `${name}: ${el.id || el.name} needs inputmode`);
        assert.ok(el.getAttribute('enterkeyhint'), `${name}: ${el.id || el.name} needs enterkeyhint`);
        assert.ok(el.getAttribute('autocapitalize'), `${name}: ${el.id || el.name} needs autocapitalize`);
        assert.ok(el.hasAttribute('spellcheck'), `${name}: ${el.id || el.name} needs spellcheck`);
        checked += 1;
      }
    }

    for (const mod of ['dashboard', 'devices', 'distillation', 'intelligence', 'training']) {
      try { if (app.window[mod] && app.window[mod].dispose) app.window[mod].dispose(); } catch (e) {}
    }
    assert.deepEqual(errors, [], 'every major form renders without a module error');
    assert.ok(checked >= 60, `checked ${checked} rendered editable fields`);
    app.dom.window.close();
  });
}
