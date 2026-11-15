/* ========================================
   CORPUS ULTIMATE — Experiment Manager page
   ======================================== */

window.experiments = (function () {
  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to manage experiments.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="experiments-header">
        <div>
          <h1 class="section-title">Experiment Manager</h1>
          <p class="section-subtitle">Track training configurations, datasets, seeds, and metrics for reproducibility.</p>
        </div>
      </div>

      <div class="experiment-grid" id="experiments-grid">
        <!-- experiment cards -->
      </div>
    `;

    await loadExperiments();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function loadExperiments() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listExperiments(token);
      state.setExperiments(data.experiments || data || []);
    } catch (err) {
      state.setExperiments([]);
      ui.toast('Backend unavailable — no experiments listed', 'warning');
    }
    renderExperiments();
  }

  function renderExperiments() {
    const container = document.getElementById('experiments-grid');
    const exps = state.getExperiments() || [];
    if (exps.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-flask"></i><h3>No experiments</h3><p>Run a training job to create an experiment record.</p></div>';
      return;
    }
    container.innerHTML = exps.map(e => `
      <div class="experiment-card" data-aos="fade-up">
        <h4>${escapeHtml(e.name || 'Unnamed Experiment')}</h4>
        <div class="experiment-meta">
          <span><i class="fas fa-calendar"></i> ${CORPUS_UTILS.formatDate(e.created_at)}</span>
          <span><i class="fas fa-tag"></i> ${escapeHtml(e.status || '—')}</span>
        </div>
        <p style="font-size:var(--text-body-small); color:var(--color-text-variant); margin-top:var(--space-2);">${escapeHtml(e.description || 'No description')}</p>
      </div>
    `).join('');
  }

  return { render, loadExperiments };
})();