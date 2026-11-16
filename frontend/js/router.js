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

  /* ---------- Page renderers (await async page modules) ---------- */

  async function renderDashboard() {
    const container = window.CORPUS_APP.requirePageContainer('renderDashboard');
    try {
      if (window.dashboard && typeof window.dashboard.render === 'function') {
        await window.dashboard.render();
      } else {
        container.innerHTML = missingModulePanel('dashboard', 'Dashboard', 'fa-home');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderDashboard', err.message, err);
      container.innerHTML = renderErrorPanel('dashboard', err);
    }
  }

  async function renderModels() {
    const container = window.CORPUS_APP.requirePageContainer('renderModels');
    try {
      if (window.models && typeof window.models.render === 'function') {
        await window.models.render();
      } else {
        container.innerHTML = missingModulePanel('models', 'Models', 'fa-cube');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderModels', err.message, err);
      container.innerHTML = renderErrorPanel('models', err);
    }
  }

  async function renderTraining() {
    const container = window.CORPUS_APP.requirePageContainer('renderTraining');
    try {
      if (window.training && typeof window.training.render === 'function') {
        await window.training.render();
      } else {
        container.innerHTML = missingModulePanel('training', 'Training Center', 'fa-flask');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderTraining', err.message, err);
      container.innerHTML = renderErrorPanel('training', err);
    }
  }

  async function renderStatistics() {
    const container = window.CORPUS_APP.requirePageContainer('renderStatistics');
    try {
      if (window.statistics && typeof window.statistics.render === 'function') {
        await window.statistics.render();
      } else {
        container.innerHTML = missingModulePanel('statistics', 'Statistics', 'fa-chart-line');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderStatistics', err.message, err);
      container.innerHTML = renderErrorPanel('statistics', err);
    }
  }

  async function renderAIInformation() {
    const container = window.CORPUS_APP.requirePageContainer('renderAIInformation');
    try {
      if (window.aiInfo && typeof window.aiInfo.render === 'function') {
        await window.aiInfo.render();
      } else {
        container.innerHTML = missingModulePanel('ai-information', 'AI Information', 'fa-info-circle');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderAIInformation', err.message, err);
      container.innerHTML = renderErrorPanel('ai-information', err);
    }
  }

  async function renderChat() {
    const container = window.CORPUS_APP.requirePageContainer('renderChat');
    try {
      if (window.chat && typeof window.chat.render === 'function') {
        await window.chat.render();
      } else {
        container.innerHTML = missingModulePanel('chat', 'AI Chat', 'fa-comments');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderChat', err.message, err);
      container.innerHTML = renderErrorPanel('chat', err);
    }
  }

  async function renderPredictionLab() {
    const container = window.CORPUS_APP.requirePageContainer('renderPredictionLab');
    try {
      if (window.prediction && typeof window.prediction.render === 'function') {
        await window.prediction.render();
      } else {
        container.innerHTML = missingModulePanel('prediction-lab', 'Prediction Lab', 'fa-microscope');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderPredictionLab', err.message, err);
      container.innerHTML = renderErrorPanel('prediction-lab', err);
    }
  }

  async function renderNeuralLab() {
    const container = window.CORPUS_APP.requirePageContainer('renderNeuralLab');
    try {
      if (window.neuralLab && typeof window.neuralLab.render === 'function') {
        await window.neuralLab.render();
      } else {
        container.innerHTML = missingModulePanel('neural-lab', 'Neural Lab', 'fa-microchip');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderNeuralLab', err.message, err);
      container.innerHTML = renderErrorPanel('neural-lab', err);
    }
  }

  async function renderDatasets() {
    const container = window.CORPUS_APP.requirePageContainer('renderDatasets');
    try {
      if (window.datasets && typeof window.datasets.render === 'function') {
        await window.datasets.render();
      } else {
        container.innerHTML = missingModulePanel('datasets', 'Datasets', 'fa-database');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderDatasets', err.message, err);
      container.innerHTML = renderErrorPanel('datasets', err);
    }
  }

  async function renderEvaluation() {
    const container = window.CORPUS_APP.requirePageContainer('renderEvaluation');
    try {
      if (window.evaluation && typeof window.evaluation.render === 'function') {
        await window.evaluation.render();
      } else {
        container.innerHTML = missingModulePanel('evaluation', 'Evaluation', 'fa-check-double');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderEvaluation', err.message, err);
      container.innerHTML = renderErrorPanel('evaluation', err);
    }
  }

  async function renderCompute() {
    const container = window.CORPUS_APP.requirePageContainer('renderCompute');
    try {
      if (window.compute && typeof window.compute.render === 'function') {
        await window.compute.render();
      } else {
        container.innerHTML = missingModulePanel('compute', 'Compute', 'fa-server');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderCompute', err.message, err);
      container.innerHTML = renderErrorPanel('compute', err);
    }
  }

  async function renderStorage() {
    const container = window.CORPUS_APP.requirePageContainer('renderStorage');
    try {
      if (window.storage && typeof window.storage.render === 'function') {
        await window.storage.render();
      } else {
        container.innerHTML = missingModulePanel('cloud-storage', 'Cloud Storage', 'fa-cloud');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderStorage', err.message, err);
      container.innerHTML = renderErrorPanel('cloud-storage', err);
    }
  }

  async function renderExperiments() {
    const container = window.CORPUS_APP.requirePageContainer('renderExperiments');
    try {
      if (window.experiments && typeof window.experiments.render === 'function') {
        await window.experiments.render();
      } else {
        container.innerHTML = missingModulePanel('experiments', 'Experiments', 'fa-flask');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderExperiments', err.message, err);
      container.innerHTML = renderErrorPanel('experiments', err);
    }
  }

  async function renderSettings() {
    const container = window.CORPUS_APP.requirePageContainer('renderSettings');
    try {
      if (window.settings && typeof window.settings.render === 'function') {
        await window.settings.render();
      } else {
        container.innerHTML = missingModulePanel('settings', 'Settings', 'fa-cog');
      }
    } catch (err) {
      window.CORPUS_APP.recordError('renderSettings', err.message, err);
      container.innerHTML = renderErrorPanel('settings', err);
    }
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