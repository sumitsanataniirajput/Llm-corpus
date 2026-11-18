/* ========================================
   CORPUS ULTIMATE — Compute Manager
   ======================================== */

window.compute = (function () {
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
        text: 'Please sign in to view compute resources.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-server"></i> Execution</span>
          <h1 class="section-title">Compute Manager</h1>
          <p class="section-subtitle">Workers registered with your account and the capabilities this browser reports.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="compute.loadWorkers(this)">
            <i class="fas fa-rotate"></i> Refresh workers
          </button>
        </div>
      </div>

      <div class="worker-grid" id="compute-workers">
        ${ui.skeletonCards(2)}
      </div>

      <section class="card">
        <div class="card-head">
          <div>
            <h2 class="card-title">This browser</h2>
            <p class="card-subtitle">Only values the browser actually exposes are listed.</p>
          </div>
        </div>
        <dl class="kv-grid" id="compute-local-info"></dl>
      </section>
    `;

    await loadWorkers();
    renderLocalInfo();
  }

  async function loadWorkers(sourceButton) {
    return window.CORPUS_ACTIONS.refresh({
      name: 'Refresh compute workers',
      element: sourceButton || null,
      run: loadWorkersData,
    });
  }

  async function loadWorkersData() {
    const container = document.getElementById('compute-workers');
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listWorkers(token);
      const workers = Array.isArray(data) ? data : (data && Array.isArray(data.workers) ? data.workers : []);
      state.setWorkers(workers);
      renderWorkers(workers);
    } catch (err) {
      state.setWorkers([]);
      if (container) {
        container.innerHTML = ui.emptyState({
          icon: 'fa-plug-circle-xmark',
          title: 'Workers unavailable',
          text: err.message || 'The backend did not return a worker list.',
          actionLabel: 'Retry',
          actionOnclick: 'compute.loadWorkers()',
          actionIcon: 'fa-rotate',
        });
      }
      ui.toast('Backend unavailable — no workers listed', 'warning');
    }
  }

  function renderWorkers(list) {
    const container = document.getElementById('compute-workers');
    if (!container) return;
    const workers = list || state.getWorkers() || [];
    if (!workers.length) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-server',
        title: 'No workers registered',
        text: 'Training runs in-process on the backend CPU worker. Register a remote worker to distribute jobs.',
        compact: true,
      });
      return;
    }
    container.innerHTML = workers.map(worker => {
      const online = worker.status === 'online';
      return `
        <article class="worker-card">
          <div class="worker-header">
            <div class="worker-name">${esc(worker.name || 'Worker')}</div>
            <span class="status-badge ${online ? 'running' : 'cancelled'}">
              <i class="fas fa-circle"></i> ${online ? 'Online' : 'Offline'}
            </span>
          </div>
          <div class="worker-specs">
            <div class="worker-spec"><div class="spec-label">OS</div><div class="spec-value">${esc(worker.os || '—')}</div></div>
            <div class="worker-spec"><div class="spec-label">CPU</div><div class="spec-value">${esc(worker.cpu || '—')}</div></div>
            <div class="worker-spec"><div class="spec-label">RAM</div><div class="spec-value">${worker.ram ? esc(CORPUS_UTILS.formatBytes(worker.ram)) : '—'}</div></div>
            <div class="worker-spec"><div class="spec-label">GPU</div><div class="spec-value">${esc(worker.gpu || 'None reported')}</div></div>
            <div class="worker-spec"><div class="spec-label">VRAM</div><div class="spec-value">${worker.vram ? esc(CORPUS_UTILS.formatBytes(worker.vram)) : '—'}</div></div>
            <div class="worker-spec"><div class="spec-label">Backend</div><div class="spec-value">${esc(worker.backend || '—')}</div></div>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderLocalInfo() {
    const container = document.getElementById('compute-local-info');
    if (!container) return;
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const info = [
      { label: 'Platform', value: nav.platform || 'not reported' },
      { label: 'Online', value: nav.onLine ? 'Yes' : 'No' },
      { label: 'Language', value: nav.language || 'not reported' },
      { label: 'CPU threads', value: nav.hardwareConcurrency || 'not reported' },
      { label: 'Device memory', value: nav.deviceMemory ? nav.deviceMemory + ' GB' : 'not reported' },
      { label: 'User agent', value: nav.userAgent ? nav.userAgent.split(' ')[0] : 'not reported' },
    ];
    container.innerHTML = info.map(item => `
      <div>
        <dt>${esc(item.label)}</dt>
        <dd>${esc(item.value)}</dd>
      </div>
    `).join('');
  }

  return { render, loadWorkers, renderWorkers, renderLocalInfo };
})();
