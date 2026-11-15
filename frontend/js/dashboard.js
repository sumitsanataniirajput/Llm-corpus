/* ========================================
   CORPUS ULTIMATE — Dashboard page
   ======================================== */

window.dashboard = (function () {
  let charts = {};

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to view the dashboard.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="dashboard-header">
        <div>
          <h1 class="section-title">Dashboard</h1>
          <p class="section-subtitle">Welcome back, ${escapeHtml(user.email || 'user')}. Here is your CORPUS workspace.</p>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-primary" onclick="router.navigate('models')"><i class="fas fa-plus"></i> New Model</button>
          <button class="btn btn-outline" onclick="router.navigate('training')"><i class="fas fa-flask"></i> Training</button>
        </div>
      </div>

      <div class="dashboard-grid" id="dashboard-stats">
        <!-- stat cards injected -->
      </div>

      <div class="grid-2" id="dashboard-main">
        <div class="card" style="grid-column: span 2;">
          <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Quick Actions</h3>
          <div class="quick-actions" id="dashboard-quick-actions">
            <!-- quick actions -->
          </div>
        </div>
      </div>

      <div class="grid-2" id="dashboard-charts">
        <!-- charts -->
      </div>
    `;

    await loadStats();
    renderQuickActions();
    await renderCharts();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function loadStats() {
    const container = document.getElementById('dashboard-stats');
    const models = state.getModels() || [];
    const jobs = state.getTrainingJobs() || [];
    const activeModel = state.getActiveModel();
    const completed = jobs.filter(j => j.status === 'completed').length;
    const running = jobs.filter(j => j.status === 'running').length;

    const params = activeModel ? CORPUS_UTILS.calculateParameters(activeModel.config || {}) : 0;

    const stats = [
      { label: 'Active Models', value: models.length, icon: 'fa-cube', color: 'var(--color-primary)' },
      { label: 'Training Jobs', value: jobs.length, icon: 'fa-flask', color: 'var(--color-secondary)' },
      { label: 'Completed', value: completed, icon: 'fa-check-circle', color: 'var(--color-success)' },
      { label: 'Running', value: running, icon: 'fa-circle-notch fa-spin', color: 'var(--color-warning)' },
      { label: 'Parameters', value: params > 0 ? formatNumber(params) : '—', icon: 'fa-hashtag', color: 'var(--color-info)' },
      { label: 'Last Session', value: formatDate(models.length > 0 ? models[0].created_at : null), icon: 'fa-clock', color: 'var(--color-tertiary)' },
    ];

    container.innerHTML = stats.map(s => `
      <div class="stat-card" data-aos="fade-up">
        <div class="stat-icon" style="color:${s.color}"><i class="fas ${s.icon}"></i></div>
        <div class="stat-value">${s.value}</div>
        <div class="stat-label">${s.label}</div>
      </div>
    `).join('');
  }

  function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString();
  }

  function renderQuickActions() {
    const container = document.getElementById('dashboard-quick-actions');
    container.innerHTML = `
      <div class="action-btn" onclick="router.navigate('models')">
        <i class="fas fa-cube"></i><span>Create Model</span>
      </div>
      <div class="action-btn" onclick="router.navigate('datasets')">
        <i class="fas fa-database"></i><span>Manage Datasets</span>
      </div>
      <div class="action-btn" onclick="router.navigate('training')">
        <i class="fas fa-flask"></i><span>Start Training</span>
      </div>
      <div class="action-btn" onclick="router.navigate('chat')">
        <i class="fas fa-comments"></i><span>Chat with Model</span>
      </div>
      <div class="action-btn" onclick="router.navigate('prediction-lab')">
        <i class="fas fa-microscope"></i><span>Prediction Lab</span>
      </div>
      <div class="action-btn" onclick="router.navigate('compute')">
        <i class="fas fa-server"></i><span>Compute Manager</span>
      </div>
    `;
  }

  async function renderCharts() {
    const container = document.getElementById('dashboard-charts');
    container.innerHTML = `
      <div class="card">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Training Activity</h3>
        <div class="chart-container">
          <canvas id="dashboard-activity-chart"></canvas>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Model Distribution</h3>
        <div class="chart-container">
          <canvas id="dashboard-models-chart"></canvas>
        </div>
      </div>
    `;

    // Activity chart
    const jobs = state.getTrainingJobs() || [];
    const labels = jobs.map(j => (j.created_at ? new Date(j.created_at).toLocaleDateString() : '—'));
    const values = jobs.map(() => 1);
    charts.activity = charts.createLineChart('dashboard-activity-chart', labels, [
      { label: 'Jobs', data: values, borderColor: '#6750a4', backgroundColor: 'rgba(103, 80, 164, 0.1)', tension: 0.4, fill: true },
    ]);

    // Models chart
    const models = state.getModels() || [];
    const statuses = {};
    models.forEach(m => { statuses[m.status || 'unknown'] = (statuses[m.status || 'unknown'] || 0) + 1; });
    charts.models = charts.createDonutChart('dashboard-models-chart',
      Object.keys(statuses),
      Object.values(statuses)
    );
  }

  return { render };
})();