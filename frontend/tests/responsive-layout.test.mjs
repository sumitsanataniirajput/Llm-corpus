/**
 * Display-scaling contract tests.
 *
 * The site has to look deliberate on a 360px phone, a 1080p laptop, a 1920×1080
 * TV three metres away, a 3440×1440 ultra-wide and a portrait tablet. These
 * tests pin that contract to the stylesheet so a future edit cannot quietly
 * drop the large-display layer (the same way the mobile picker fix was once
 * shipped but never served).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => fs.readFileSync(path.join(FRONTEND_DIR, rel), 'utf8');
const components = read('css/components.css');
const layout = read('css/layout.css');
const pages = read('css/pages.css');
const responsive = read('css/responsive.css');
const variables = read('css/variables.css');
const indexHtml = read('index.html');
const version = JSON.parse(read('version.json'));

/** Body of the first `@media (<query>) { ... }` block, braces balanced. */
function mediaBlock(css, query) {
  const needle = query === 'print'
    ? '@media print'
    : query.startsWith('(') ? `@media ${query}` : `@media (${query})`;
  const start = css.indexOf(needle);
  assert.notEqual(start, -1, `expected an @media ${query} block`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in @media ${query}`);
}

/** Value of a custom property in a CSS chunk (first declaration wins). */
function customProp(css, name) {
  const match = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

const rootFontSize = (css) => {
  const match = css.match(/html\s*\{[^}]*font-size\s*:\s*([\d.]+)px/);
  return match ? Number(match[1]) : null;
};

test('the viewport meta allows pinch-zoom and covers notches', () => {
  const meta = indexHtml.match(/<meta\s+name="viewport"[^>]*>/i);
  assert.ok(meta, 'index.html must declare a viewport');
  const content = meta[0].match(/content="([^"]+)"/)[1];
  assert.match(content, /width=device-width/, 'layout viewport must follow the device width');
  assert.match(content, /initial-scale=1(\.0)?/, 'no zoomed-in default scale');
  assert.match(content, /viewport-fit=cover/, 'safe-area insets are used by the bottom nav');
  assert.doesNotMatch(content, /user-scalable=no/, 'users must be able to zoom to read on a TV');
  assert.doesNotMatch(content, /maximum-scale=1\b/, 'pinch-zoom must stay available');
});

test('local CSS and JS are cache-busted with the build id', () => {
  const assets = [...indexHtml.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 20, 'stylesheets and scripts are local and versioned');
  for (const asset of assets) {
    assert.match(
      asset,
      new RegExp(`\\?v=${version.buildId.replace(/\./g, '\\.')}$`),
      `${asset} must carry ?v=<buildId> so a cached copy cannot hide a shipped fix`
    );
  }
  const unversioned = [...indexHtml.matchAll(/(?:href|src)="((?:css|js)\/[^"]*)"/g)]
    .map((m) => m[1])
    .filter((href) => !href.includes('?v='));
  assert.deepEqual(unversioned, [], 'no local asset may load unversioned');
});

test('root font size scales in measured steps instead of one fixed size', () => {
  const base = rootFontSize(variables);
  assert.equal(base, 16, 'mobile baseline stays at 16px');

  const steps = [
    ['min-width: 1440px', 17],
    ['min-width: 1920px', 19],
    ['min-width: 2560px', 22],
  ];
  let previous = base;
  for (const [query, expected] of steps) {
    const size = rootFontSize(mediaBlock(responsive, query));
    assert.equal(size, expected, `${query} must set an ${expected}px root font size`);
    assert.ok(size > previous, 'the scale never shrinks as the screen grows');
    assert.ok(size / previous <= 1.3, 'each step stays a gentle bump, not a jump');
    previous = size;
  }
  assert.ok(previous <= 24, 'a 4K panel does not get billboard-sized UI');
});

test('the page column grows with the display instead of stretching edge to edge', () => {
  const values = [
    customProp(variables, '--page-max'),
    customProp(mediaBlock(responsive, 'min-width: 1440px'), '--page-max'),
    customProp(mediaBlock(responsive, 'min-width: 1920px'), '--page-max'),
    customProp(mediaBlock(responsive, 'min-width: 2560px'), '--page-max'),
  ].map((value) => {
    assert.ok(value, 'every large-display step sets --page-max');
    return Number(value.replace('px', ''));
  });

  assert.deepEqual(values, [1280, 1360, 1680, 2080]);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], '--page-max grows monotonically');
  }
  assert.match(rule('.page-container'), /max-width:\s*var\(--page-max\)/, 'the column uses the token');
});

/** Body of the first rule whose selector list contains `selector`. */
function rule(selector) {
  const css = `${layout}\n${components}\n${pages}\n${responsive}`;
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `expected a rule for ${selector}`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `expected a declaration block for ${selector}`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces for ${selector}`);
}

test('wide screens get more columns, not wider cards', () => {
  for (const query of ['min-width: 1440px', 'min-width: 1920px', 'min-width: 2560px']) {
    const block = mediaBlock(responsive, query);
    assert.match(block, /\.model-library[^{]*\{[^}]*grid-template-columns/, `${query}: model grid`);
    assert.match(block, /\.dataset-library[^{]*\{[^}]*grid-template-columns/, `${query}: dataset grid`);
  }
  const hd = mediaBlock(responsive, 'min-width: 1920px');
  assert.match(hd, /\.dashboard-grid[^{]*\{[^}]*repeat\(\s*6/, 'a 1080p TV shows 6 stat cards per row');
  assert.match(mediaBlock(responsive, 'min-width: 2560px'), /\.dashboard-grid[^{]*\{[^}]*repeat\(\s*8/, '4K shows 8');
});

test('charts are capped so a TV does not get billboard canvases', () => {
  const hd = mediaBlock(responsive, 'min-width: 1920px');
  assert.match(hd, /\.chart-container[^{]*\{[^}]*max-height:\s*\d+vh/, 'chart height is viewport-capped');
  assert.match(hd, /\.chat-container[^{]*\{[^}]*max-width/, 'chat does not run the full width of a TV');
});

test('ultra-wide keeps a readable column instead of 32:9 text lines', () => {
  const ultrawide = mediaBlock(responsive, 'min-aspect-ratio: 21/9');
  assert.match(ultrawide, /--page-max:\s*min\(/, 'the column is capped against viewport width');
  assert.match(ultrawide, /78vw|80vw/, 'the cap is relative to the viewport');
  assert.match(ultrawide, /margin-inline:\s*auto/, 'content stays centred');
  assert.match(ultrawide, /max-width:\s*\d+ch/, 'body copy is limited to a readable measure');
});

test('tall and portrait windows keep a narrow column', () => {
  const portrait = mediaBlock(responsive, 'min-aspect-ratio: 1/2');
  assert.match(portrait, /--page-max:\s*\d+px/);
  assert.match(variables, /--space-|--text-/, 'the design still runs on tokens');
});

test('remotes and keyboards get an unmistakable focus ring', () => {
  const noHover = mediaBlock(responsive, '(hover: none), (pointer: coarse)');
  assert.match(noHover, /:focus-visible[^{]*\{[^}]*outline:\s*3px/, 'thick ring for touch/remote');
  const large = mediaBlock(responsive, 'min-width: 1600px');
  assert.match(large, /:focus-visible[^{]*\{[^}]*outline:\s*3px/, 'thick ring on large displays');

  const big = mediaBlock(responsive, 'min-width: 1920px');
  assert.match(big, /\.btn[^{]*\{[^}]*min-height/, 'controls grow for viewing distance');
  assert.match(big, /\.nav-link[^{]*\{[^}]*min-height/, 'nav targets grow for DPad use');
});

test('print and low-power paths keep their guards', () => {
  const print = mediaBlock(responsive, 'print');
  assert.match(print, /\.sidebar[\s\S]*display:\s*none\s*!important/, 'chrome is hidden when printing');
  assert.match(responsive, /@media \(prefers-reduced-motion: reduce\)/, 'reduced motion is respected');
});

test('no large-display rule escapes the token system with a fixed pixel width', () => {
  for (const css of [responsive, pages, layout]) {
    // Declarations only — `@media (min-width: 1920px)` is a query, not a box.
    assert.doesNotMatch(css, /[;{]\s*width:\s*(?:19[2-9]\d|2\d{3})px/, 'no fixed 1920px+-wide boxes');
    assert.doesNotMatch(css, /[;{]\s*min-width:\s*(?:19[2-9]\d|2\d{3})px/, 'no fixed min-width for content columns');
    assert.doesNotMatch(css, /[;{]\s*max-width:\s*(?:19[2-9]\d|2\d{3})px/, 'content columns use --page-max');
  }
  // Fluid grids everywhere a card list exists.
  for (const selector of ['.model-library', '.dataset-library', '.dashboard-grid']) {
    const body = rule(selector);
    assert.match(
      body,
      /grid-template-columns:\s*repeat\(auto-(?:fit|fill),\s*minmax\(min\(100%,\s*\d+px\),\s*1fr\)\)|repeat\(\s*\d+,\s*minmax\(0,\s*1fr\)\)/,
      `${selector} must be fluid`
    );
  }
});

test('the file-picker overlay survives the responsive layer', () => {
  // The mobile fix and the display scaling must not fight: the overlay has to
  // stay a tap target at every breakpoint.
  assert.match(responsive, /\.drop-zone > input\[type="file"\][^{]*\{[^}]*pointer-events:\s*auto/s);
  assert.doesNotMatch(components, /\.drop-zone > input\[type="file"\][^{]*\{[^}]*appearance:\s*none/s);
});


test('training chart empty placeholders stay inside their chart and cannot overlap logs', () => {
  const chartContainer = components.match(/\.chart-container\s*\{[^}]*\}/s);
  const chartEmpty = components.match(/\.chart-empty\s*\{[^}]*\}/s);
  assert.ok(chartContainer, 'chart container rule exists');
  assert.ok(chartEmpty, 'chart empty rule exists');
  assert.match(chartContainer[0], /position:\s*relative/);
  assert.match(chartContainer[0], /overflow:\s*hidden/);
  assert.match(chartEmpty[0], /position:\s*absolute/);
  assert.match(chartEmpty[0], /inset:\s*0/);
  assert.match(chartEmpty[0], /height:\s*auto/);
  assert.match(chartEmpty[0], /min-height:\s*0/);
});
