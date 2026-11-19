/* ========================================
   CORPUS ULTIMATE — Route registry (single source of truth)

   Every navigable page is declared exactly once, here:

       { route, module, script, label, icon, group }

   * `route`  — the hash route (`#/training`)
   * `module` — the global the page module registers (`window.training`)
   * `script` — the file that registers it (`js/training.js`)
   * `label`  — the text the sidebar shows
   * `group`  — the expandable sidebar section it belongs to

   The router builds its renderer lookup and sidebar from this registry, the
   bootstrap verifies every module against it, and the tests assert the whole
   chain (route → script → global → render()). Adding a page in one table and
   forgetting another used to produce "module not loaded"; now a page that is
   in `ROUTES` is wired everywhere, and a page missing from `ROUTES` cannot be
   reached from the sidebar at all.

   This file must load BEFORE router.js and app-bootstrap.js.
   ======================================== */

window.CORPUS_ROUTES = (function () {
  'use strict';

  /* Sidebar sections. Order here is the order on screen.
     `defaultOpen` only decides the first paint; the user's own open/closed
     choices are remembered in localStorage afterwards. */
  const GROUPS = [
    { id: 'workspace', label: 'Workspace', icon: 'fa-house-chimney', defaultOpen: true },
    { id: 'build', label: 'Build & Data', icon: 'fa-cubes', defaultOpen: true },
    { id: 'intelligence', label: 'AI & Intelligence', icon: 'fa-brain', defaultOpen: false },
    { id: 'compute', label: 'Compute & Devices', icon: 'fa-server', defaultOpen: false },
    { id: 'teaching', label: 'Teaching & Distillation', icon: 'fa-graduation-cap', defaultOpen: false },
    { id: 'insights', label: 'Observability', icon: 'fa-chart-simple', defaultOpen: false },
    { id: 'system', label: 'System', icon: 'fa-gear', defaultOpen: false },
  ];

  const ROUTES = [
    // Workspace
    { route: 'dashboard', module: 'dashboard', script: 'js/dashboard.js', label: 'Dashboard', icon: 'fa-home', group: 'workspace' },
    { route: 'statistics', module: 'statistics', script: 'js/statistics.js', label: 'Statistics', icon: 'fa-chart-line', group: 'workspace' },

    // Build & data
    { route: 'models', module: 'models', script: 'js/models.js', label: 'Models', icon: 'fa-cube', group: 'build' },
    { route: 'training', module: 'training', script: 'js/training.js', label: 'Training Center', icon: 'fa-flask', group: 'build' },
    { route: 'datasets', module: 'datasets', script: 'js/datasets.js', label: 'Datasets', icon: 'fa-database', group: 'build' },
    { route: 'evaluation', module: 'evaluation', script: 'js/evaluation.js', label: 'Evaluation', icon: 'fa-check-double', group: 'build' },
    { route: 'experiments', module: 'experiments', script: 'js/experiments.js', label: 'Experiments', icon: 'fa-vials', group: 'build' },

    // AI & intelligence
    { route: 'ai-information', module: 'aiInfo', script: 'js/ai-information.js', label: 'AI Information', icon: 'fa-circle-info', group: 'intelligence' },
    { route: 'chat', module: 'chat', script: 'js/chat.js', label: 'Chat', icon: 'fa-comments', group: 'intelligence' },
    { route: 'prediction-lab', module: 'prediction', script: 'js/prediction.js', label: 'Prediction Lab', icon: 'fa-microscope', group: 'intelligence' },
    { route: 'neural-lab', module: 'neuralLab', script: 'js/neural-lab.js', label: 'Neural Lab', icon: 'fa-microchip', group: 'intelligence' },

    // Compute & devices
    { route: 'compute', module: 'compute', script: 'js/compute.js', label: 'Compute', icon: 'fa-server', group: 'compute' },
    { route: 'device-compute', module: 'devices', script: 'js/devices.js', label: 'Device Compute', icon: 'fa-mobile-screen-button', group: 'compute' },
    { route: 'multi-device', module: 'devices', script: 'js/devices.js', label: 'Multi-Device Training', icon: 'fa-network-wired', group: 'compute' },
    { route: 'cloud-storage', module: 'storage', script: 'js/storage.js', label: 'Cloud Storage', icon: 'fa-cloud', group: 'compute' },

    // Teaching & distillation
    { route: 'ai-teachers', module: 'teachers', script: 'js/teachers.js', label: 'AI Teacher Network', icon: 'fa-graduation-cap', group: 'teaching' },
    { route: 'provider-management', module: 'teachers', script: 'js/teachers.js', label: 'AI API Keys', icon: 'fa-key', group: 'teaching' },
    { route: 'teacher-selection', module: 'teacherSelection', script: 'js/teacher-selection.js', label: 'Teacher Selection', icon: 'fa-users-gear', group: 'teaching' },
    { route: 'knowledge-distillation', module: 'distillation', script: 'js/distillation.js', label: 'Knowledge Distillation', icon: 'fa-droplet', group: 'teaching' },
    { route: 'dataset-review', module: 'distillation', script: 'js/distillation.js', label: 'Dataset Quality Review', icon: 'fa-list-check', group: 'teaching' },
    { route: 'student-models', module: 'students', script: 'js/students.js', label: 'Student Model Studio', icon: 'fa-layer-group', group: 'teaching' },

    // Observability
    { route: 'training-intelligence', module: 'intelligence', script: 'js/intelligence.js', label: 'Training Intelligence', icon: 'fa-gauge-high', group: 'insights' },
    { route: 'api-usage', module: 'budgets', script: 'js/budgets.js', label: 'API Usage & Budgets', icon: 'fa-wallet', group: 'insights' },

    // System
    { route: 'settings', module: 'settings', script: 'js/settings.js', label: 'Settings', icon: 'fa-cog', group: 'system' },
  ];

  /* Routes that are not in the sidebar but must still dispatch (the auth page
     is opened by the auth modal, not the menu). */
  const HIDDEN_ROUTES = ['auth'];

  /* Old or alternate hashes that should open an existing page instead of
     falling back to the dashboard. The router rewrites the hash to the
     canonical route, so links keep working without a second page module. */
  const ALIASES = {
    'ai-api-keys': 'provider-management',
    'api-keys': 'provider-management',
    'providers': 'provider-management',
  };

  const byRouteMap = Object.create(null);
  const byModuleMap = Object.create(null);
  const groupMap = Object.create(null);

  GROUPS.forEach((group) => { groupMap[group.id] = group; });

  ROUTES.forEach((entry) => {
    byRouteMap[entry.route] = entry;
    // A module may back several routes (teachers → ai-teachers + AI API Keys);
    // the first route in the table wins as its "primary" route.
    if (!byModuleMap[entry.module]) byModuleMap[entry.module] = entry;
  });

  function canonical(route) {
    if (!route) return route;
    const key = String(route).replace(/^#\/?/, '').replace(/\/+$/, '');
    if (byRouteMap[key]) return key;
    if (HIDDEN_ROUTES.indexOf(key) !== -1) return key;
    if (ALIASES[key]) return ALIASES[key];
    return key;
  }

  function byRoute(route) {
    return byRouteMap[canonical(route)] || null;
  }

  function moduleFor(route) {
    const entry = byRoute(route);
    return entry ? entry.module : '';
  }

  function scriptFor(route) {
    const entry = byRoute(route);
    return entry ? entry.script : '';
  }

  function labelFor(route) {
    const entry = byRoute(route);
    return entry ? entry.label : '';
  }

  function groupOf(route) {
    const entry = byRoute(route);
    return entry ? groupMap[entry.group] : null;
  }

  function group(id) {
    return groupMap[id] || null;
  }

  /** Routes of a group, in table order. */
  function routesInGroup(id) {
    return ROUTES.filter((entry) => entry.group === id);
  }

  /** Every distinct page module: { module, script, label, route }. */
  function modules() {
    return Object.keys(byModuleMap).map((name) => {
      const entry = byModuleMap[name];
      return { module: name, script: entry.script, label: entry.label, route: entry.route };
    });
  }

  /** Distinct script files in load order (as declared in ROUTES). */
  function scripts() {
    const seen = [];
    ROUTES.forEach((entry) => {
      if (seen.indexOf(entry.script) === -1) seen.push(entry.script);
    });
    return seen;
  }

  function isKnown(route) {
    return Boolean(byRoute(route)) || HIDDEN_ROUTES.indexOf(canonical(route)) !== -1;
  }

  return {
    GROUPS,
    ROUTES,
    HIDDEN_ROUTES,
    ALIASES,
    canonical,
    byRoute,
    moduleFor,
    scriptFor,
    labelFor,
    groupOf,
    group,
    routesInGroup,
    modules,
    scripts,
    isKnown,
    has(route) { return Boolean(byRoute(route)); },
  };
})();
