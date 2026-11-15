/* ========================================
   CORPUS ULTIMATE — Compute Manager page
   ======================================== */

window.compute = (function () {
  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to manage compute.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="compute-header">
        <div>
          <h1 class="section-title">Compute Manager</h1>
          <p class="section-subtitle">View connected workers, hardware capabilities, and job assignments.</p>
        </div>
      </div>

      <div class="worker-grid" id="compute-workers">
        <!-- worker cards -->
      </div>

      <div class="card" style="margin-top:var(--space-6); padding:var(--space-5);">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Local Device Info</h3>
        <div class="form-grid" id="compute-local-info">
          <!-- local hardware info -->
        </div>
      </div>
    `;

    await loadWorkers();
    renderLocalInfo();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function loadWorkers() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listWorkers(token);
      state.setWorkers(data.workers || data || []);
    } catch (err) {
      state.setWorkers([]);
      ui.toast('Backend unavailable — no workers listed', 'warning');
    }
    renderWorkers();
  }

  function renderWorkers() {
    const container = document.getElementById('compute-workers');
    const workers = state.getWorkers() || [];
    if (workers.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><h3>No workers connected</h3><p>Register a local or cloud worker to train models remotely.</p></div>';
      return;
    }
    container.innerHTML = workers.map(w => `
      <div class="worker-card" data-aos="fade-up">
        <div class="worker-header">
          <div class="worker-name">${escapeHtml(w.name || 'Worker')}</div>
          ${w.status === 'online' ? '<span class="status-badge running"><i class="fas fa-circle"></i> Online</span>' : '<span class="status-badge cancelled"><i class="fas fa-circle"></i> Offline</span>'}
        </div>
        <div class="worker-specs">
          <div class="worker-spec">
            <div class="spec-label">OS</div>
            <div class="spec-value">${escapeHtml(w.os || '—')}</div>
          </div>
          <div class="worker-spec">
            <div class="spec-label">CPU</div>
            <div class="spec-value">${escapeHtml(w.cpu || '—')}</div>
          </div>
          <div class="worker-spec">
            <div class="spec-label">RAM</div>
            <div class="spec-value">${w.ram ? CORPUS_UTILS.formatBytes(w.ram) : '—'}</div>
          </div>
          <div class="worker-spec">
            <div class="spec-label">GPU</div>
            <div class="spec-value">${escapeHtml(w.gpu || 'None')}</div>
          </div>
          <div class="worker-spec">
            <div class="spec-label">VRAM</div>
            <div class="spec-value">${w.vram ? CORPUS_UTILS.formatBytes(w.vram) : '—'}</div>
          </div>
          <div class="worker-spec">
            <div class="spec-label">Backend</div>
            <div class="spec-value">${escapeHtml(w.backend || '—')}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  function renderLocalInfo() {
    const container = document.getElementById('compute-local-info');
    const nav = navigator;
    const info = [
      { label: 'Platform', value: navigator.platform || '—' },
      { label: 'User Agent', value: navigator.userAgent.split(' ')[0] + '...' },
      { label: 'Online', value: navigator.onLine ? 'Yes' : 'No' },
      { label: 'Cookies', value: navigator.cookieEnabled ? 'Yes' : 'No' },
      { label: 'Language', value: navigator.language || '—' },
      { label: 'Concurrency', value: navigator.hardwareConcurrency || '—' },
      { label: 'Memory', value: (navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '—') },
    ];
    container.innerHTML = info.map(i => `
      <div class="setting-item">
        <div class="setting-info">
          <h4>${escapeHtml(i.label)}</h4>
          <p>${escapeHtml(i.value)}</p>
        </div>
      </div>
    `).join('');
  }

  return { render, loadWorkers, renderWorkers, renderLocalInfo };
})();