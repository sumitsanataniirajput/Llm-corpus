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

  // The sidebar is the only navigation on every screen size: the hamburger
  // opens it as a drawer on phones, tablets and desktops alike.
  function getNavLinks() {
    return document.querySelectorAll('.nav-item[data-route]');
  }

  function getSidebarNav() {
    return document.getElementById('sidebar-nav');
  }

  function getSidebar() {
    return document.getElementById('sidebar');
  }

  function getOverlay() {
    return document.getElementById('sidebar-overlay');
  }

  function getMenuToggle() {
    return document.getElementById('menu-toggle');
  }

  function routeRegistry() {
    return window.CORPUS_ROUTES || null;
  }

  let ignoreHashChange = false;
  let initialized = false;
  let currentRoute = null;
  // A navigation sequence number, not a lock. The old code returned early while
  // a page was loading (`if (isNavigating) return`), so every click made during
  // a slow API call was silently dropped — the app felt frozen. Navigations now
  // always start; only the newest one is allowed to paint.
  let navSeq = 0;
  let renderingRoute = null;
  let currentPageController = null;

  // Route → page module and route → script come from the single registry in
  // js/routes.js, so the sidebar, the renderer lookup, the bootstrap's module
  // check and the tests can never disagree about what a route maps to.
  const registry = routeRegistry();
  const PAGE_MODULES = Object.create(null);
  const MODULE_SCRIPTS = Object.create(null);

  if (registry) {
    registry.ROUTES.forEach((entry) => {
      PAGE_MODULES[entry.route] = entry.module;
      MODULE_SCRIPTS[entry.route] = entry.script;
    });
  } else {
    // Without the registry nothing can be routed; say so loudly instead of
    // rendering 24 "module not loaded" panels with no explanation.
    try {
      window.CORPUS_APP.recordError(
        'router.registry',
        'js/routes.js did not load, so no route can be resolved. Check that it is included before js/router.js.',
        null
      );
    } catch (e) { /* diagnostics are optional */ }
  }

  /* Sidebar open/closed state, per group, remembered between visits. A stored
     value is a list of group ids the user left open; anything else falls back
     to the group defaults. */
  const NAV_STATE_KEY = 'corpus_nav_groups';

  function readOpenGroups() {
    try {
      const raw = window.localStorage.getItem(NAV_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((id) => typeof id === 'string');
      }
    } catch (e) { /* private mode, disabled storage: use defaults */ }
    if (!registry) return [];
    return registry.GROUPS.filter((group) => group.defaultOpen).map((group) => group.id);
  }

  function writeOpenGroups(ids) {
    try {
      window.localStorage.setItem(NAV_STATE_KEY, JSON.stringify(ids));
    } catch (e) { /* storage is optional */ }
  }

  function openGroupsInDom() {
    const nav = getSidebarNav();
    if (!nav) return [];
    return Array.from(nav.querySelectorAll('.nav-group[open]')).map((el) => el.dataset.group);
  }

  function openGroup(groupId) {
    const nav = getSidebarNav();
    if (!nav || !groupId) return;
    const el = nav.querySelector('.nav-group[data-group="' + cssEscape(groupId) + '"]');
    if (!el) return;
    if (!el.open) {
      el.open = true;
      const summary = el.querySelector('summary');
      if (summary) summary.setAttribute('aria-expanded', 'true');
      writeOpenGroups(openGroupsInDom());
    }
  }

  // Minimal attribute-value escape for querySelector. Group ids are internal
  // (a-z, dash) but this keeps the helper safe if that ever changes.
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

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

  // Route → renderer. Every registry route is served by renderPage(); `auth`
  // is the one page that is not in the menu.
  const routes = Object.create(null);
  if (registry) {
    registry.ROUTES.forEach((entry) => {
      routes[entry.route] = renderPage;
    });
  }
  routes.auth = renderAuth;

  /* ---------- Sidebar rendering ----------

     One <details> per group, one <button> per page. Buttons (not divs) so the
     menu is reachable and operable by keyboard, screen readers and TV remotes;
     `data-route` is the only thing active-state code has to compare, which is
     what used to break when a label was renamed.
  ------------------------------------------------------------------------ */

  function navItemMarkup(entry, activeRoute) {
    const active = entry.route === activeRoute;
    return '<button type="button" class="nav-item' + (active ? ' active' : '') + '"' +
      ' data-route="' + escapeHtml(entry.route) + '"' +
      ' title="' + escapeHtml(entry.label) + '"' +
      (active ? ' aria-current="page"' : '') +
      ' onclick="router.navigate(\'' + escapeHtml(entry.route) + '\')">' +
        '<i class="fas ' + escapeHtml(entry.icon) + '" aria-hidden="true"></i>' +
        '<span>' + escapeHtml(entry.label) + '</span>' +
      '</button>';
  }

  function renderSidebar(activeRoute) {
    const nav = getSidebarNav();
    const reg = routeRegistry();
    if (!nav || !reg) return;
    const openIds = readOpenGroups();

    nav.innerHTML = reg.GROUPS.map((group) => {
      const items = reg.routesInGroup(group.id);
      if (!items.length) return '';
      const hasActive = items.some((item) => item.route === activeRoute);
      // A group holding the page you are on is always open, even if it was
      // collapsed last time: otherwise the menu hides the current location.
      const open = hasActive || openIds.indexOf(group.id) !== -1;
      return '<details class="nav-group" data-group="' + escapeHtml(group.id) + '"' + (open ? ' open' : '') + '>' +
        '<summary class="nav-group-summary" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<i class="fas ' + escapeHtml(group.icon) + '" aria-hidden="true"></i>' +
          '<span class="nav-group-label">' + escapeHtml(group.label) + '</span>' +
          '<i class="fas fa-chevron-down nav-group-chevron" aria-hidden="true"></i>' +
        '</summary>' +
        '<div class="nav-group-items">' +
          items.map((entry) => navItemMarkup(entry, activeRoute)).join('') +
        '</div>' +
      '</details>';
    }).join('');
  }

  function initNavGroups() {
    const nav = getSidebarNav();
    if (!nav) return;
    // Persist a group the moment the user opens or closes it.
    nav.addEventListener('toggle', (event) => {
      const details = event.target;
      if (!details || !details.classList || !details.classList.contains('nav-group')) return;
      if (event.target !== details) return;
      const summary = details.querySelector('summary');
      if (summary) summary.setAttribute('aria-expanded', details.open ? 'true' : 'false');
      writeOpenGroups(openGroupsInDom());
    }, true);
  }

  /* ---------- Drawer behaviour (all screen sizes) ---------- */

  let lastFocusedBeforeOpen = null;

  function isSidebarOpen() {
    const sidebar = getSidebar();
    return Boolean(sidebar && !sidebar.classList.contains('hidden'));
  }

  function syncDrawerState(open) {
    const sidebar = getSidebar();
    const overlay = getOverlay();
    const toggle = getMenuToggle();
    if (sidebar) {
      sidebar.classList.toggle('hidden', !open);
      sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
      // A closed drawer must not keep focusable children in the tab order.
      sidebar.toggleAttribute('inert', !open);
    }
    if (overlay) overlay.classList.toggle('hidden', !open);
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    document.body.classList.toggle('nav-open', open);
  }

  function openSidebar() {
    if (isSidebarOpen()) return;
    lastFocusedBeforeOpen = document.activeElement;
    syncDrawerState(true);
    const sidebar = getSidebar();
    const target = sidebar ? (sidebar.querySelector('.nav-item.active') || sidebar) : null;
    if (target && typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) {} }
    }
  }

  function closeSidebar(options) {
    const restoreFocus = !options || options.restoreFocus !== false;
    const wasOpen = isSidebarOpen();
    syncDrawerState(false);
    document.body.classList.remove('nav-open');
    if (wasOpen && restoreFocus) {
      const toggle = getMenuToggle();
      const back = toggle || lastFocusedBeforeOpen;
      if (back && typeof back.focus === 'function' && document.contains(back)) {
        try { back.focus({ preventScroll: true }); } catch (e) { try { back.focus(); } catch (e2) {} }
      }
    }
    lastFocusedBeforeOpen = null;
  }

  function toggleSidebar() {
    if (isSidebarOpen()) closeSidebar();
    else openSidebar();
  }

  function onKeydown(event) {
    if (!event || event.key !== 'Escape') return;
    if (isSidebarOpen()) {
      closeSidebar();
      event.stopPropagation();
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    window.CORPUS_APP.logDiagnostic('router.init called');

    const reg = routeRegistry();
    if (!reg) {
      window.CORPUS_APP.recordError('router.init', 'Route registry missing (js/routes.js).', null);
    }

    renderSidebar(getRouteFromHash());

    getNavLinks().forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const route = link.dataset.route;
        if (route) navigate(route);
      });
    });

    const closeBtn = document.getElementById('sidebar-close');
    const overlay = getOverlay();
    const menuToggle = getMenuToggle();

    if (closeBtn) closeBtn.addEventListener('click', () => closeSidebar());
    if (overlay) overlay.addEventListener('click', () => closeSidebar());
    if (menuToggle) menuToggle.addEventListener('click', toggleSidebar);

    document.addEventListener('keydown', onKeydown);
    initNavGroups();

    // The drawer is closed on load at every size: navigation starts from the
    // hamburger, and the page you land on is the page you see.
    syncDrawerState(false);

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
      const reg = routeRegistry();
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
      route = route.trim().replace(/\/+$/, '');
      if (!route) return 'dashboard';

      // Deep links carry an id for a page to read (e.g. #/dataset-review/<id>):
      // the router resolves the page and the page parses the id from the hash.
      const direct = route.split('/')[0];
      const resolved = reg ? reg.canonical(direct) : direct;

      if (routes[resolved]) return resolved;
      // An alias with an id (e.g. #/ai-api-keys/<provider>) resolves too.
      if (reg && reg.canonical(route) && routes[reg.canonical(direct)]) return reg.canonical(direct);
      return 'dashboard';
    } catch (err) {
      window.CORPUS_APP.recordError('router.getRouteFromHash', err.message, err);
      return 'dashboard';
    }
  }

  async function navigate(requestedRoute) {
    const reg = routeRegistry();
    let route = reg ? reg.canonical(requestedRoute) : requestedRoute;
    if (!routes[route]) route = 'dashboard';
    // Re-rendering the page that is already rendering is the only case we skip
    // (a double tap on the same nav item).
    if (route === renderingRoute) return;

    const seq = ++navSeq;
    renderingRoute = route;
    const navStartedAt = (window.CORPUS_PERF && window.CORPUS_PERF.now) ? window.CORPUS_PERF.now() : 0;

    // Abort whatever the page we are leaving still has in flight. Its requests
    // are no longer useful and its late responses must not touch the DOM.
    if (currentPageController) {
      try { currentPageController.abort(); } catch (e) { /* no-op */ }
    }
    currentPageController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (window.CORPUS_APP) window.CORPUS_APP.getPageSignal = getPageSignal;

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
        renderingRoute = null;
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
      closeSidebar({ restoreFocus: false });

      const container = window.CORPUS_APP.requirePageContainer('router.navigate');
      if (container) container.setAttribute('aria-busy', 'true');

      try {
        const renderer = routes[route];
        // The route is passed explicitly: several routes share one module
        // (teachers backs AI Teacher Network and AI API Keys; distillation
        // backs Knowledge Distillation and Dataset Quality Review), so a page
        // cannot know which view it must draw without being told.
        const result = renderer(route);
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch (err) {
        // The page we left cannot paint an error over the page we opened.
        if (seq !== navSeq) return;
        if (err && err.aborted) return;
        window.CORPUS_APP.recordError('router.render.' + route, err.message, err);
        try {
          container.innerHTML = renderErrorPanel(route, err);
        } catch (renderErr) {
          container.innerHTML = '<div style="padding:2rem; color:red; text-align:center;">Page failed to load: ' + escapeHtml(String(err.message || err)) + '</div>';
        }
      }

      // A newer navigation owns the page now: never overwrite it with this
      // (older) page's state, scroll position or animation refresh.
      if (seq !== navSeq) return;

      if (container) container.removeAttribute('aria-busy');
      if (navStartedAt && window.CORPUS_PERF) {
        window.CORPUS_PERF.recordNavigation(route, window.CORPUS_PERF.now() - navStartedAt);
        if (typeof window.CORPUS_PERF.markInteractive === 'function') window.CORPUS_PERF.markInteractive();
      }

      try {
        window.state.setRoute(route);
      } catch (e) {}

      // Scroll and animation refresh are visual work: do them in the next frame
      // instead of synchronously inside the click handler.
      const frame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
      frame(() => {
        try { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); } catch (e) { /* older browsers */ }
        if (typeof AOS !== 'undefined' && AOS) {
          try { AOS.refresh(); } catch (e) { /* AOS is optional */ }
        }
      });
    } finally {
      if (seq === navSeq) renderingRoute = null;
      setTimeout(() => { ignoreHashChange = false; }, 100);
    }
  }

  /** AbortSignal for the page currently on screen (requests die on navigation). */
  function getPageSignal() {
    return currentPageController ? currentPageController.signal : null;
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
      const canonical = routeRegistry() ? routeRegistry().canonical(route) : route;
      const nav = getSidebarNav();
      if (!nav) return;
      nav.querySelectorAll('.nav-item[data-route]').forEach((item) => {
        const isActive = item.dataset.route === canonical;
        item.classList.toggle('active', isActive);
        if (isActive) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      // Keyboard/remote users must be able to see where they are, so the
      // section holding the current page is expanded after every navigation.
      if (routeRegistry()) {
        const group = routeRegistry().groupOf(canonical);
        if (group) openGroup(group.id);
      }
    } catch (e) {
      window.CORPUS_APP.recordError('router.setActiveNav', e.message, e);
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
        // The route is passed explicitly: state.setRoute() runs after the
        // renderer, so a page must not have to guess which route it is on.
        await page.render(route);
      } else {
        container.innerHTML = missingModulePanel(route, moduleName, iconClass);
      }
    } catch (err) {
      window.CORPUS_APP.recordError(fnName, err.message, err);
      container.innerHTML = renderErrorPanel(route, err);
    }
  }

  /**
   * The renderer for every page route. Label and icon come from the registry,
   * and the route itself is forwarded to the page module — a page shared by
   * two routes (teachers, distillation) needs it to pick its own view.
   */
  async function renderPage(route) {
    const reg = routeRegistry();
    const entry = reg ? reg.byRoute(route) : null;
    const label = entry ? entry.label : route;
    const icon = entry ? entry.icon : 'fa-triangle-exclamation';
    return renderModulePage(route, label, icon, 'renderPage:' + route);
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
    openSidebar,
    closeSidebar,
    toggleSidebar,
    renderSidebar,
    isSidebarOpen,
    render,
    renderErrorPanel,
    setActiveNav,
    get initialized() {
      return initialized;
    },
  };
})();