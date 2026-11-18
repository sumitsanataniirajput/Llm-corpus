/* ========================================
   CORPUS ULTIMATE — Dashboard page

   Every number on this page comes from the backend (models, datasets,
   training jobs, checkpoints, /health). When a request fails the card shows
   an em dash and the reason — never an invented value.
   ======================================== */

window.dashboard = (function () {
  'use strict';

  let data = {
    models: [],
    datasets: [],
    jobs: [],
    checkpoints: [],
    health: null,
  };

  let errors = {
    models: null,
    datasets: null,
    jobs: null,
    checkpoints: null,
  };

  let loading = false;
  let chartInstances = {};

  function esc(value) {
    return ui.escapeHtml(value == null ? '' : String(value));
  }

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Please sign in to view your CORPUS workspace.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-diagram-project"></i> Workspace overview</span>
          <h1 class="section-title">Dashboard</h1>
          <p class="section-subtitle">Welcome back, ${esc(user.email || 'researcher')}. Live status from your CORPUS backend.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" id="dash-refresh" type="button" onclick="dashboard.refresh()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
          <button class="btn btn-primary" type="button" onclick="router.navigate('models')">
            <i class="fas fa-plus"></i> New model
          </button>
        </div>
      </div>

      <div class="dashboard-grid" id="dashboard-stats" aria-live="polite">
        ${ui.skeletonCards(5)}
      </div>

      <div class="dashboard-layout">
        <div class="dashboard-column">
          <section class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Recent activity</h2>
                <p class="card-subtitle">Training jobs and dataset uploads, newest first.</p>
              </div>
              <button class="btn btn-ghost btn-sm" type="button" onclick="router.navigate('training')">
                Training center <i class="fas fa-arrow-right"></i>
              </button>
            </div>
            <div id="dashboard-activity"></div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Training activity</h2>
                <p class="card-subtitle">Jobs created per day (last 7 days).</p>
              </div>
            </div>
            <div class="chart-container" style="height:220px;">
              <canvas id="dashboard-activity-chart"></canvas>
              <div id="dashboard-activity-empty" class="chart-empty hidden">
                <i class="fas fa-chart-line"></i>
                <span>No training jobs yet — the chart appears once a job exists.</span>
              </div>
            </div>
          </section>
        </div>

        <div class="dashboard-column">
          <section class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Model overview</h2>
                <p class="card-subtitle">Architecture details from each model record.</p>
              </div>
              <button class="btn btn-ghost btn-sm" type="button" onclick="router.navigate('models')">
                All models <i class="fas fa-arrow-right"></i>
              </button>
            </div>
            <div id="dashboard-models"></div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Quick actions</h2>
                <p class="card-subtitle">Jump to the most common tasks.</p>
              </div>
            </div>
            <div class="quick-actions" id="dashboard-quick-actions"></div>
          </section>

          <section class="card" id="dashboard-connectivity">
            <div class="card-head">
              <div>
                <h2 class="card-title">Backend status</h2>
                <p class="card-subtitle">Live check against the configured API.</p>
              </div>
            </div>
            <div id="dashboard-connectivity-body">
              <div class="connectivity-row">
                <span class="conn-dot pending"></span>
                <span>Checking backend…</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;

    renderQuickActions();
    await loadAll();
  }

  async function refresh() {
    const btn = document.getElementById('dash-refresh');
    if (loading) return;
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    }
    // A manual refresh means "show me the truth", so bypass the read cache.
    if (window.CORPUS_API && typeof window.CORPUS_API.invalidateCache === 'function') {
      window.CORPUS_API.invalidateCache();
    }
    try {
      await loadAll();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    }
  }

  async function loadAll() {
    loading = true;
    const token = await state.getAccessToken();
    const results = await Promise.allSettled([
      window.CORPUS_API.listModels(token),
      window.CORPUS_API.listDatasets(token),
      window.CORPUS_API.listTrainingJobs(token),
      window.CORPUS_API.listAllCheckpoints(token),
      window.CORPUS_API.health(),
    ]);
    loading = false;

    data.models = settleList(results[0], 'models', state.setModels);
    data.datasets = settleList(results[1], 'datasets', state.setDatasets);
    data.jobs = settleList(results[2], 'jobs', state.setTrainingJobs);
    data.checkpoints = settleList(results[3], 'checkpoints', null);
    data.health = results[4].status === 'fulfilled' ? results[4].value : null;

    renderStats();
    renderActivity();
    renderModelOverview();
    renderActivityChart();
    renderConnectivity();
  }

  // Normalise "array | {key: [...]}" responses; record a readable error.
  function settleList(result, key, setter) {
    if (result.status !== 'fulfilled') {
      errors[key] = errorText(result.reason);
      if (setter) setter([]);
      return [];
    }
    const value = result.value;
    const list = Array.isArray(value) ? value : (value && Array.isArray(value[key]) ? value[key] : []);
    errors[key] = null;
    if (setter) setter(list);
    return list;
  }

  function errorText(err) {
    if (!err) return 'Unknown error';
    if (err.networkError) return 'Backend unreachable';
    if (err.code === 'TIMEOUT') return 'Request timed out';
    return err.message || 'Request failed';
  }

  function countByStatus(list, statuses) {
    return list.filter(item => statuses.indexOf(item.status) !== -1).length;
  }

  const ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'paused', 'stopping'];

  function renderStats() {
    const container = document.getElementById('dashboard-stats');
    if (!container) return;

    const models = data.models;
    const datasets = data.datasets;
    const jobs = data.jobs;
    const completed = countByStatus(jobs, ['completed']);
    const active = countByStatus(jobs, ACTIVE_STATUSES);
    const running = countByStatus(jobs, ['running']);
    const readyDatasets = datasets.filter(d => d.has_file === true || d.status === 'uploaded').length;

    const modelsState = errors.models ? '—' : CORPUS_UTILS.formatNumber(models.length);
    const datasetsState = errors.datasets ? '—' : CORPUS_UTILS.formatNumber(datasets.length);
    const completedState = errors.jobs ? '—' : CORPUS_UTILS.formatNumber(completed);
    const activeState = errors.jobs ? '—' : CORPUS_UTILS.formatNumber(active);
    const checkpointsState = errors.checkpoints ? '—' : CORPUS_UTILS.formatNumber(data.checkpoints.length);

    const cards = [
      {
        label: 'Total models',
        value: modelsState,
        icon: 'fa-cube',
        tone: '',
        foot: errors.models || (models.length ? 'Latest: ' + (models[0].name || models[0].id) : 'Create your first model'),
      },
      {
        label: 'Datasets',
        value: datasetsState,
        icon: 'fa-database',
        tone: 'is-info',
        foot: errors.datasets || (datasets.length ? readyDatasets + ' with an uploaded file' : 'Upload a dataset to train'),
      },
      {
        label: 'Completed jobs',
        value: completedState,
        icon: 'fa-check-double',
        tone: 'is-success',
        foot: errors.jobs || (jobs.length ? jobs.length + ' job(s) recorded' : 'No jobs recorded yet'),
      },
      {
        label: 'Active jobs',
        value: activeState,
        icon: 'fa-circle-notch',
        tone: 'is-warning',
        foot: errors.jobs || (running ? running + ' running now' : active ? 'Waiting to run' : 'Nothing running'),
      },
      {
        label: 'Checkpoints',
        value: checkpointsState,
        icon: 'fa-save',
        tone: '',
        foot: errors.checkpoints || (data.checkpoints.length ? 'Saved from training runs' : 'Created by finished jobs'),
      },
    ];

    container.innerHTML = cards.map(card => `
      <article class="stat-card" data-aos="fade-up">
        <div class="stat-top">
          <span class="stat-label">${esc(card.label)}</span>
          <span class="stat-icon ${card.tone}"><i class="fas ${card.icon}"></i></span>
        </div>
        <div class="stat-value">${esc(card.value)}</div>
        <div class="stat-foot">${esc(card.foot)}</div>
      </article>
    `).join('');
  }

  function renderActivity() {
    const container = document.getElementById('dashboard-activity');
    if (!container) return;

    const items = [];

    data.jobs.forEach(job => {
      items.push({
        at: job.updated_at || job.created_at,
        icon: jobIcon(job.status),
        title: 'Training job ' + (job.status || 'queued'),
        meta: [
          (data.models.find(m => m.id === job.model_id) || {}).name || job.model_id || 'model',
          (data.datasets.find(d => d.id === job.dataset_id) || {}).name || 'dataset',
          job.id,
        ].filter(Boolean).join(' · '),
        status: job.status,
      });
    });

    data.datasets.forEach(ds => {
      if (!ds.uploaded_at) return;
      items.push({
        at: ds.uploaded_at,
        icon: 'fa-file-arrow-up',
        title: 'Dataset uploaded',
        meta: [ds.name, ds.file_name].filter(Boolean).join(' · '),
        status: ds.status,
      });
    });

    items.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    const recent = items.slice(0, 6);

    if (!recent.length) {
      const failed = errors.jobs && errors.datasets;
      container.innerHTML = failed
        ? ui.emptyState({ icon: 'fa-plug-circle-xmark', title: 'Activity unavailable', text: 'The backend could not be reached, so there is no activity to show.', compact: true })
        : ui.emptyState({
            icon: 'fa-clock-rotate-left',
            title: 'No activity yet',
            text: 'Create a model, upload a dataset, then start a training job to see it here.',
            compact: true,
          });
      return;
    }

    container.innerHTML = '<div class="activity-list">' + recent.map(item => `
      <div class="activity-item">
        <span class="activity-dot"><i class="fas ${item.icon}"></i></span>
        <div class="activity-main">
          <div class="activity-title">${esc(item.title)}</div>
          <div class="activity-meta">
            <span>${esc(item.meta)}</span>
            <span>·</span>
            <span>${esc(ui.timeAgo(item.at))}</span>
          </div>
        </div>
        ${item.status ? ui.statusBadge(item.status) : ''}
      </div>
    `).join('') + '</div>';
  }

  function jobIcon(status) {
    if (status === 'completed') return 'fa-circle-check';
    if (status === 'failed' || status === 'cancelled') return 'fa-circle-exclamation';
    if (status === 'running') return 'fa-circle-notch';
    if (status === 'paused' || status === 'pausing') return 'fa-pause';
    return 'fa-hourglass-half';
  }

  function renderModelOverview() {
    const container = document.getElementById('dashboard-models');
    if (!container) return;

    if (errors.models) {
      container.innerHTML = ui.emptyState({ icon: 'fa-plug-circle-xmark', title: 'Models unavailable', text: errors.models, compact: true });
      return;
    }

    if (!data.models.length) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-cube',
        title: 'No models yet',
        text: 'Create a model configuration to see architecture details here.',
        actionLabel: 'Create model',
        actionOnclick: "router.navigate('models')",
        actionIcon: 'fa-plus',
        compact: true,
      });
      return;
    }

    container.innerHTML = data.models.slice(0, 4).map(model => {
      const config = model.config || {};
      const known = ['n_layers', 'n_heads', 'd_model', 'vocab_size', 'context_length'].some(key => config[key]);
      const params = known ? CORPUS_UTILS.calculateParameters(config) : null;
      const bits = [];
      if (config.n_layers) bits.push(config.n_layers + ' layers');
      if (config.d_model) bits.push(config.d_model + ' dim');
      if (config.context_length) bits.push(config.context_length + ' ctx');
      if (params) bits.push(CORPUS_UTILS.formatNumber(params) + ' params (computed)');
      return `
        <div class="overview-row">
          <span class="activity-dot"><i class="fas fa-cube"></i></span>
          <div class="overview-main">
            <div class="overview-name">${esc(model.name || 'Unnamed')}</div>
            <div class="overview-meta">${esc(bits.length ? bits.join(' · ') : 'No architecture details recorded')}</div>
          </div>
          ${ui.statusBadge(model.status || 'idle')}
        </div>
      `;
    }).join('') + (data.models.length > 4
      ? '<p class="field-hint" style="margin-top:var(--space-3);">Showing 4 of ' + data.models.length + ' models.</p>'
      : '');
  }

  function renderActivityChart() {
    const canvas = document.getElementById('dashboard-activity-chart');
    const empty = document.getElementById('dashboard-activity-empty');
    if (!canvas) return;

    const jobs = data.jobs.filter(job => job.created_at);
    if (!jobs.length || errors.jobs) {
      canvas.style.display = 'none';
      if (empty) empty.classList.remove('hidden');
      if (chartInstances.activity) {
        try { chartInstances.activity.destroy(); } catch (e) {}
        chartInstances.activity = null;
      }
      return;
    }

    canvas.style.display = 'block';
    if (empty) empty.classList.add('hidden');

    const days = [];
    const counts = [];
    for (let i = 6; i >= 0; i -= 1) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      days.push(day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
      const next = day.getTime() + 86400000;
      counts.push(jobs.filter(job => {
        const t = new Date(job.created_at).getTime();
        return t >= day.getTime() && t < next;
      }).length);
    }

    chartInstances.activity = window.charts.createLineChart('dashboard-activity-chart', days, [
      {
        label: 'Jobs created',
        data: counts,
        borderColor: '#b9a7ff',
        backgroundColor: 'rgba(124, 92, 255, 0.16)',
        pointBackgroundColor: '#b9a7ff',
        borderWidth: 2,
        tension: 0.35,
        fill: true,
      },
    ], {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#a6a1b3' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          beginAtZero: true,
          ticks: { color: '#a6a1b3', precision: 0, stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
      animation: { duration: 500 },
    });
  }

  function renderQuickActions() {
    const container = document.getElementById('dashboard-quick-actions');
    if (!container) return;
    const actions = [
      { route: 'models', icon: 'fa-cube', label: 'Create model' },
      { route: 'datasets', icon: 'fa-database', label: 'Manage datasets' },
      { route: 'training', icon: 'fa-flask', label: 'Start training' },
      { route: 'chat', icon: 'fa-comments', label: 'Chat with model' },
      { route: 'prediction-lab', icon: 'fa-microscope', label: 'Prediction lab' },
      { route: 'compute', icon: 'fa-server', label: 'Compute' },
    ];
    container.innerHTML = actions.map(action => `
      <button class="action-btn" type="button" onclick="router.navigate('${action.route}')">
        <i class="fas ${action.icon}"></i><span>${action.label}</span>
      </button>
    `).join('');
  }

  function renderConnectivity() {
    const body = document.getElementById('dashboard-connectivity-body');
    if (!body) return;

    const apiBase = (window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_BASE_URL) || 'not configured';
    const health = data.health;
    let dot = 'pending';
    let label = 'Checking backend…';
    let detail = '';

    if (health) {
      if (health.ok) {
        dot = 'online';
        label = 'Online';
        const status = health.data && health.data.status ? String(health.data.status) : 'ok';
        detail = 'Status: ' + status;
      } else if (health.networkError) {
        dot = 'offline';
        label = 'Offline';
        detail = health.message || 'The backend could not be reached.';
      } else if (health.httpError) {
        dot = 'pending';
        label = 'Responded with HTTP ' + health.status;
        detail = (health.data && health.data.detail) || 'The backend is reachable but reported an error.';
      } else {
        dot = 'offline';
        label = 'Check failed';
        detail = health.message || 'Unknown error.';
      }
    } else {
      dot = 'offline';
      label = 'Unavailable';
      detail = 'No health response received.';
    }

    const anyData = [data.models, data.datasets, data.jobs].some(list => list.length > 0);
    body.innerHTML = `
      <div class="connectivity-row">
        <span class="conn-dot ${dot}"></span>
        <strong style="color:var(--color-text);">${esc(label)}</strong>
        ${detail ? '<span>· ' + esc(detail) + '</span>' : ''}
      </div>
      <dl class="kv-grid">
        <div><dt>API base</dt><dd class="mono" style="font-size:var(--text-label-small); overflow-wrap:anywhere;">${esc(apiBase)}</dd></div>
        <div><dt>Data loaded</dt><dd>${anyData ? 'Models, datasets and jobs' : 'No records returned'}</dd></div>
      </dl>
      ${dot === 'offline' ? '<button class="btn btn-outline btn-sm" type="button" style="margin-top:var(--space-3);" onclick="dashboard.refresh()"><i class="fas fa-rotate"></i> Retry connection</button>' : ''}
    `;
  }

  function dispose() {
    Object.keys(chartInstances).forEach(key => {
      if (chartInstances[key]) {
        try { chartInstances[key].destroy(); } catch (e) {}
      }
    });
    chartInstances = {};
  }

  return { render, refresh, dispose };
})();
