/** P2 — real numeric line charts with ranges, downsampling, zoom and reset. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './harness.mjs';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chartsSource = fs.readFileSync(path.join(FRONTEND, 'js/charts.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(FRONTEND, 'css/components.css'), 'utf8');
const pageSources = ['dashboard.js', 'statistics.js', 'training.js', 'intelligence.js']
  .map((name) => fs.readFileSync(path.join(FRONTEND, 'js', name), 'utf8'));

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
  return app;
}

function addCanvas(app, id, rectWidth = 400) {
  const container = app.doc.createElement('div');
  container.className = 'chart-container';
  const canvas = app.doc.createElement('canvas');
  canvas.id = id;
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: rectWidth, height: 220,
    right: rectWidth, bottom: 220, x: 0, y: 0,
  });
  container.appendChild(canvas);
  app.doc.getElementById('page-container').appendChild(container);
  return { canvas, container };
}

function toolbar(app, id) {
  return app.doc.querySelector(`.corpus-chart-toolbar[data-chart-id="${id}"]`);
}

test('numeric step labels become a linear x/y chart with a visible range', () => {
  const app = freshApp();
  addCanvas(app, 'loss-chart');
  const chart = app.window.charts.createLineChart(
    'loss-chart',
    ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5'],
    [{ label: 'Loss', data: [2.5, 2.1, 1.8, 1.9, 1.2] }],
    { plugins: { legend: { display: false } } }
  );
  assert.ok(chart, 'Chart.js instance created');
  const state = app.window.charts.chartState('loss-chart');
  assert.equal(state.numeric, true);
  assert.equal(state.xType, 'linear');
  assert.equal(state.yType, 'linear');
  assert.equal(state.paddingTop >= 44, true);
  assert.equal(state.datasets[0].data[0].x, 1);
  assert.equal(state.datasets[0].data[0].y, 2.5);
  assert.equal(state.xMin, 1);
  assert.equal(state.xMax, 5);
  assert.equal(state.total, 5);
  assert.equal(state.downsampled, false);

  const bar = toolbar(app, 'loss-chart');
  assert.ok(bar, 'toolbar installed');
  assert.match(bar.querySelector('.corpus-chart-range').textContent, /x 1–5 · y 1\.2–2\.5/);
  assert.equal(bar.querySelector('.corpus-chart-points').textContent, '5 points');
  assert.equal(bar.querySelector('.corpus-chart-reset').disabled, true);
  assert.equal(chart.config.options.plugins.legend.display, false, 'caller options survived deep merge');
});

test('zoom buttons and Reset change and restore the numeric x range', () => {
  const app = freshApp();
  addCanvas(app, 'zoom-chart');
  app.window.charts.createLineChart(
    'zoom-chart',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [{ label: 'Loss', data: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] }]
  );
  const bar = toolbar(app, 'zoom-chart');
  bar.querySelector('.corpus-chart-zoom-in').click();
  let state = app.window.charts.chartState('zoom-chart');
  assert.ok(state.view[0] > 0 || state.view[1] < 1, 'view is zoomed');
  assert.ok(state.xMin > 1 || state.xMax < 10, 'scale range narrowed');
  assert.equal(bar.querySelector('.corpus-chart-reset').disabled, false);

  bar.querySelector('.corpus-chart-zoom-out').click();
  bar.querySelector('.corpus-chart-reset').click();
  state = app.window.charts.chartState('zoom-chart');
  assert.deepEqual(Array.from(state.view), [0, 1]);
  assert.equal(state.xMin, 1);
  assert.equal(state.xMax, 10);
  assert.equal(bar.querySelector('.corpus-chart-reset').disabled, true);
});

test('drag-to-zoom maps canvas pixels to a real sub-range', () => {
  const app = freshApp();
  const { canvas } = addCanvas(app, 'drag-chart');
  app.window.charts.createLineChart(
    'drag-chart',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [{ label: 'Loss', data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }]
  );
  const mouse = (type, clientX) => canvas.dispatchEvent(new app.window.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX,
  }));
  mouse('mousedown', 50);
  mouse('mousemove', 200);
  mouse('mouseup', 350);
  const state = app.window.charts.chartState('drag-chart');
  assert.ok(state.view[0] > 0, 'drag start moved into the series');
  assert.ok(state.view[1] < 1, 'drag end moved before the last point');
  app.window.charts.resetChart('drag-chart');
  assert.deepEqual(Array.from(app.window.charts.chartState('drag-chart').view), [0, 1]);
});

test('large series are downsampled without hiding spikes or endpoints', () => {
  const app = freshApp();
  addCanvas(app, 'big-chart');
  const labels = Array.from({ length: 1000 }, (_, index) => index + 1);
  const values = labels.map((step) => Math.sin(step / 25) * 4 + 10);
  values[500] = 1000;
  app.window.charts.createLineChart(
    'big-chart', labels, [{ label: 'Loss', data: values }]
  );
  const state = app.window.charts.chartState('big-chart');
  assert.equal(state.total, 1000);
  assert.equal(state.downsampled, true);
  assert.ok(state.shown <= 240 && state.shown >= 8);
  assert.equal(state.datasets[0].data[0].y, values[0]);
  assert.equal(state.datasets[0].data[state.datasets[0].data.length - 1].y, values[999]);
  assert.equal(state.datasets[0].data.some((point) => point.y === 1000), true, 'spike preserved');
  const bar = toolbar(app, 'big-chart');
  assert.match(bar.querySelector('.corpus-chart-points').textContent, /min\/max kept/);
});

test('category charts keep their labels and still receive zoom/reset controls', () => {
  const app = freshApp();
  addCanvas(app, 'days-chart');
  app.window.charts.createLineChart(
    'days-chart',
    ['Nov 13', 'Nov 14', 'Nov 15', 'Nov 16', 'Nov 17', 'Nov 18', 'Nov 19'],
    [{ label: 'Jobs created', data: [0, 1, 0, 3, 2, 1, 4] }]
  );
  const state = app.window.charts.chartState('days-chart');
  assert.equal(state.numeric, false);
  assert.equal(state.xType, 'category');
  assert.equal(state.yType, 'linear');
  assert.equal(state.xMin, 0);
  assert.equal(state.xMax, 6);
  assert.equal(typeof state.datasets[0].data[0], 'number');
  assert.ok(toolbar(app, 'days-chart').querySelector('.corpus-chart-reset'));
});

test('live updates preserve the user zoom instead of silently resetting it', () => {
  const app = freshApp();
  addCanvas(app, 'live-chart');
  app.window.charts.createLineChart(
    'live-chart', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [{ label: 'Loss', data: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] }]
  );
  app.window.charts.zoomChart('live-chart', 0.5);
  const before = app.window.charts.chartState('live-chart').view;
  app.window.charts.updateChart(
    'live-chart',
    Array.from({ length: 20 }, (_, index) => index + 1),
    [{ label: 'Loss', data: Array.from({ length: 20 }, (_, index) => 20 - index) }],
    { animate: false }
  );
  const afterState = app.window.charts.chartState('live-chart');
  assert.deepEqual(Array.from(afterState.view), Array.from(before));
  assert.equal(afterState.total, 20);
  assert.equal(toolbar(app, 'live-chart').querySelector('.corpus-chart-reset').disabled, false);
});

test('destroyChart removes the toolbar, listeners and chart instance', () => {
  const app = freshApp();
  const { canvas } = addCanvas(app, 'dispose-chart');
  app.window.charts.createLineChart(
    'dispose-chart', [1, 2, 3], [{ label: 'Loss', data: [3, 2, 1] }]
  );
  assert.ok(toolbar(app, 'dispose-chart'));
  app.window.charts.destroyChart('dispose-chart');
  assert.equal(toolbar(app, 'dispose-chart'), null);
  assert.equal(canvas.hasAttribute('data-corpus-chart'), false);
  assert.equal(app.window.charts.instances()['dispose-chart'], undefined);
  assert.equal(app.window.charts.chartState('dispose-chart'), null);
});

test('all four telemetry pages share the line-chart helper and its CSS contract', () => {
  pageSources.forEach((source) => assert.match(source, /createLineChart/));
  assert.match(chartsSource, /downsampleSeries/);
  assert.match(chartsSource, /resetChart/);
  assert.match(chartsSource, /'wheel'/);
  assert.match(chartsSource, /Reset zoom/);
  assert.match(cssSource, /\.corpus-chart-toolbar\s*\{/);
  assert.match(cssSource, /min-height:\s*44px/);
});
