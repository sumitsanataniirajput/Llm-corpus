/**
 * The navigation shell: one hamburger, one drawer, grouped sections.
 *
 * The app used to move between two navigation systems — a bottom bar on phones
 * (five routes, duplicating the sidebar) and a permanently open sidebar on
 * desktop. Both are gone. This suite drives the real document and the real
 * router and asserts the behaviour a user actually gets on a phone and on a
 * desktop:
 *
 *   - there is no bottom bar, no floating navigation, and exactly one control
 *     (the hamburger) opens navigation;
 *   - the drawer starts closed at every width, opens, locks the page behind it,
 *     closes on Escape / the close button / the scrim, and hands focus back;
 *   - all 24 pages live in seven expandable sections, each holding the pages it
 *     should, and the section of the current page opens itself;
 *   - section state is remembered between visits;
 *   - the CSS contract makes the drawer touch-sized, scrollable and safe-area
 *     aware on phones while staying a drawer on desktop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');

function registry() {
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', read('js/routes.js'))(sandbox.window);
  return sandbox.window.CORPUS_ROUTES;
}

function json(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function bootApp({ hash = '#/dashboard', width = 390, height = 844 } = {}) {
  const dom = new JSDOM(INDEX.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'http://localhost/' + hash,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  window.matchMedia = () => ({ matches: width < 1024, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

  window.Chart = class { constructor() { this.data = { labels: [], datasets: [] }; } update() {} destroy() {} };
  window.Swal = { fire: async () => ({ isConfirmed: false }) };
  window.AOS = { init() {}, refresh() {} };
  window.WebSocket = class { send() {} close() {} };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.scrollTo = () => {};
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { canvas: this, createLinearGradient: () => ({ addColorStop() {} }) };
  };
  window.fetch = async () => json([]);

  for (const match of INDEX.matchAll(/<script\s+src="(js\/[^"]+)"/g)) {
    const rel = match[1].split('?')[0];
    window.eval(read(rel));
  }

  window.CORPUS_SUPABASE = {
    getSession: async () => ({ data: { session: { access_token: 't', user: { id: 'user-1' } } } }),
    init() {}, signIn: async () => ({}), signOut: async () => ({}),
    onAuthStateChange() { return { unsubscribe() {} }; },
  };
  window.CORPUS_APP.setPageContainer(window.document.getElementById('page-container'));

  return { dom, window, doc: window.document };
}

async function startApp(app) {
  app.window.state.setUser({ id: 'user-1', email: 'tester@example.com' });
  app.window.state.setAuthReady(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/* ------------------------------------------------------------------ markup */

test('there is no bottom bar and exactly one navigation control', () => {
  assert.doesNotMatch(INDEX, /bottom-nav|bottom-nav-height/, 'no bottom navigation in the document');
  assert.doesNotMatch(INDEX, /class="nav-link"/, 'no bottom-bar links');

  const app = bootApp();
  const doc = app.doc;
  assert.equal(doc.getElementById('bottom-nav'), null, 'no bottom navigation element at runtime');
  assert.equal(doc.querySelectorAll('.bottom-nav, .nav-link').length, 0, 'nothing from the old bar survives');

  const toggles = doc.querySelectorAll('#menu-toggle');
  assert.equal(toggles.length, 1, 'one hamburger');
  const toggle = toggles[0];
  assert.equal(toggle.getAttribute('aria-controls'), 'sidebar');
  assert.equal(toggle.getAttribute('aria-label'), 'Open menu');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  // No other element claims to be navigation besides the drawer.
  const navs = [...doc.querySelectorAll('nav, [role="navigation"]')];
  assert.deepEqual(navs.map((n) => n.id), ['sidebar-nav'], 'the sidebar is the only navigation');
  app.dom.window.close();
});

test('the drawer contains all 24 pages in seven expandable sections', async () => {
  const app = bootApp();
  await startApp(app);
  const nav = app.doc.getElementById('sidebar-nav');
  const reg = registry();

  const groups = [...nav.querySelectorAll('.nav-group')];
  assert.equal(groups.length, reg.GROUPS.length, 'one section per declared group');
  assert.deepEqual(groups.map((g) => g.dataset.group), reg.GROUPS.map((g) => g.id), 'sections in declared order');

  const items = [...nav.querySelectorAll('.nav-item[data-route]')];
  assert.equal(items.length, reg.ROUTES.length, 'one entry per page');
  assert.equal(items.length, 24, 'all 24 pages are in the menu');

  for (const group of groups) {
    const details = nav.querySelector(`.nav-group[data-group="${group.dataset.group}"]`);
    const summary = details.querySelector('summary.nav-group-summary');
    assert.ok(summary, `${group.dataset.group}: has an expandable heading`);
    assert.ok(details instanceof app.window.HTMLDetailsElement, 'the heading is a native <details>');
    assert.ok(summary.textContent.trim().length > 0, 'the heading has a label');
    const routes = reg.routesInGroup(group.dataset.group).map((entry) => entry.route);
    const shown = [...details.querySelectorAll('.nav-item')].map((item) => item.dataset.route);
    assert.deepEqual(shown, routes, `${group.dataset.group}: holds exactly its declared pages`);
  }

  const labels = [...nav.querySelectorAll('.nav-item span')].map((span) => span.textContent.trim());
  for (const label of ['Dashboard', 'AI Teacher Network', 'AI API Keys', 'Dataset Quality Review',
    'Student Model Studio', 'Training Intelligence', 'API Usage & Budgets', 'Settings']) {
    assert.ok(labels.includes(label), `${label} is in the menu`);
  }
  app.dom.window.close();
});

/* ------------------------------------------------------------------ drawer */

test('the drawer is closed on load and the hamburger opens it', async () => {
  const app = bootApp();
  await startApp(app);
  const { window, doc } = app;
  const sidebar = doc.getElementById('sidebar');
  const overlay = doc.getElementById('sidebar-overlay');
  const toggle = doc.getElementById('menu-toggle');

  assert.ok(sidebar.classList.contains('hidden'), 'closed on load on a phone');
  assert.equal(sidebar.getAttribute('aria-hidden'), 'true');
  assert.ok(sidebar.hasAttribute('inert'), 'a closed drawer cannot be tabbed into');
  assert.ok(overlay.classList.contains('hidden'));
  assert.equal(doc.body.classList.contains('nav-open'), false);

  toggle.click();

  assert.equal(sidebar.classList.contains('hidden'), false, 'open after a tap');
  assert.equal(sidebar.getAttribute('aria-hidden'), 'false');
  assert.equal(sidebar.hasAttribute('inert'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Close menu');
  assert.equal(overlay.classList.contains('hidden'), false, 'a scrim appears');
  assert.ok(doc.body.classList.contains('nav-open'), 'the page behind the drawer cannot scroll');
  assert.equal(doc.activeElement.dataset.route, 'dashboard', 'focus moves into the drawer, to the current page');

  // A tap on the scrim closes it.
  overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(sidebar.classList.contains('hidden'), 'the scrim closes the drawer');
  assert.equal(doc.body.classList.contains('nav-open'), false);

  // Escape closes it and focus returns to the hamburger.
  toggle.click();
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(sidebar.classList.contains('hidden'), 'Escape closes the drawer');
  assert.equal(doc.activeElement.id, 'menu-toggle', 'focus returns to the hamburger');

  // The close button works too.
  toggle.click();
  doc.getElementById('sidebar-close').click();
  assert.ok(sidebar.classList.contains('hidden'), 'the close button closes the drawer');

  app.dom.window.close();
});

test('choosing a page closes the drawer and highlights the page', async () => {
  const app = bootApp();
  await startApp(app);
  const { window, doc } = app;
  doc.getElementById('menu-toggle').click();

  const item = doc.querySelector('.nav-item[data-route="ai-teachers"]');
  item.click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(doc.getElementById('sidebar').classList.contains('hidden'), 'the drawer closes after choosing a page');
  assert.equal(doc.body.classList.contains('nav-open'), false);
  assert.equal(item.classList.contains('active'), true, 'the chosen page is highlighted');
  assert.equal(item.getAttribute('aria-current'), 'page');
  assert.equal(window.location.hash, '#/ai-teachers');
  assert.match(doc.getElementById('page-container').textContent, /Who teaches your models/,
    'the page in the drawer is the page that renders');

  app.dom.window.close();
});

test('the section holding the current page opens itself, even if it was collapsed', async () => {
  const app = bootApp();
  await startApp(app);
  const { window, doc } = app;
  const nav = doc.getElementById('sidebar-nav');
  const teaching = nav.querySelector('.nav-group[data-group="teaching"]');

  assert.equal(teaching.open, false, 'collapsed by default (it is not the landing page)');
  await window.router.navigate('student-models');
  assert.equal(teaching.open, true, 'opening a page inside a section expands that section');
  assert.equal(nav.querySelector('.nav-group[data-group="workspace"]').open, true, 'other sections keep their state');

  app.dom.window.close();
});

test('open sections are remembered between visits', async () => {
  const app = bootApp();
  await startApp(app);
  const { doc, window } = app;
  const nav = doc.getElementById('sidebar-nav');
  const compute = nav.querySelector('.nav-group[data-group="compute"]');

  compute.open = true;
  compute.dispatchEvent(new window.Event('toggle'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const stored = JSON.parse(window.localStorage.getItem('corpus_nav_groups') || '[]');
  assert.ok(stored.includes('compute'), 'the user choice is stored');

  // A fresh document with the same storage restores it.
  const second = bootApp();
  second.window.localStorage.setItem('corpus_nav_groups', JSON.stringify(stored));
  second.window.router.renderSidebar('dashboard');
  const restored = second.doc.getElementById('sidebar-nav')
    .querySelector('.nav-group[data-group="compute"]');
  assert.equal(restored.open, true, 'the section the user opened is open on the next visit');
  second.dom.window.close();
  app.dom.window.close();
});

test('the drawer works the same on a desktop viewport', async () => {
  const app = bootApp({ width: 1440, height: 900 });
  await startApp(app);
  const { doc } = app;
  const sidebar = doc.getElementById('sidebar');
  const toggle = doc.getElementById('menu-toggle');

  assert.ok(sidebar.classList.contains('hidden'), 'closed on load on a desktop too — the hamburger is the way in');
  toggle.click();
  assert.equal(sidebar.classList.contains('hidden'), false, 'the desktop hamburger opens the same drawer');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  doc.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(sidebar.classList.contains('hidden'), 'and it closes the same way');
  app.dom.window.close();
});

/* --------------------------------------------------------------------- CSS */

function ruleBody(source, selector) {
  const index = source.indexOf(selector + ' {');
  assert.notEqual(index, -1, `rule ${selector} exists`);
  const start = source.indexOf('{', index);
  return source.slice(start + 1, source.indexOf('}', start));
}

test('the drawer CSS is mobile-friendly, scrollable and safe-area aware', () => {
  const layout = read('css/layout.css');
  const responsive = read('css/responsive.css');

  const sidebar = ruleBody(layout, '.sidebar');
  assert.match(sidebar, /100dvh/, 'the drawer uses the dynamic viewport height');
  assert.match(sidebar, /padding-top:\s*var\(--safe-top\)/);
  assert.match(sidebar, /padding-bottom:\s*var\(--safe-bottom\)/);
  assert.match(sidebar, /overflow:\s*hidden/);

  const nav = ruleBody(layout, '.sidebar-nav');
  assert.match(nav, /overflow-y:\s*auto/);
  assert.match(nav, /overscroll-behavior:\s*contain/);
  assert.match(nav, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(nav, /touch-action:\s*pan-y/);

  assert.match(ruleBody(layout, '.nav-item'), /min-height:\s*2\.75rem/, '44px touch targets');
  assert.match(ruleBody(layout, '.nav-group-summary'), /min-height:\s*2\.75rem/);
  assert.match(ruleBody(layout, '.nav-item'), /touch-action:\s*manipulation/);

  // Closed means truly closed: transforms out, untabbable, unclickable.
  assert.match(layout, /\.sidebar\.hidden\s*\{[^}]*transform:\s*translateX\(-102%\)/s);
  assert.match(layout, /\.sidebar\.hidden\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(layout, /\.sidebar\.hidden\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(layout, /body\.nav-open\s*\{\s*overflow:\s*hidden/, 'the page behind the drawer is locked');

  // The desktop layer keeps the drawer closed instead of pinning it open.
  assert.ok(!/\.sidebar\.hidden\s*\{[^}]*translateX\(0\)/.test(layout),
    'no rule force-opens the drawer on desktop');
  assert.ok(!/margin-left:\s*var\(--sidebar-width\)/.test(layout),
    'content is not offset for a permanent sidebar');
  const desktop = layout.slice(layout.indexOf('@media (min-width: 1024px)'));
  assert.match(desktop, /\.sidebar\s*\{[^}]*width:/s, 'the desktop drawer is sized there, not pinned open');
});

test('the app bar — and therefore the hamburger — is visible at every width', () => {
  const layout = read('css/layout.css');
  const responsive = read('css/responsive.css');
  const desktop = layout.slice(layout.indexOf('@media (min-width: 1024px)'));
  assert.doesNotMatch(desktop, /\.app-bar\s*\{\s*display:\s*none/, 'the app bar is never hidden on desktop');
  assert.match(ruleBody(layout, '.app-bar'), /display:\s*flex/);
  assert.doesNotMatch(responsive, /\.app-bar\s*\{\s*display:\s*none/);
});
