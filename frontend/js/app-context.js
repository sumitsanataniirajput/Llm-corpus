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
})();