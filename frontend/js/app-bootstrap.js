/* ========================================
   CORPUS ULTIMATE — Application Bootstrap
   ========================================

   Initializes the application: DOM ready check, module verification,
   Supabase client initialization, authentication initialization,
   router initialization, and initial route rendering.

   Authentication flow (single source of truth):
   1. CORPUS_SUPABASE.init() — create Supabase client
   2. auth.init() — subscribe to auth state changes, restore session
   3. auth's onAuthStateChange (INITIAL_SESSION) sets state.setAuthReady(true)
   4. router.init() — register navigation listeners
   5. router.render() — render initial page with correct auth state
   ======================================== */

window.CORPUS_BOOTSTRAP = (function () {
  'use strict';

  let started = false;

  function log(message) {
    if (window.CORPUS_APP) {
      window.CORPUS_APP.logDiagnostic('bootstrap', message);
    }
    try { console.log('[CORPUS BOOT]', message); } catch (e) {}
  }

  function error(message, err) {
    if (window.CORPUS_APP) {
      window.CORPUS_APP.recordError('bootstrap', message, err);
    }
    try { console.error('[CORPUS BOOT ERROR]', message, err || ''); } catch (e) {}
  }

  function showBootstrapError(message) {
    const container = window.CORPUS_APP.getPageContainer();
    if (container) {
      container.innerHTML = `
        <div style="text-align:center; padding:var(--space-8); background:var(--color-surface); border:1px solid var(--color-error); border-radius:var(--radius-lg); margin:var(--space-6) auto; max-width:560px;">
          <div style="font-size:3rem; color:var(--color-error); margin-bottom:var(--space-3);">&#9888;</div>
          <h3 style="color:var(--color-text); margin:0 0 var(--space-2) 0;">Initialization failed</h3>
          <p style="color:var(--color-text-variant); margin:0 0 var(--space-4) 0; font-size:var(--text-body-small);">${escapeHtml(message)}</p>
          <button class="btn btn-primary" onclick="location.reload()">Retry</button>
        </div>
      `;
    }
  }

  function showSupabaseConfigBanner() {
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    const validation = window.CORPUS_VALIDATE_SUPABASE_CONFIG
      ? window.CORPUS_VALIDATE_SUPABASE_CONFIG()
      : { valid: false, errors: ['Supabase validation not available'] };

    let errorHtml = '';
    validation.errors.forEach(err => {
      errorHtml += `<div style="color:var(--color-error); font-size:var(--text-body-small); margin-bottom:var(--space-2);">&#9888; ${escapeHtml(err)}</div>`;
    });

    container.innerHTML = `
      <div style="text-align:center; padding:var(--space-8); background:var(--color-surface); border:1px solid var(--color-warning); border-radius:var(--radius-lg); margin:var(--space-6) auto; max-width:640px;">
        <div style="font-size:3rem; color:var(--color-warning); margin-bottom:var(--space-3);">&#9888;</div>
        <h3 style="color:var(--color-text); margin:0 0 var(--space-3) 0;">Supabase Not Configured</h3>
        <p style="color:var(--color-text-variant); margin:0 0 var(--space-4) 0; font-size:var(--text-body-small); line-height:1.5;">
          CORPUS ULTIMATE needs your Supabase credentials to authenticate and save your data.
        </p>
        ${errorHtml}
        <div style="background:var(--color-bg-muted); padding:var(--space-4); border-radius:var(--radius-md); text-align:left; margin-bottom:var(--space-4); font-family:monospace; font-size:var(--text-caption); color:var(--color-text-variant);">
          <strong>How to fix:</strong><br>
          1. Open <code>frontend/js/config.js</code> in your project files.<br>
          2. Set <code>SUPABASE_URL</code> to your Supabase project URL (e.g. https://abcdefgh.supabase.co).<br>
          3. Set <code>SUPABASE_ANON_KEY</code> to your public anon key from Supabase Dashboard → Settings → API.<br>
          4. Save the file and refresh this page.<br>
          <br>
          <strong>Never</strong> put your service_role key here — it must stay backend-only.
        </div>
        <button class="btn btn-primary" onclick="location.reload()">Retry after configuring</button>
      </div>
    `;
  }

  function escapeHtml(text) {
    if (text == null) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }

  function checkModules() {
    const required = [
      'CORPUS_CONFIG', 'CORPUS_UTILS', 'CORPUS_SUPABASE', 'CORPUS_API',
      'state', 'ui', 'router', 'auth',
    ];
    const missing = [];
    required.forEach(name => {
      if (typeof window[name] === 'undefined') {
        missing.push(name);
      }
    });
    if (missing.length > 0) {
      error('Missing required modules: ' + missing.join(', '));
      return false;
    }
    log('All required modules present');

    // Page modules are optional for boot but each one that failed to register
    // is named here, with the script that should have defined it, so the
    // console says exactly which file is broken instead of leaving the user
    // with a generic "module not loaded" page later. The list comes from the
    // same registry the router and the sidebar use (js/routes.js), so a module
    // added to the menu is verified here automatically.
    const registry = window.CORPUS_ROUTES;
    if (!registry) {
      error('Route registry (js/routes.js) did not load — no page can be routed.');
      return true;
    }
    const pageModules = registry.modules();
    const broken = pageModules.filter((entry) => {
      const page = window[entry.module];
      return !page || typeof page.render !== 'function';
    });
    if (broken.length) {
      error('Page modules not registered: ' +
        broken.map((entry) => entry.module + ' (' + entry.script + ', route #/' + entry.route + ')').join(', ') +
        ' — those pages will try to reload their script, then show diagnostics.');
    } else {
      log('All ' + pageModules.length + ' page modules registered with a render() function');
    }
    return true;
  }

  function checkPageContainer() {
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) {
      error('page-container element not found in DOM');
      return false;
    }
    log('pageContainer found');
    return true;
  }

  // Wait for authentication initialization to complete.
  // Polls state.isAuthReady() with a generous timeout.
  // If the timeout expires, we proceed anyway — the INITIAL_SESSION
  // event may still fire later and re-render via auth.js.
  async function waitForAuthReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (state.isAuthReady()) {
        log('Auth ready');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    log('Auth ready timeout — proceeding anyway (INITIAL_SESSION may still fire later)');
    return false;
  }

  async function start() {
    if (started) return;
    started = true;

    log('Starting application bootstrap');

    // Set page container reference
    const container = document.getElementById('page-container');
    window.CORPUS_APP.setPageContainer(container);

    if (!checkPageContainer()) {
      showBootstrapError('Main content container not found in the page.');
      return;
    }

    if (!checkModules()) {
      showBootstrapError('Required JavaScript modules failed to load. Check the browser console for details.');
      return;
    }

    // Validate Supabase configuration BEFORE initializing
    const validation = window.CORPUS_VALIDATE_SUPABASE_CONFIG
      ? window.CORPUS_VALIDATE_SUPABASE_CONFIG()
      : { valid: false, errors: ['Supabase validation not available'] };

    if (!validation.valid) {
      log('Supabase not configured — showing configuration banner');
      validation.errors.forEach(err => console.warn('[CORPUS] ' + err));
      showSupabaseConfigBanner();
      // Still initialize router so navigation works, but auth will be blocked
      try {
        window.router.init();
      } catch (err) {
        error('Router initialization failed', err);
        showBootstrapError('Router failed to initialize: ' + escapeHtml(err.message || String(err)));
        return;
      }
      try {
        window.auth.init();
      } catch (err) {
        error('Authentication initialization failed', err);
      }
      state.setAuthReady(true);
      window.CORPUS_APP.markInitialized();
      return;
    }

    // Supabase is configured — initialize client
    try {
      CORPUS_SUPABASE.init();
      log('Supabase client initialized');
    } catch (err) {
      error('Supabase initialization failed', err);
      showSupabaseConfigBanner();
      try {
        window.router.init();
      } catch (e2) {}
      try {
        window.auth.init();
      } catch (e2) {}
      state.setAuthReady(true);
      window.CORPUS_APP.markInitialized();
      return;
    }

    // Initialize authentication — this subscribes to auth state changes
    // and restores the existing session (INITIAL_SESSION event).
    // auth.init() handles session restoration; bootstrap does NOT call getSession() directly.
    try {
      log('Initializing authentication');
      window.auth.init();
      log('Authentication initialized');
    } catch (err) {
      error('Authentication initialization failed', err);
      try {
        window.ui.toast('Authentication initialization failed: ' + escapeHtml(err.message || String(err)), 'error', 8000);
      } catch (e) {}
    }

    // Wait for the initial session restore to complete
    await waitForAuthReady(30000);

    // Initialize router (navigation listeners registered before any rendering)
    try {
      log('Initializing router');
      window.router.init();
      log('Router initialized');
    } catch (err) {
      error('Router initialization failed', err);
      showBootstrapError('Router failed to initialize: ' + escapeHtml(err.message || String(err)));
      return;
    }

    // Restore the saved theme before the first paint of page content.
    try {
      const savedTheme = window.localStorage ? window.localStorage.getItem('corpus_theme') : null;
      if (savedTheme === 'light' || savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', savedTheme);
      }
    } catch (e) { /* storage may be blocked */ }

    // AOS is already loaded by index.html — initialise it once, cheaply, and
    // honour the user's reduced-motion preference.
    // Instrumentation first: everything after this point is measured.
    try {
      if (window.CORPUS_PERF && typeof window.CORPUS_PERF.install === 'function') {
        window.CORPUS_PERF.install();
      }
    } catch (e) { /* measurement is optional */ }

    // Press feedback must be installed once, before the first click is possible.
    try {
      if (window.ui && typeof window.ui.installPressFeedback === 'function') {
        window.ui.installPressFeedback();
      }
    } catch (e) { /* feedback is optional */ }

    try {
      if (typeof AOS !== 'undefined' && AOS && typeof AOS.init === 'function') {
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        AOS.init({
          once: true,
          duration: 420,
          easing: 'ease-out-cubic',
          offset: 40,
          disable: reduceMotion,
        });
      }
    } catch (e) { /* animations are optional */ }

    // Mark initialized
    window.CORPUS_APP.markInitialized();
    log('Application bootstrap complete');

    // Render initial route with correct auth state
    try {
      router.render();
    } catch (e) {}
  }

  function startWhenReady() {
    if (started) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(start, 50);
      });
    } else {
      setTimeout(start, 50);
    }
  }

  // Global error handlers. Note: resource (script/stylesheet) load failures
  // arrive as events whose target is the <script>/<link> element and do NOT
  // bubble — they are handled by the capture-phase listener below.
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      return; // handled by the capture-phase listener
    }
    const where = (event.filename || 'unknown script') +
      (event.lineno != null ? ':' + event.lineno + (event.colno != null ? ':' + event.colno : '') : '');
    const detail = where + ' — ' + (event.message || 'unknown JavaScript error');
    if (window.CORPUS_APP && window.CORPUS_APP.recordError) {
      window.CORPUS_APP.recordError('uncaught-error', detail, event.error || null);
    }
    error('Uncaught JavaScript error at ' + detail, event.error);
    try {
      window.CORPUS_APP.logDiagnostic('uncaught-error', {
        message: event.message,
        source: event.filename,
        line: event.lineno,
      });
    } catch (e) {}
  });

  // Resource error events do not bubble up to window listeners — they must be
  // captured in the capture phase or a 404 <script> stays invisible.
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      const url = target.src || target.href || '(unknown url)';
      if (window.CORPUS_APP && window.CORPUS_APP.recordError) {
        window.CORPUS_APP.recordError('resource-error', 'Failed to load ' + target.tagName.toLowerCase() + ': ' + url, null);
      }
      try {
        window.CORPUS_APP.logDiagnostic('resource-error', { url, tag: target.tagName.toLowerCase() });
      } catch (e) {}
    }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    error('Unhandled promise rejection', event.reason);
    try {
      window.CORPUS_APP.logDiagnostic('unhandled-rejection', {
        reason: event.reason && event.reason.message ? event.reason.message : String(event.reason),
      });
    } catch (e) {}
  });

  return {
    start: startWhenReady,
  };
})();

// Auto-start when DOM is ready
window.CORPUS_BOOTSTRAP.start();