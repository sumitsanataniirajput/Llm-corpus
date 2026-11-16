/* ========================================
   CORPUS ULTIMATE — Experiment Manager
   ======================================== */

window.experiments = (function () {
  'use strict';

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
        text: 'Please sign in to view experiments.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-flask"></i> Reproducibility</span>
          <h1 class="section-title">Experiment Manager</h1>
          <p class="section-subtitle">Experiment records returned by the backend: configuration, status and notes.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="experiments.loadExperiments()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
        </div>
      </div>

      <div class="experiment-grid" id="experiments-grid">
        ${ui.skeletonCards(2)}
      </div>
    `;

    await loadExperiments();
  }

  async function loadExperiments() {
    const container = document.getElementById('experiments-grid');
    if (container) container.innerHTML = ui.skeletonCards(2);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listExperiments(token);
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.experiments) ? data.experiments : []);
      state.setExperiments(list);
      renderExperiments(list);
    } catch (err) {
      state.setExperiments([]);
      if (container) {
        container.innerHTML = ui.emptyState({
          icon: 'fa-plug-circle-xmark',
          title: 'Experiments unavailable',
          text: err.message || 'The backend did not return an experiment list.',
          actionLabel: 'Retry',
          actionOnclick: 'experiments.loadExperiments()',
          actionIcon: 'fa-rotate',
        });
      }
      ui.toast('Backend unavailable — no experiments listed', 'warning');
    }
  }

  function renderExperiments(list) {
    const container = document.getElementById('experiments-grid');
    if (!container) return;
    const exps = list || state.getExperiments() || [];
    if (!exps.length) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-flask',
        title: 'No experiments recorded',
        text: 'Every training job already stores its configuration. Experiment records appear here once the backend creates them.',
        actionLabel: 'Open training center',
        actionOnclick: "router.navigate('training')",
        actionIcon: 'fa-play',
      });
      return;
    }
    container.innerHTML = exps.map(exp => `
      <article class="experiment-card" data-aos="fade-up">
        <h4>${esc(exp.name || 'Unnamed experiment')}</h4>
        <div class="experiment-meta">
          <span><i class="fas fa-calendar"></i> ${esc(CORPUS_UTILS.formatDate(exp.created_at))}</span>
          <span><i class="fas fa-tag"></i> ${esc(exp.status || '—')}</span>
        </div>
        <p class="field-hint" style="margin:0;">${esc(exp.description || 'No description recorded.')}</p>
      </article>
    `).join('');
  }

  return { render, loadExperiments };
})();
