/* ========================================
   CORPUS ULTIMATE — Router (hash-based)
   ======================================== */

window.router = (function () {
  'use strict';

  // Dynamic accessors — pageContainer is set by bootstrap AFTER this module loads,
  // so we must read it from window.CORPUS_APP at call time, not capture it at module load.
  function getPageContainer() {
    return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null;
  }

  function getNavLinks() {
    return document.querySelectorAll('.nav-link');
  }

  function getSidebarNav() {
    return document.getElementById('sidebar-nav');
  }

  let ignoreHashChange = false;
  let isNavigating = false;
  let initialized = false;
  let currentRoute = null;

  // Route → page module. Modules may expose dispose() to release sockets/timers.
  const PAGE_MODULES = {
    dashboard: 'dashboard',
    models: 'models',
    training: 'training',
    statistics: 'statistics',
    'ai-information': 'aiInfo',
    chat: 'chat',
    'prediction-lab': 'prediction',
    'neural-lab': 'neuralLab',
    datasets: 'datasets',
    evaluation: 'evaluation',
    compute: 'compute',
    'cloud-storage': 'storage',
    experiments: 'experiments',
    settings: 'settings',
  };

  // Route → script that registers the module. Used to recover from a module
  // that is not registered (stale Android cache, a 404, or a truncated file)
  // by requesting the exact file again with a cache-busting query.
  const MODULE_SCRIPTS = {
    dashboard: 'js/dashboard.js',
    models: 'js/models.js',
    training: 'js/training.js',
    statistics: 'js/statistics.js',
    'ai-information': 'js/ai-information.js',
    chat: 'js/chat.js',
    'prediction-lab': 'js/prediction.js',
    'neural-lab': 'js/neural-lab.js',
    datasets: 'js/datasets.js',
    evaluation: 'js/evaluation.js',
    compute: 'js/compute.js',
    'cloud-storage': 'js/storage.js',
    experiments: 'js/experiments.js',
    settings: 'js/settings.js',
  };

  // One recovery attempt per route per page load: retrying in a loop would only
  // hammer the server when the file is genuinely broken.
  const reloadAttempted = Object.create(null);
  const reloadedUrls = Object.create(null);

  function buildId() {
    const cfg = window.CORPUS_CONFIG || {};
    if (cfg.BUILD_ID) return String(cfg.BUILD_ID);
    const meta = document.querySelector('meta[name="corpus-build"]');
    const value = meta ? meta.getAttribute('content') : '';
    return value || 'dev';
  }

  /** Load a script element; resolves true on load, false on error/timeout. */
  function defaultScriptLoader(src, timeoutMs) {
    if (typeof window.CORPUS_MODULE_LOADER === 'function') {
      // Hosts that cannot inject scripts (strict CSP) or tests plug their own.
      return Promise.resolve(window.CORPUS_MODULE_LOADER(src));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const el = document.createElement('script');
      const timer = setTimeout(() => finish(false), timeoutMs || 6000);
      el.async = false;
      el.src = src;
      el.onload = () => { clearTimeout(timer); finish(true); };
      el.onerror = () => { clearTimeout(timer); finish(false); };
      try {
        document.head.appendChild(el);
      } catch (err) {
        clearTimeout(timer);
        finish(false);
      }
    });
  }

  async function reloadPageModule(route) {
    const globalName = PAGE_MODULES[route];
    const file = MODULE_SCRIPTS[route];
    if (!globalName || !file) return null;
    if (reloadAttempted[route]) return window[globalName] && window[globalName].render ? window[globalName] : null;
    reloadAttempted[route] = true;

    const url = file + '?v=' + encodeURIComponent(buildId()) + '&retry=' + Date.now();
    reloadedUrls[route] = url;
    try {
      window.CORPUS_APP.logDiagnostic('router: ' + globalName + ' is not registered, retrying ' + url);
    } catch (e) { /* logging must never break navigation */ }

    const loaded = await defaultScriptLoader(url);
    const page = window[globalName];
    if (!loaded) {
      try {
        window.CORPUS_APP.recordError(
          'router.module-reload',
          'Could not load ' + url + ' (network error or blocked script).',
          null
        );
      } catch (e) { /* ignore */ }
      return null;
    }
    if (!page || typeof page.render !== 'function') {
      try {
        window.CORPUS_APP.recordError(
          'router.module-register',
          url + ' loaded but did not register window.' + globalName + '.render (syntax/runtime error in the file).',
          null
        );
      } catch (e) { /* ignore */ }
      return null;
    }
    return page;
  }

  function disposePage(route) {
    if (!route) return;
    const name = PAGE_MODULES[route];
    const page = name ? window[name] : null;
    if (page && typeof page.dispose === 'function') {
      try {
        page.dispose();
      } catch (err) {
        window.CORPUS_APP.recordError('router.dispose.' + route, err.message, err);
      }
    }
  }

  const routes = {
    dashboard: renderDashboard,
    models: renderModels,
    training: renderTraining,
    statistics: renderStatistics,
    'ai-information': renderAIInformation,
    chat: renderChat,
    'prediction-lab': renderPredictionLab,
    'neural-lab': renderNeuralLab,
    datasets: renderDatasets,
    evaluation: renderEvaluation,
    compute: renderCompute,
    'cloud-storage': renderStorage,
    experiments: renderExperiments,
    settings: renderSettings,
    auth: renderAuth,
  };

  function init() {
    if (initialized) return;
    initialized = true;
    window.CORPUS_APP.logDiagnostic('router.init called');

    const navItems = [
      { route: 'dashboard', label: 'Dashboard', icon: 'fa-home' },
      { route: 'models', label: 'Models', icon: 'fa-cube' },
      { route: 'training', label: 'Training Center', icon: 'fa-flask' },
      { route: 'statistics', label: 'Statistics', icon: 'fa-chart-line' },
      { route: 'ai-information', label: 'AI Information', icon: 'fa-info-circle' },
      { route: 'chat', label: 'AI Chat', icon: 'fa-comments' },
      { route: 'prediction-lab', label: 'Prediction Lab', icon: 'fa-microscope' },
      { route: 'neural-lab', label: 'Neural Lab', icon: 'fa-microchip' },
      { route: 'datasets', label: 'Datasets', icon: 'fa-database' },
      { route: 'evaluation', label: 'Evaluation', icon: 'fa-check-double' },
      { route: 'compute', label: 'Compute', icon: 'fa-server' },
      { route: 'cloud-storage', label: 'Cloud Storage', icon: 'fa-cloud' },
      { route: 'experiments', label: 'Experiments', icon: 'fa-flask' },
      { route: 'settings', label: 'Settings', icon: 'fa-cog' },
    ];

    const sidebarNav = getSidebarNav();
    if (sidebarNav) {
      sidebarNav.innerHTML = navItems.map(item => `
        <div class="nav-item ${item.route === window.state.getRoute() ? 'active' : ''}" onclick="router.navigate('${item.route}')">
          <i class="fas ${item.icon}"></i><span>${item.label}</span>
        </div>
      `).join('');
    }

    getNavLinks().forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const route = link.dataset.route;
        if (route) navigate(route);
      });
    });

    const closeBtn = document.getElementById('sidebar-close');
    const overlay = document.getElementById('sidebar-overlay');
    const menuToggle = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');

    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    if (overlay) overlay.addEventListener('click', closeSidebar);
    if (menuToggle && sidebar && overlay) {
      menuToggle.addEventListener('click', () => {
        sidebar.classList.remove('hidden');
        overlay.classList.remove('hidden');
      });
    }

    window.addEventListener('hashchange', (e) => {
      if (ignoreHashChange) return;
      const route = getRouteFromHash();
      navigate(route);
    });

    const initial = getRouteFromHash();
    navigate(initial);
  }

  function getRouteFromHash() {
    try {
      const hash = window.location.hash;
      if (!hash) {
        // Android may recreate the web process when returning from the system
        // file picker. Restore the last SPA page instead of unexpectedly
        // sending the user to Dashboard after that browser reload.
        try {
          const saved = window.sessionStorage.getItem('corpus:last-route');
          if (saved && routes[saved]) return saved;
        } catch (storageError) {
          // Session storage may be disabled in embedded browsers.
        }
        return 'dashboard';
      }
      let route = hash.replace(/^#\/?/, '');
      route = route.trim();
      if (!route || !routes[route]) return 'dashboard';
      return route;
    } catch (err) {
      window.CORPUS_APP.recordError('router.getRouteFromHash', err.message, err);
      return 'dashboard';
    }
  }

  async function navigate(route) {
    if (isNavigating) return;
    isNavigating = true;

    try {
      if (!routes[route]) route = 'dashboard';
      try {
        window.sessionStorage.setItem('corpus:last-route', route);
      } catch (storageError) {
        // Routing must continue to work when session storage is unavailable.
      }

      // If auth is still initializing, show a loading state instead of "Sign in required"
      if (window.state && window.state.isAuthLoading()) {
        const container = window.CORPUS_APP.requirePageContainer('router.navigate');
        container.innerHTML = `
          <div style="text-align:center; padding:var(--space-8);">
            <div style="font-size:2rem; color:var(--color-primary); margin-bottom:var(--space-3);"><i class="fas fa-circle-notch fa-spin"></i></div>
            <h3 style="color:var(--color-text); margin:0 0 var(--space-2) 0;">Restoring session...</h3>
            <p style="color:var(--color-text-variant); font-size:var(--text-body-small);">Please wait while we restore your Supabase session.</p>
          </div>
        `;
        window.state.setRoute(route);
        return;
      }

      ignoreHashChange = true;
      const expectedHash = '#/' + route;
      if (window.location.hash !== expectedHash) {
        window.location.hash = expectedHash;
      }

      if (currentRoute && currentRoute !== route) disposePage(currentRoute);
      currentRoute = route;

      setActiveNav(route);
      closeSidebar();

      const container = window.CORPUS_APP.requirePageContainer('router.navigate');

      try {
        const renderer = routes[route];
        const result = renderer();
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch (err) {
        window.CORPUS_APP.recordError('router.render.' + route, err.message, err);
        try {
          container.innerHTML = renderErrorPanel(route, err);
        } catch (renderErr) {
          container.innerHTML = '<div style="padding:2rem; color:red; text-align:center;">Page failed to load: ' + escapeHtml(String(err.message || err)) + '</div>';
        }
      }

      try {
        window.state.setRoute(route);
      } catch (e) {}

      try {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      } catch (e) { /* older browsers */ }

      if (typeof AOS !== 'undefined' && AOS) {
        try { AOS.refresh(); } catch (e) {}
      }
    } finally {
      isNavigating = false;
      setTimeout(() => { ignoreHashChange = false; }, 100);
    }
  }

  function lastRecordedScriptError() {
    try {
      if (!window.CORPUS_APP || typeof window.CORPUS_APP.getDiagnostics !== 'function') return null;
      const log = (window.CORPUS_APP.getDiagnostics() || {}).errorLog || [];
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const entry = log[i];
        if (entry && (entry.source === 'uncaught-error' || entry.source === 'resource-error')) return entry;
      }
      // Legacy bootstrap entries were recorded under 'bootstrap'.
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const entry = log[i];
        if (entry && entry.source === 'bootstrap' && /uncaught|failed to load/i.test(entry.message || '')) return entry;
      }
    } catch (e) { /* diagnostics must never break rendering */ }
    return null;
  }

  function missingModulePanel(route, moduleName, iconClass) {
    const diag = lastRecordedScriptError();
    const globalName = PAGE_MODULES[route] || route;
    const build = buildId();
    const expectedScript = MODULE_SCRIPTS[route]
      ? MODULE_SCRIPTS[route] + '?v=' + build
      : '(no script mapped for this route)';
    const retried = reloadedUrls[route];
    const globalState = globalName && typeof window[globalName] === 'undefined'
      ? 'The module global <code>window.' + escapeHtml(globalName) + '</code> is undefined — its script did not execute (failed download or a syntax/runtime error before registration).'
      : 'The module global exists, but its <code>render()</code> function is missing.';
    const detail = diag
      ? '<div style="text-align:left; margin:var(--space-3) auto; max-width:640px;">' +
          '<p style="margin:0 0 var(--space-1);"><strong>Last recorded error (' + escapeHtml(diag.source || 'error') + '):</strong></p>' +
          '<pre style="white-space:pre-wrap; word-break:break-word; text-align:left; background:var(--color-bg-muted); color:var(--color-text-variant); padding:var(--space-3); border-radius:var(--radius-md); font-size:var(--text-caption); line-height:1.5; max-height:40vh; overflow:auto;">' +
            escapeHtml(diag.message || '') + (diag.stack ? '\n' + escapeHtml(diag.stack) : '') +
          '</pre>' +
        '</div>'
      : '<p style="color:var(--color-text-variant);">No JavaScript error was captured. If this persists, open DevTools → Network and check that the module file is requested and returns HTTP 200 — a failed download leaves no console error for the page to display.</p>';
    return `
      <div class="empty-state" style="max-width:720px; margin:var(--space-6) auto;">
        <i class="fas ${escapeHtml(iconClass || 'fa-triangle-exclamation')}"></i>
        <h3>${escapeHtml(moduleName)}</h3>
        <p>${escapeHtml(moduleName)} module not loaded.</p>
        <p style="font-size:var(--text-body-small);">${globalState}</p>
        <div style="text-align:left; margin:var(--space-2) auto; max-width:640px; background:var(--color-bg-muted); color:var(--color-text-variant); padding:var(--space-3); border-radius:var(--radius-md); font-size:var(--text-caption); line-height:1.6;">
          <div><strong>Frontend build:</strong> <code>${escapeHtml(build)}</code></div>
          <div><strong>Expected script:</strong> <code>${escapeHtml(expectedScript)}</code></div>
          <div><strong>Automatic recovery:</strong> ${retried
            ? 're-requested <code>' + escapeHtml(retried) + '</code> and it still did not register. The script is missing on the server or contains a syntax/runtime error.'
            : 'not attempted (module was present when the page loaded).'}</div>
        </div>
        ${detail}
        <div class="form-actions" style="justify-content:center;">
          <button class="btn btn-outline" type="button" onclick="location.reload()">Reload page</button>
          <button class="btn btn-primary" type="button" onclick="router.navigate('${escapeHtml(route)}')">Retry</button>
        </div>
      </div>
    `;
  }

  function renderErrorPanel(route, error) {
    const msg = error && error.message ? error.message : String(error || 'Unknown error');
    return `
      <div class="error-panel" style="text-align:center; max-width:560px; margin:var(--space-6) auto;">
        <i class="fas fa-triangle-exclamation" style="font-size:1.6rem; color:var(--color-error);"></i>
        <h3 style="margin-top:var(--space-2);">Page failed to load</h3>
        <p><strong>Route:</strong> <span class="mono">${escapeHtml(route)}</span></p>
        <p>${escapeHtml(msg)}</p>
        <div class="form-actions" style="justify-content:center;">
          <button class="btn btn-outline" type="button" onclick="router.navigate('dashboard')">Go to dashboard</button>
          <button class="btn btn-primary" type="button" onclick="router.navigate('${escapeHtml(route)}')">Retry</button>
        </div>
      </div>
    `;
  }

  function escapeHtml(text) {
    if (text == null) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }

  function setActiveNav(route) {
    try {
      getNavLinks().forEach(link => {
        const isActive = link.dataset.route === route;
        link.classList.toggle('active', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'page');
        } else {
          link.removeAttribute('aria-current');
        }
      });
      const sidebarNav = getSidebarNav();
      if (!sidebarNav) return;
      const items = sidebarNav.querySelectorAll('.nav-item');
      items.forEach(item => {
        const label = item.querySelector('span');
        if (label) {
          const known = {
            'Dashboard': 'dashboard', 'Models': 'models', 'Training Center': 'training',
            'Statistics': 'statistics', 'AI Information': 'ai-information', 'AI Chat': 'chat',
            'Prediction Lab': 'prediction-lab', 'Neural Lab': 'neural-lab', 'Datasets': 'datasets',
            'Evaluation': 'evaluation', 'Compute': 'compute', 'Cloud Storage': 'cloud-storage',
            'Experiments': 'experiments', 'Settings': 'settings',
          };
          item.classList.toggle('active', known[label.textContent] === route);
        }
      });
    } catch (e) {
      window.CORPUS_APP.recordError('router.setActiveNav', e.message, e);
    }
  }

  function closeSidebar() {
    try {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.add('hidden');
      if (overlay) overlay.classList.add('hidden');
    } catch (e) {
      window.CORPUS_APP.recordError('router.closeSidebar', e.message, e);
    }
  }

  function render() {
    const route = getRouteFromHash();
    navigate(route);
  }

  /* ---------- Page renderers ----------

     Every page follows the same contract: the module must exist as
     `window.<global>` and expose `render()`. When it does not, the router first
     tries to recover by re-requesting that one module script with a
     cache-busting query (a stale Android/desktop cache, an interrupted
     download or a half-written file leaves the global undefined), and only then
     shows the diagnostics panel. That converts the "Datasets module not loaded"
     dead end into a page that usually recovers by itself.
  ------------------------------------------------------------------------ */

  async function renderModulePage(route, moduleName, iconClass, fnName) {
    const container = window.CORPUS_APP.requirePageContainer(fnName);
    const globalName = PAGE_MODULES[route];
    try {
      let page = globalName ? window[globalName] : null;
      if (!page || typeof page.render !== 'function') {
        page = await reloadPageModule(route);
      }
      if (page && typeof page.render === 'function') {
        await page.render();
      } else {
        container.innerHTML = missingModulePanel(route, moduleName, iconClass);
      }
    } catch (err) {
      window.CORPUS_APP.recordError(fnName, err.message, err);
      container.innerHTML = renderErrorPanel(route, err);
    }
  }

  async function renderDashboard() {
    return renderModulePage('dashboard', 'Dashboard', 'fa-home', 'renderDashboard');
  }

  async function renderModels() {
    return renderModulePage('models', 'Models', 'fa-cube', 'renderModels');
  }

  async function renderTraining() {
    return renderModulePage('training', 'Training Center', 'fa-flask', 'renderTraining');
  }

  async function renderStatistics() {
    return renderModulePage('statistics', 'Statistics', 'fa-chart-line', 'renderStatistics');
  }

  async function renderAIInformation() {
    return renderModulePage('ai-information', 'AI Information', 'fa-info-circle', 'renderAIInformation');
  }

  async function renderChat() {
    return renderModulePage('chat', 'AI Chat', 'fa-comments', 'renderChat');
  }

  async function renderPredictionLab() {
    return renderModulePage('prediction-lab', 'Prediction Lab', 'fa-microscope', 'renderPredictionLab');
  }

  async function renderNeuralLab() {
    return renderModulePage('neural-lab', 'Neural Lab', 'fa-microchip', 'renderNeuralLab');
  }

  async function renderDatasets() {
    return renderModulePage('datasets', 'Datasets', 'fa-database', 'renderDatasets');
  }

  async function renderEvaluation() {
    return renderModulePage('evaluation', 'Evaluation', 'fa-check-double', 'renderEvaluation');
  }

  async function renderCompute() {
    return renderModulePage('compute', 'Compute', 'fa-server', 'renderCompute');
  }

  async function renderStorage() {
    return renderModulePage('cloud-storage', 'Cloud Storage', 'fa-cloud', 'renderStorage');
  }

  async function renderExperiments() {
    return renderModulePage('experiments', 'Experiments', 'fa-flask', 'renderExperiments');
  }

  async function renderSettings() {
    return renderModulePage('settings', 'Settings', 'fa-cog', 'renderSettings');
  }

  async function renderAuth() {
    const container = window.CORPUS_APP.requirePageContainer('renderAuth');
    try {
      if (window.auth && typeof window.auth.renderForm === 'function') {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Authentication</h3><p>Please use the profile button to sign in or create an account.</p></div>';
      } else {
        container.innerHTML = missingModulePanel('auth', 'Authentication', 'fa-user-circle');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderAuth', err.message, err);
      container.innerHTML = renderErrorPanel('auth', err);
    }
  }

  return {
    init,
    getRouteFromHash,
    navigate,
    render,
    renderErrorPanel,
    setActiveNav,
    closeSidebar,
    get initialized() {
      return initialized;
    },
  };
})();