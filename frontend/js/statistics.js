/* ========================================
   CORPUS ULTIMATE — Statistics page
   ======================================== */

window.statistics = (function () {
  let charts = {};

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to view statistics.</p></div>';
      return;
    }

    const activeModel = state.getActiveModel();
    const params = activeModel ? CORPUS_UTILS.calculateParameters(activeModel.config || {}) : 0;
    const jobs = state.getTrainingJobs() || [];
    const completed = jobs.filter(j => j.status === 'completed').length;
    const running = jobs.filter(j => j.status === 'running').length;

    container.innerHTML = `
      <div class="stats-header">
        <div>
          <h1 class="section-title">Statistics</h1>
          <p class="section-subtitle">Genuine measured metrics from your CORPUS training jobs.</p>
        </div>
      </div>

      <div class="stats-overview">
        <div class="stat-card">
          <div class="stat-value">${CORPUS_UTILS.formatNumber(params)}</div>
          <div class="stat-label">Total Parameters</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${jobs.length}</div>
          <div class="stat-label">Training Sessions</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${completed}</div>
          <div class="stat-label">Completed Jobs</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${running}</div>
          <div class="stat-label">Running Jobs</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">—</div>
          <div class="stat-label">Tokens/sec (live)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">—</div>
          <div class="stat-label">Last Loss</div>
        </div>
      </div>

      <div class="stats-chart-row">
        <div class="card">
          <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Loss Over Time</h3>
          <div class="chart-container">
            <canvas id="stats-loss-chart"></canvas>
          </div>
        </div>
        <div class="card">
          <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Parameter Distribution</h3>
          <div class="chart-container">
            <canvas id="stats-params-chart"></canvas>
          </div>
        </div>
      </div>

      <div class="comparison-table card" style="padding:var(--space-5); margin-top:var(--space-6);">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Model Version Comparison</h3>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Model</th><th>Version</th><th>Parameters</th><th>Status</th><th>Last Loss</th><th>Duration</th>
              </tr>
            </thead>
            <tbody id="stats-comparison-body">
              <!-- rows injected -->
            </tbody>
          </table>
        </div>
      </div>
    `;

    renderCharts();
    renderComparison();
  }

  function renderCharts() {
    const jobs = state.getTrainingJobs() || [];
    const labels = jobs.map(j => (j.created_at ? new Date(j.created_at).toLocaleDateString() : '—'));
    const losses = jobs.map(j => j.metrics?.loss || 0);
    charts.loss = charts.createLineChart('stats-loss-chart', labels, [
      { label: 'Loss', data: losses, borderColor: '#6750a4', fill: false, tension: 0.4 },
    ]);

    const models = state.getModels() || [];
    charts.params = charts.createBarChart('stats-params-chart',
      models.map(m => (m.name || 'Unnamed').substring(0, 15)),
      [{
        label: 'Parameters',
        data: models.map(m => CORPUS_UTILS.calculateParameters(m.config || {})),
        backgroundColor: 'rgba(103, 80, 164, 0.7)',
      }]
    );
  }

  function renderComparison() {
    const body = document.getElementById('stats-comparison-body');
    const models = state.getModels() || [];
    if (models.length === 0) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--color-text-variant);">No models to compare.</td></tr>';
      return;
    }
    body.innerHTML = models.map(m => `
      <tr>
        <td>${escapeHtml(m.name || 'Unnamed')}</td>
        <td>${m.version || '1.0'}</td>
        <td>${CORPUS_UTILS.formatNumber(CORPUS_UTILS.calculateParameters(m.config || {}))}</td>
        <td>${ui.statusBadge(m.status || 'idle')}</td>
        <td>—</td>
        <td>—</td>
      </tr>
    `).join('');
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  return { render };
})();