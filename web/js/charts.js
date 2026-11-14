// Chart.js wrappers. Charts always draw the data they are given — when there is no
// data the chart area shows an explicit empty state instead of an invented curve.
import { money, number } from './utilities.js';

const registry = new Map();          // canvas -> Chart
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const palette = () => ['--primary', '--success', '--warning', '--violet', '--info', '--danger', '--text-3'].map(css);
const alpha = (color, a) => {
  if (color.startsWith('#')) { const n = parseInt(color.slice(1).length === 3 ? color.slice(1).replace(/./g, '$&$&') : color.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
  return color;
};
const fmt = { money: (v) => money(v, { compact: true }), number: (v) => number(v), percent: (v) => `${v}%` };

function baseOptions(format, { stacked = false, legend = true, horizontal = false } = {}) {
  const grid = css('--chart-grid'), text = css('--chart-text'); const f = fmt[format] ?? fmt.number;
  const value = { ticks: { color: text, callback: (v) => f(v), maxTicksLimit: 6 }, grid: { color: grid }, border: { display: false }, beginAtZero: true, stacked };
  const category = { ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false }, border: { color: grid }, stacked };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: legend, position: 'bottom', labels: { color: text, usePointStyle: true, boxWidth: 8, padding: 14 } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label ?? c.label}: ${f(c.parsed[horizontal ? 'x' : 'y'] ?? c.parsed)}` } } },
    scales: horizontal ? { x: value, y: category } : { x: category, y: value },
  };
}

function mount(canvas, config, isEmpty) {
  const box = canvas.parentElement;
  registry.get(canvas)?.destroy(); registry.delete(canvas);
  box.querySelector('.state')?.remove();
  if (isEmpty) {
    canvas.hidden = true;
    box.insertAdjacentHTML('beforeend', '<div class="state"><i class="fa-regular fa-chart-bar"></i><h4>No data for this period</h4><p>Charts fill in as real rides and payments are recorded.</p></div>');
    return null;
  }
  canvas.hidden = false;
  const chart = new window.Chart(canvas, config);
  registry.set(canvas, chart);
  return chart;
}
const allZero = (datasets) => datasets.every((d) => (d.data ?? []).every((v) => !Number(v)));

export function lineChart(canvas, { labels, datasets, format = 'number', fill = true }) {
  const colors = palette();
  return mount(canvas, { type: 'line', data: { labels, datasets: datasets.map((d, i) => ({ borderColor: d.color ?? colors[i % colors.length], backgroundColor: alpha(d.color ?? colors[i % colors.length], .12),
    fill: fill && datasets.length === 1, tension: .3, pointRadius: labels.length > 40 ? 0 : 2, borderWidth: 2, borderDash: d.dashed ? [6, 4] : undefined, ...d })) },
    options: baseOptions(format, { legend: datasets.length > 1 }) }, !labels.length || allZero(datasets));
}
export function barChart(canvas, { labels, datasets, format = 'number', stacked = false, horizontal = false }) {
  const colors = palette();
  return mount(canvas, { type: 'bar', data: { labels, datasets: datasets.map((d, i) => ({ backgroundColor: d.color ?? colors[i % colors.length], borderRadius: 5, maxBarThickness: 34, ...d })) },
    options: baseOptions(format, { stacked, legend: datasets.length > 1, horizontal }) }, !labels.length || allZero(datasets));
}
export function doughnutChart(canvas, { labels, data, format = 'number' }) {
  const colors = palette(); const f = fmt[format] ?? fmt.number;
  return mount(canvas, { type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '64%', animation: { duration: 250 },
      plugins: { legend: { position: 'bottom', labels: { color: css('--chart-text'), usePointStyle: true, boxWidth: 8, padding: 12 } }, tooltip: { callbacks: { label: (c) => `${c.label}: ${f(c.parsed)}` } } } } },
  !labels.length || data.every((v) => !Number(v)));
}
/** Destroy charts inside a container (called when a page is left). */
export function destroyCharts(root = document) {
  for (const [canvas, chart] of registry) if (!canvas.isConnected || root.contains(canvas)) { chart.destroy(); registry.delete(canvas); }
}
/** Re-colour charts after a theme switch. */
export function refreshChartTheme() {
  const grid = css('--chart-grid'), text = css('--chart-text');
  for (const chart of registry.values()) {
    for (const s of Object.values(chart.options.scales ?? {})) { if (s.ticks) s.ticks.color = text; if (s.grid && s.grid.display !== false) s.grid.color = grid; }
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = text;
    chart.update('none');
  }
}
/** Bucket label for a time-series point. */
export function bucketLabel(iso, bucket) {
  const d = new Date(iso);
  if (bucket === 'hour') return d.toLocaleTimeString('en-IN', { hour: 'numeric', hour12: true });
  if (bucket === 'month') return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
