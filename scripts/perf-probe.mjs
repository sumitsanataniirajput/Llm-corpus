#!/usr/bin/env node
/**
 * CORPUS ULTIMATE — interaction performance probe.
 *
 * Measures the things a user actually feels, against the real router and the
 * real page modules, with a configurable simulated backend latency:
 *
 *   1. navigation latency          (click → page content on screen)
 *   2. click swallowing            (a nav click made while another is loading)
 *   3. request amplification       (API calls per navigation cycle)
 *   4. main-thread block           (synchronous JS time inside the cycle)
 *   5. first paint vs data paint   (does anything appear before the data?)
 *   6. leftover timers/listeners   (leaks after leaving a page)
 *
 * Usage:
 *   node scripts/perf-probe.mjs                 # default: 120 ms latency, 60 datasets/models
 *   node scripts/perf-probe.mjs --latency=1200  # cold Render backend
 *   node scripts/perf-probe.mjs --json          # machine readable
 */
import { bootFullApp, waitFor } from '../frontend/tests/full-app-harness.mjs';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : fallback;
}
const LATENCY = Number(arg('latency', 120));
const DATASETS = Number(arg('datasets', 60));
const MODELS = Number(arg('models', 60));
const JOBS = Number(arg('jobs', 20));
const JSON_OUT = args.includes('--json');

// Real route keys from frontend/js/router.js. (A wrong key silently falls back
// to Dashboard, which would make every measurement look identical.)
const ROUTES = [
  'dashboard', 'models', 'datasets', 'training', 'statistics', 'chat',
  'evaluation', 'compute', 'cloud-storage', 'experiments', 'settings',
  'prediction-lab', 'neural-lab', 'ai-information',
];

function now() { return Number(process.hrtime.bigint() / 1000000n); }

async function measureNavigation(window, container, route) {
  const cpuBefore = process.cpuUsage();
  const started = now();
  let firstPaint = -1;
  const waitPaint = (async () => {
    firstPaint = await waitFor(() => container.children.length > 0, { timeoutMs: 8000 });
  })();
  const nav = window.router.navigate(route);
  const settled = await Promise.race([
    nav.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  await waitPaint;
  const elapsed = now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  return { route, elapsed, firstPaint, settled, cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
}

async function main() {
  const app = bootFullApp({ latencyMs: LATENCY, datasets: DATASETS, models: MODELS, jobs: JOBS });
  const { window, container } = app;

  // Let the bootstrap settle (it renders the initial route).
  await new Promise((resolve) => setTimeout(resolve, LATENCY * 2 + 120));

  const results = { config: { latencyMs: LATENCY, datasets: DATASETS, models: MODELS, jobs: JOBS }, navigations: [], totals: {} };

  // --- 1/2/3/4: a full cycle over every route ------------------------------
  app.calls.length = 0;
  const cpuStart = process.cpuUsage();
  for (const route of ROUTES) {
    results.navigations.push(await measureNavigation(window, container, route));
  }
  const cpu = process.cpuUsage(cpuStart);
  results.totals.cycleCpuMs = Math.round((cpu.user + cpu.system) / 1000);
  results.totals.requestsPerCycle = app.calls.length;
  results.totals.requestsByRoute = app.calls.reduce((acc, call) => {
    acc[call.route] = (acc[call.route] || 0) + 1;
    return acc;
  }, {});

  // --- repeat the cycle: how much of it is re-fetching unchanged data? -----
  app.calls.length = 0;
  for (const route of ROUTES) {
    await measureNavigation(window, container, route);
  }
  results.totals.requestsSecondCycle = app.calls.length;
  results.totals.requestsSecondCycleByRoute = app.calls.reduce((acc, call) => {
    acc[call.route] = (acc[call.route] || 0) + 1;
    return acc;
  }, {});

  // --- 2: does a click during a pending navigation get swallowed? ----------
  const slowStart = now();
  window.router.navigate('models');
  const second = await Promise.race([
    window.router.navigate('datasets').then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ]);
  await waitFor(() => window.location.hash.includes('datasets') || window.location.hash.includes('models'), { timeoutMs: 8000 });
  await new Promise((resolve) => setTimeout(resolve, LATENCY * 2 + 60));
  results.totals.secondClickDuringNavigation = second;
  results.totals.routeAfterRapidClicks = window.location.hash;
  results.totals.rapidClickWindowMs = now() - slowStart;

  // --- 5: network activity while idle (polling / reconnect storms) ---------
  const idleStart = app.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  results.totals.idleRequestsIn1500ms = app.calls.length - idleStart;

  // --- 6: leftovers -------------------------------------------------------
  results.totals.pendingTimers = app.pendingTimers.size;
  results.totals.pendingIntervals = app.pendingIntervals.size;
  results.totals.socketsOpened = app.sockets.length;
  results.totals.listeners = { ...app.listeners };
  results.totals.domNodes = window.document.querySelectorAll('*').length;

  app.close();

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const navRow = (n) => `  ${n.route.padEnd(16)} ${String(n.elapsed).padStart(6)} ms   cpu ${String(n.cpuMs).padStart(5)} ms   first paint ${n.firstPaint < 0 ? '   never' : String(n.firstPaint).padStart(5) + ' ms'}${n.settled ? '' : '   (DID NOT SETTLE)'}`;
  console.log('CORPUS ULTIMATE — interaction performance probe');
  console.log(`backend latency ${LATENCY} ms · datasets ${DATASETS} · models ${MODELS} · jobs ${JOBS}\n`);
  console.log('navigation latency (click → data on screen):');
  for (const n of results.navigations) console.log(navRow(n));
  const worst = Math.max(...results.navigations.map((n) => n.elapsed));
  const avg = Math.round(results.navigations.reduce((s, n) => s + n.elapsed, 0) / results.navigations.length);
  console.log(`\n  average ${avg} ms · worst ${worst} ms`);
  console.log(`  API requests, first cycle   : ${results.totals.requestsPerCycle}`);
  console.log(`  API requests, second cycle  : ${results.totals.requestsSecondCycle}  (repeat views of unchanged data)`);
  console.log(`  CPU time for one cycle      : ${results.totals.cycleCpuMs} ms`);
  console.log(`  click during a pending nav  : ${results.totals.secondClickDuringNavigation} → route ${results.totals.routeAfterRapidClicks}`);
  console.log(`  requests while idle 1.5 s   : ${results.totals.idleRequestsIn1500ms}`);
  console.log(`  leftover timers/intervals   : ${results.totals.pendingTimers} / ${results.totals.pendingIntervals}`);
  console.log(`  WebSockets opened           : ${results.totals.socketsOpened}`);
  console.log(`  DOM nodes at end            : ${results.totals.domNodes}`);
  console.log('\n  requests by endpoint:');
  for (const [route, count] of Object.entries(results.totals.requestsByRoute).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(3)}  ${route}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
