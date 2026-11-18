/* ========================================
   CORPUS ULTIMATE — Shared Application Context
   ========================================

   Provides a single, properly scoped reference to the shared page container
   and other application-wide state that all modules can access safely.
   ======================================== */

window.CORPUS_APP = (function () {
  'use strict';

  let pageContainer = null;
  let initialized = false;
  const initListeners = [];
  const errorLog = [];
  const debugMode = (function () {
    try {
      return window.location.search.includes('?debug=1') ||
        window.location.search.includes('&debug=1');
    } catch (e) {
      return false;
    }
  })();

  // Any "this data changed" event invalidates the short-lived read cache before
  // the interested pages re-read it. Without this the pages would paint the
  // cached (pre-upload / pre-delete) list and look wrong for up to the TTL.
  const CACHE_CHANGE_EVENTS = [
    'corpus:datasets-changed',
    'corpus:models-changed',
    'corpus:training-changed',
    'corpus:checkpoints-changed',
  ];

  function wireCacheInvalidation() {
    try {
      CACHE_CHANGE_EVENTS.forEach((name) => {
        window.addEventListener(name, () => {
          if (window.CORPUS_API && typeof window.CORPUS_API.invalidateCache === 'function') {
            window.CORPUS_API.invalidateCache();
          }
        });
      });
    } catch (e) {
      // Event wiring must never break the application.
    }
  }

  function logDiagnostic(message, data) {
    const entry = {
      time: new Date().toISOString(),
      message: String(message),
      data: data || null,
    };
    errorLog.push(entry);
    if (debugMode) {
      try {
        console.log('[CORPUS DEBUG]', entry.message, entry.data || '');
      } catch (e) {}
    }
  }

  function getDiagnostics() {
    return {
      debugMode: debugMode,
      pageContainerAvailable: pageContainer !== null,
      initialized: initialized,
      errorLog: errorLog.slice(),
      errorCount: errorLog.length,
      // Real in-browser measurements (load, navigation, API, long tasks). Only
      // aggregate numbers and route paths — never tokens or user data.
      perf: (window.CORPUS_PERF && typeof window.CORPUS_PERF.snapshot === 'function')
        ? window.CORPUS_PERF.snapshot() : null,
    };
  }

  function recordError(source, message, error) {
    const entry = {
      time: new Date().toISOString(),
      source: String(source),
      message: String(message),
      error: error ? (error.message || String(error)) : null,
      stack: error && error.stack ? String(error.stack).split('\n').slice(0, 5).join('\n') : null,
    };
    errorLog.push(entry);
    if (errorLog.length > 200) errorLog.shift();
    if (debugMode) {
      try {
        console.error('[CORPUS ERROR]', source, message, error || '');
      } catch (e) {}
    }
  }

  function setPageContainer(element) {
    pageContainer = element;
    logDiagnostic('pageContainer set', element ? 'found' : 'null');
    // Notify any init listeners waiting for the container
    initListeners.forEach(fn => {
      try { fn(pageContainer); } catch (e) {}
    });
  }

  function getPageContainer() {
    return pageContainer;
  }

  function requirePageContainer(source) {
    if (!pageContainer) {
      const err = new Error('pageContainer is not available in the DOM yet');
      recordError(source, err.message, err);
      throw err;
    }
    return pageContainer;
  }

  function onInit(callback) {
    if (typeof callback !== 'function') return;
    if (initialized) {
      try { callback(); } catch (e) {}
    } else {
      initListeners.push(callback);
    }
  }

  function markInitialized() {
    initialized = true;
    logDiagnostic('application initialized');
  }

  function isInitialized() {
    return initialized;
  }

  return {
    logDiagnostic,
    getDiagnostics,
    recordError,
    setPageContainer,
    getPageContainer,
    requirePageContainer,
    onInit,
    markInitialized,
    isInitialized,
    debugMode,
  };
  wireCacheInvalidation();

})();
