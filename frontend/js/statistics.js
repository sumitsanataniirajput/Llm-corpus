/* ========================================
   CORPUS ULTIMATE — Statistics

   Charts plot metric rows returned by /training/{job}/metrics and parameter
   counts computed from stored model configs. Empty data renders an explicit
   empty state instead of a zero-filled line.
   ======================================== */

window.statistics = (function () {
  'use strict';

  let models = [];
  let jobs = [];
  let checkpoints = [];
  let selectedJobId = null;
  let metrics = [];
  let jobError = null;

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
        text: 'Please sign in to view training statistics.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-chart-line"></i> Analytics</span>
          <h1 class="section-title">Statistics</h1>
          <p class="section-subtitle">Measured values from your model records, training jobs and metric rows — no simulated curves.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="statistics.reload()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
        </div>
      </div>

      <div class="stats-overview" id="stats-overview">
        ${ui.skeletonCards(4)}
      </div>

      <div class="stats-chart-row">
        <section class="card">
          <div class="card-head">
            <div>
              <h2 class="card-title">Loss over steps</h2>
              <p class="card-subtitle">Metric rows recorded for the selected job.</p>
            </div>
            <div class="input-field" style="margin:0; min-width:190px;">
              <label for="stats-job-select">Job</label>
              <select id="stats-job-select" onchange="statistics.selectJob(this.value)">
                <option value="">No jobs available</option>
              </select>
            </div>
          </div>
          <div class="chart-container">
            <canvas id="stats-loss-chart"></canvas>
            <div id="stats-loss-empty" class="chart-empty">
              <i class="fas fa-chart-line"></i>
              <span>No metrics recorded for this job yet.</span>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div>
              <h2 class="card-title">Parameters by model</h2>
              <p class="card-subtitle">Computed from each stored architecture.</p>
            </div>
          </div>
          <div class="chart-container">
            <canvas id="stats-params-chart"></canvas>
            <div id="stats-params-empty" class="chart-empty">
              <i class="fas fa-cube"></i>
              <span>No models with an architecture recorded.</span>
            </div>
          </div>
        </section>
      </div>

      <section class="card comparison-table">
        <div class="card-head">
          <div>
            <h2 class="card-title">Model comparison</h2>
            <p class="card-subtitle">Latest checkpoint loss and last job duration come from the API; “—” means the backend has no value.</p>
          </div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Model</th><th>Parameters</th><th>Status</th><th>Last loss</th><th>Last job duration</th></tr>
            </thead>
            <tbody id="stats-comparison-body">
              <tr><td colspan="5" class="table-empty">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    await reload();
  }

  async function reload() {
    const token = await state.getAccessToken();
    const results = await Promise.allSettled([
      window.CORPUS_API.listModels(token),
      window.CORPUS_API.listTrainingJobs(token),
      window.CORPUS_API.listAllCheckpoints(token),
    ]);

    models = listOf(results[0], 'models');
    jobs = listOf(results[1], 'jobs');
    checkpoints = listOf(results[2], 'checkpoints');
    jobError = results[1].status === 'rejected' ? (results[1].reason && results[1].reason.message) || 'Jobs unavailable' : null;

    if (results[0].status === 'fulfilled') state.setModels(models);
    if (results[1].status === 'fulfilled') state.setTrainingJobs(jobs);

    renderOverview();
    populateJobSelect();
    renderParameterChart();
    renderComparison();
  }

  function listOf(result, key) {
    if (result.status !== 'fulfilled') return [];
    const value = result.value;
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value[key])) return value[key];
    return [];
  }

  function computedParams(model) {
    const config = model.config || {};
    const hasArch = ['n_layers', 'n_heads', 'd_model', 'vocab_size', 'context_length', 'd_ff'].some(k => config[k]);
    return hasArch ? CORPUS_UTILS.calculateParameters(config) : null;
  }

  function latestCheckpointFor(modelId) {
    return checkpoints
      .filter(c => c.model_id === modelId && c.loss != null)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] || null;
  }

  function jobDuration(job) {
    if (!job || !job.created_at || !job.updated_at) return null;
    const start = new Date(job.created_at).getTime();
    const end = new Date(job.updated_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return CORPUS_UTILS.formatDuration(Math.round((end - start) / 1000));
  }

  function renderOverview() {
    const container = document.getElementById('stats-overview');
    if (!container) return;

    const knownParams = models.map(computedParams).filter(value => value != null);
    const totalParams = knownParams.reduce((sum, value) => sum + value, 0);
    const completed = jobs.filter(job => job.status === 'completed').length;
    const active = jobs.filter(job => ['queued', 'running', 'pausing', 'paused'].indexOf(job.status) !== -1).length;
    const latestCheckpoint = checkpoints
      .filter(c => c.loss != null)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] || null;
    const lastMetric = metrics.length ? metrics[metrics.length - 1] : null;

    const cards = [
      {
        label: 'Total parameters',
        value: knownParams.length ? CORPUS_UTILS.formatNumber(totalParams) : '—',
        icon: 'fa-hashtag',
        foot: knownParams.length ? knownParams.length + ' model(s) with a recorded architecture' : 'No architecture details available',
        tone: '',
      },
      {
        label: 'Training sessions',
        value: jobs.length ? CORPUS_UTILS.formatNumber(jobs.length) : (jobError ? '—' : '0'),
        icon: 'fa-flask',
        foot: jobError || (jobs.length ? completed + ' completed' : 'No jobs yet'),
        tone: 'is-info',
      },
      {
        label: 'Active jobs',
        value: jobError ? '—' : CORPUS_UTILS.formatNumber(active),
        icon: 'fa-circle-notch',
        foot: jobError || (active ? 'Includes queued and paused jobs' : 'Nothing running'),
        tone: 'is-warning',
      },
      {
        label: lastMetric ? 'Latest loss' : 'Latest checkpoint loss',
        value: lastMetric && lastMetric.loss != null
          ? Number(lastMetric.loss).toFixed(4)
          : latestCheckpoint ? Number(latestCheckpoint.loss).toFixed(4) : '—',
        icon: 'fa-arrow-trend-down',
        foot: lastMetric ? 'Step ' + esc(lastMetric.step) + ' of selected job' : latestCheckpoint ? 'From checkpoint ' + esc(latestCheckpoint.id) : 'No loss recorded yet',
        tone: 'is-success',
      },
    ];

    container.innerHTML = cards.map(card => `
      <article class="stat-card">
        <div class="stat-top">
          <span class="stat-label">${esc(card.label)}</span>
          <span class="stat-icon ${card.tone}"><i class="fas ${card.icon}"></i></span>
        </div>
        <div class="stat-value">${esc(card.value)}</div>
        <div class="stat-foot">${esc(card.foot)}</div>
      </article>
    `).join('');
  }

  function populateJobSelect() {
    const select = document.getElementById('stats-job-select');
    if (!select) return;
    if (!jobs.length) {
      select.innerHTML = '<option value="">No jobs available</option>';
      select.disabled = true;
      selectedJobId = null;
      metrics = [];
      renderLossChart();
      return;
    }
    select.disabled = false;
    select.innerHTML = jobs.map(job => {
      const model = models.find(m => m.id === job.model_id);
      const label = (model ? (model.name || model.id) : (job.model_id || 'model')) + ' · ' + (job.status || 'unknown') + ' · ' + job.id;
      return '<option value="' + esc(job.id) + '">' + esc(label) + '</option>';
    }).join('');
    const preferred = selectedJobId && jobs.some(job => job.id === selectedJobId)
      ? selectedJobId
      : (jobs.find(job => job.status === 'completed') || jobs[0]).id;
    select.value = preferred;
    selectJob(preferred);
  }

  async function selectJob(jobId) {
    selectedJobId = jobId;
    const empty = document.getElementById('stats-loss-empty');
    if (!jobId) {
      metrics = [];
      renderLossChart();
      renderOverview();
      return;
    }
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listTrainingMetrics(jobId, token);
      metrics = (Array.isArray(data) ? data : (data && data.metrics) || [])
        .filter(metric => metric && metric.loss != null)
        .sort((a, b) => Number(a.step) - Number(b.step));
    } catch (err) {
      metrics = [];
      if (empty) {
        empty.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>' + esc(err.message || 'Could not load metrics') + '</span>';
      }
    }
    renderLossChart();
    renderOverview();
  }

  function renderLossChart() {
    const canvas = document.getElementById('stats-loss-chart');
    const empty = document.getElementById('stats-loss-empty');
    if (!canvas) return;
    if (!metrics.length) {
      canvas.style.display = 'none';
      if (empty) {
        empty.innerHTML = '<i class="fas fa-chart-line"></i><span>No metrics recorded for this job yet.</span>';
        empty.classList.remove('hidden');
      }
      return;
    }
    canvas.style.display = 'block';
    if (empty) empty.classList.add('hidden');
    window.charts.createLineChart('stats-loss-chart', metrics.map(m => 'Step ' + m.step), [
      {
        label: 'Loss',
        data: metrics.map(m => Number(m.loss)),
        borderColor: '#b9a7ff',
        backgroundColor: 'rgba(124, 92, 255, 0.14)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      },
    ], {
      plugins: { legend: { display: false } },
      animation: { duration: 400 },
    });
  }

  function renderParameterChart() {
    const canvas = document.getElementById('stats-params-chart');
    const empty = document.getElementById('stats-params-empty');
    if (!canvas) return;
    const rows = models.map(model => ({ model: model, params: computedParams(model) })).filter(row => row.params);
    if (!rows.length) {
      canvas.style.display = 'none';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    canvas.style.display = 'block';
    if (empty) empty.classList.add('hidden');
    window.charts.createBarChart('stats-params-chart',
      rows.map(row => (row.model.name || row.model.id).slice(0, 16)),
      [{
        label: 'Parameters (computed)',
        data: rows.map(row => row.params),
        backgroundColor: 'rgba(124, 92, 255, 0.55)',
        borderRadius: 4,
      }],
      {
        plugins: { legend: { display: false } },
        animation: { duration: 400 },
        scales: {
          x: { ticks: { color: '#a6a1b3' }, grid: { display: false } },
          y: { ticks: { color: '#a6a1b3' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
        },
      }
    );
  }

  function renderComparison() {
    const body = document.getElementById('stats-comparison-body');
    if (!body) return;
    if (!models.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">No models to compare yet.</td></tr>';
      return;
    }
    body.innerHTML = models.map(model => {
      const params = computedParams(model);
      const ckpt = latestCheckpointFor(model.id);
      const lastJob = jobs
        .filter(job => job.model_id === model.id)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || null;
      return `
        <tr>
          <td>${esc(model.name || 'Unnamed')}</td>
          <td>${params ? esc(CORPUS_UTILS.formatNumber(params)) + ' <span class="chip">computed</span>' : '—'}</td>
          <td>${ui.statusBadge(model.status || 'idle')}</td>
          <td>${ckpt ? esc(Number(ckpt.loss).toFixed(4)) : '—'}</td>
          <td>${lastJob ? esc(jobDuration(lastJob) || '—') : '—'}</td>
        </tr>
      `;
    }).join('');
  }

  return { render, reload, selectJob };
})();
