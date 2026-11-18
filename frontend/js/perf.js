/* ========================================
   CORPUS ULTIMATE — Performance instrumentation
   ========================================

   Real measurements, collected in the browser, for the numbers this app is
   judged on: how long a page takes to appear, how long an API call takes, how
   long the main thread was blocked, and whether anything failed or timed out.

   Design rules:
     - No third-party library, no network calls, no extra requests.
     - Nothing sensitive is recorded: route paths only (query strings and tokens
       are stripped), never headers, bodies, emails or keys.
     - Bounded memory: fixed-size ring buffers, so instrumentation can never be
       the reason a long session slows down.
     - Silent in normal use; readable in the console with ?debug=1 and through
       CORPUS_APP.getDiagnostics().perf.

   Usage from the console:
     CORPUS_PERF.snapshot()        // everything, as one object
     CORPUS_PERF.print()           // formatted table
     CORPUS_PERF.reset()
   ======================================== */

window.CORPUS_PERF = (function () {
  'use strict';

  const LIMIT = 80;

  function now() {
    try {
      return (window.performance && performance.now) ? performance.now() : Date.now();
    } catch (e) {
      return Date.now();
    }
  }

  const load = {
    startedAt: Date.now(),
    domContentLoadedMs: null,
    loadEventMs: null,
    firstContentfulPaintMs: null,
    firstPaintMs: null,
    timeToInteractiveMs: null,
    scriptsEvalMs: null,
  };

  const navigations = [];      // { route, ms, at }
  const apiCalls = [];         // { route, ms, ok, status }
  const apiAggregate = new Map(); // route -> { count, totalMs, maxMs, failures, timeouts }
  const interactions = [];     // { label, ms }
  const longTasks = [];        // { ms, at }
  const failures = [];         // { kind, route, message, at }

  function pushRing(list, entry) {
    list.push(entry);
    if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
  }

  /** Strip query strings and anything token-shaped from a URL/path. */
  function safeRoute(route) {
    const raw = String(route == null ? '' : route);
    const noQuery = raw.split('?')[0];
    const normalised = noQuery.replace(/\/+$/, '') || '/';
    return normalised.length > 120 ? normalised.slice(0, 120) : normalised;
  }

  function recordNavigation(route, ms, extra) {
    const entry = { route: safeRoute(route), ms: Math.round(ms), at: Date.now(), ...(extra || {}) };
    pushRing(navigations, entry);
    return entry;
  }

  function recordApi(route, ms, ok, status) {
    const key = safeRoute(route);
    const rounded = Math.round(ms);
    pushRing(apiCalls, { route: key, ms: rounded, ok: !!ok, status: status || 0, at: Date.now() });
    let agg = apiAggregate.get(key);
    if (!agg) {
      agg = { count: 0, totalMs: 0, maxMs: 0, failures: 0, timeouts: 0 };
      apiAggregate.set(key, agg);
    }
    agg.count += 1;
    agg.totalMs += rounded;
    agg.maxMs = Math.max(agg.maxMs, rounded);
    if (!ok) {
      agg.failures += 1;
      if (status === 0) agg.timeouts += 1;
      pushRing(failures, { kind: 'api', route: key, status: status || 0, at: Date.now() });
    }
    return rounded;
  }

  function recordInteraction(label, ms) {
    pushRing(interactions, { label: String(label).slice(0, 60), ms: Math.round(ms), at: Date.now() });
  }

  function recordFailure(kind, route, message) {
    pushRing(failures, {
      kind: String(kind).slice(0, 30),
      route: safeRoute(route),
      message: String(message == null ? '' : message).slice(0, 200),
      at: Date.now(),
    });
  }

  /** Wrap an async action and measure how long it took (interaction latency). */
  async function measure(label, fn) {
    const started = now();
    try {
      return await fn();
    } finally {
      recordInteraction(label, now() - started);
    }
  }

  function summarise(list, key) {
    if (!list.length) return { count: 0, avgMs: 0, maxMs: 0 };
    const values = list.map((item) => item[key]);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      count: values.length,
      avgMs: Math.round(total / values.length),
      maxMs: Math.max.apply(null, values),
    };
  }

  function memoryInfo() {
    const mem = window.performance && performance.memory;
    if (!mem) return null;
    return {
      usedHeapMb: Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10,
      totalHeapMb: Math.round((mem.totalJSHeapSize / 1048576) * 10) / 10,
      limitMb: Math.round((mem.jsHeapSizeLimit / 1048576) * 10) / 10,
    };
  }

  function snapshot() {
    const byEndpoint = [];
    apiAggregate.forEach((agg, route) => {
      byEndpoint.push({
        route,
        count: agg.count,
        avgMs: Math.round(agg.totalMs / agg.count),
        maxMs: agg.maxMs,
        failures: agg.failures,
        timeouts: agg.timeouts,
      });
    });
    byEndpoint.sort((a, b) => b.avgMs - a.avgMs);

    return {
      load: { ...load },
      navigations: {
        ...summarise(navigations, 'ms'),
        slowest: navigations.slice().sort((a, b) => b.ms - a.ms).slice(0, 5),
      },
      api: {
        ...summarise(apiCalls, 'ms'),
        byEndpoint,
        recent: apiCalls.slice(-10),
      },
      interactions: { ...summarise(interactions, 'ms'), recent: interactions.slice(-5) },
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((sum, task) => sum + task.ms, 0),
        maxMs: longTasks.reduce((max, task) => Math.max(max, task.ms), 0),
      },
      failures: failures.slice(-10),
      memory: memoryInfo(),
      cache: window.CORPUS_API && window.CORPUS_API.cacheStats ? window.CORPUS_API.cacheStats() : null,
      visibility: document.visibilityState,
    };
  }

  function print() {
    const snap = snapshot();
    try {
      console.group('%cCORPUS ULTIMATE — performance', 'color:#b9a7ff;font-weight:600');
      console.log('load', snap.load);
      console.log('navigations', snap.navigations);
      console.log('api', snap.api);
      console.log('interactions', snap.interactions);
      console.log('long tasks', snap.longTasks);
      console.log('cache', snap.cache, 'memory', snap.memory);
      if (snap.failures.length) console.warn('failures', snap.failures);
      console.groupEnd();
    } catch (e) { /* console may be unavailable */ }
  }

  function reset() {
    navigations.length = 0;
    apiCalls.length = 0;
    apiAggregate.clear();
    interactions.length = 0;
    longTasks.length = 0;
    failures.length = 0;
  }

  function install() {
    if (window.__corpusPerfInstalled) return;
    window.__corpusPerfInstalled = true;

    // Paint timings + navigation timing (no custom performance marks needed).
    try {
      const nav = window.performance && performance.getEntriesByType
        ? performance.getEntriesByType('navigation')[0] : null;
      if (nav) {
        load.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd || 0);
        load.loadEventMs = Math.round(nav.loadEventEnd || 0);
      }
    } catch (e) { /* older browsers */ }

    try {
      if (typeof PerformanceObserver === 'function') {
        const paintObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            if (entry.name === 'first-paint') load.firstPaintMs = Math.round(entry.startTime);
            if (entry.name === 'first-contentful-paint') load.firstContentfulPaintMs = Math.round(entry.startTime);
          });
        });
        paintObserver.observe({ type: 'paint', buffered: true });

        // Long tasks (> 50 ms of uninterrupted main-thread work) are exactly
        // what the user feels as "frozen".
        const longTaskObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            pushRing(longTasks, { ms: Math.round(entry.duration), at: Date.now() });
          });
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
      }
    } catch (e) { /* unsupported: measurements are optional */ }

    // Time to interactive, approximated honestly: from navigation start to the
    // moment the bootstrap reports the first route rendered.
    document.addEventListener('DOMContentLoaded', () => {
      load.domContentLoadedMs = load.domContentLoadedMs || Math.round(now());
    }, { once: true });
    window.addEventListener('load', () => {
      load.loadEventMs = Math.round(now());
    }, { once: true });

    if (window.CORPUS_APP && typeof window.CORPUS_APP.logDiagnostic === 'function') {
      window.CORPUS_APP.logDiagnostic('perf: instrumentation installed');
    }
    if (window.location && /[?&]debug=1/.test(window.location.search)) {
      window.setTimeout(print, 4000);
    }
  }

  function markInteractive() {
    load.timeToInteractiveMs = Math.round(now());
  }

  return {
    install,
    markInteractive,
    now,
    recordNavigation,
    recordApi,
    recordInteraction,
    recordFailure,
    measure,
    snapshot,
    print,
    reset,
    safeRoute,
  };
})();
