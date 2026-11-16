/* ========================================
   CORPUS ULTIMATE — Settings
   ======================================== */

window.settings = (function () {
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
        text: 'Please sign in to open settings.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const apiBase = (window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_BASE_URL) || 'not configured';

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-cog"></i> Preferences</span>
          <h1 class="section-title">Settings</h1>
          <p class="section-subtitle">Account, appearance, backend connectivity and API keys.</p>
        </div>
      </div>

      <section class="settings-section">
        <h3>Account</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>${esc(user.email || 'Signed-in account')}</h4>
            <p>Session managed by Supabase authentication.</p>
          </div>
          <button class="btn btn-outline btn-sm" type="button" onclick="auth.handleSignOut()">
            <i class="fas fa-sign-out-alt"></i> Sign out
          </button>
        </div>
      </section>

      <section class="settings-section">
        <h3>Backend connectivity</h3>
        <div class="info-panel" id="settings-backend-status" style="margin-bottom:var(--space-3);">
          <i class="fas fa-circle" id="settings-backend-indicator" style="font-size:0.5rem; color:var(--color-text-muted);"></i>
          <div>
            <strong id="settings-backend-text">Checking backend…</strong>
            <div class="field-hint" id="settings-backend-detail" style="margin:0;"></div>
          </div>
        </div>
        <div class="row-tight">
          <button class="btn btn-outline btn-sm" type="button" onclick="settings.checkBackendHealth()">
            <i class="fas fa-rotate"></i> Recheck backend
          </button>
          <span class="chip mono" style="max-width:100%;">${esc(apiBase)}</span>
        </div>
      </section>

      <section class="settings-section">
        <h3>Appearance</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Theme</h4>
            <p>Dark charcoal is the CORPUS default; light theme is available for bright environments.</p>
          </div>
          <div class="segmented" role="group" aria-label="Theme">
            <button type="button" class="${theme === 'dark' ? 'active' : ''}" onclick="settings.setTheme('dark')">Dark</button>
            <button type="button" class="${theme === 'light' ? 'active' : ''}" onclick="settings.setTheme('light')">Light</button>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3>API keys</h3>
        <p>Keys are created and revoked by the backend. The full value is shown once, immediately after creation.</p>
        <div id="settings-api-keys">
          <div class="skeleton skeleton-line"></div>
        </div>
        <div style="margin-top:var(--space-3);">
          <button class="btn btn-outline btn-sm" type="button" onclick="settings.openCreateKeyModal()">
            <i class="fas fa-plus"></i> Create API key
          </button>
        </div>

        <div id="settings-create-key-modal" class="modal hidden" role="dialog" aria-modal="true">
          <div class="modal-backdrop" onclick="settings.closeCreateKeyModal()"></div>
          <div class="modal-content" style="max-width:480px;">
            <button class="modal-close" type="button" aria-label="Close" onclick="settings.closeCreateKeyModal()">&times;</button>
            <div class="modal-header">
              <h3>Create API key</h3>
            </div>
            <form id="settings-key-form" onsubmit="return settings.handleCreateKeySubmit(event)">
              <div class="input-field">
                <label for="settings-key-name">Key name</label>
                <input type="text" id="settings-key-name" placeholder="e.g. notebook" maxlength="60" required autocomplete="off">
                <span class="field-hint">Choose a label you will recognise later.</span>
              </div>
              <div class="form-actions">
                <button class="btn btn-outline" type="button" onclick="settings.closeCreateKeyModal()">Cancel</button>
                <button class="btn btn-primary" type="submit">Create key</button>
              </div>
            </form>
            <div id="settings-key-result" class="form-alert success" style="display:none; margin-top:var(--space-3);"></div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3>Data</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Export workspace metadata</h4>
            <p>Downloads a JSON file with your models, datasets and training job records as returned by the API.</p>
          </div>
          <button class="btn btn-outline btn-sm" type="button" onclick="settings.exportData()">
            <i class="fas fa-download"></i> Export JSON
          </button>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Delete account</h4>
            <p>Account deletion is handled by Supabase and is not exposed by this backend, so it cannot be performed here.</p>
          </div>
          <button class="btn btn-outline btn-sm" type="button" disabled title="No account-deletion endpoint in this deployment">
            <i class="fas fa-lock"></i> Unavailable
          </button>
        </div>
      </section>

      <section class="settings-section">
        <h3>About</h3>
        <div class="setting-item">
          <div class="setting-info"><h4>CORPUS ULTIMATE</h4><p>Version ${esc((window.CORPUS_CONFIG && window.CORPUS_CONFIG.APP_VERSION) || '1.0.0')}</p></div>
        </div>
        <div class="setting-item">
          <div class="setting-info"><h4>API base</h4><p class="mono">${esc(apiBase)}</p></div>
        </div>
      </section>
    `;

    await settings.checkBackendHealth();
    await loadApiKeys();
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('corpus_theme', theme); } catch (e) { /* storage may be blocked */ }
    document.querySelectorAll('.segmented button').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === theme);
    });
    ui.toast('Theme set to ' + theme, 'success');
  }

  async function checkBackendHealth() {
    const indicator = document.getElementById('settings-backend-indicator');
    const text = document.getElementById('settings-backend-text');
    const detail = document.getElementById('settings-backend-detail');
    if (!text) return;

    text.textContent = 'Checking backend…';
    try {
      const result = await window.CORPUS_API.health();
      const setDot = (color) => { if (indicator) indicator.style.color = color; };

      if (result.ok) {
        setDot('var(--color-success)');
        text.textContent = 'Backend online';
        const status = result.data && result.data.status ? result.data.status : 'ok';
        if (detail) detail.textContent = 'Status: ' + status + ' · ' + ((window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_BASE_URL) || '');
        state.setConnection('connected');
      } else if (result.networkError) {
        setDot('var(--color-error)');
        text.textContent = 'Backend offline';
        if (detail) detail.textContent = result.message || 'Network error — the backend could not be reached.';
        state.setConnection('disconnected');
      } else if (result.httpError) {
        setDot('var(--color-warning)');
        text.textContent = 'Backend returned HTTP ' + result.status;
        if (detail) detail.textContent = (result.data && result.data.detail) || 'The backend is reachable but reported an error.';
        state.setConnection('error');
      } else {
        setDot('var(--color-error)');
        text.textContent = 'Backend check failed';
        if (detail) detail.textContent = result.message || 'Unknown error.';
        state.setConnection('disconnected');
      }
    } catch (err) {
      if (indicator) indicator.style.color = 'var(--color-error)';
      text.textContent = 'Backend check failed';
      if (detail) detail.textContent = err.message || 'Unexpected error.';
      state.setConnection('disconnected');
    }
  }

  async function loadApiKeys() {
    const container = document.getElementById('settings-api-keys');
    if (!container) return;
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listApiKeys(token);
      const keys = Array.isArray(data) ? data : (data && Array.isArray(data.keys) ? data.keys : []);
      if (!keys.length) {
        container.innerHTML = '<p class="field-hint" style="margin:0;">No API keys yet.</p>';
        return;
      }
      container.innerHTML = keys.map(key => `
        <div class="api-key-item">
          <div style="min-width:0;">
            <div style="font-weight:600; color:var(--color-text); font-size:var(--text-body-small); overflow-wrap:anywhere;">${esc(key.name || 'Key')}</div>
            <div class="api-key-value">${esc(key.prefix || '')}${key.prefix ? '…' : ''}</div>
            <div class="field-hint" style="margin:0;">Created ${esc(CORPUS_UTILS.formatDate(key.created_at))}</div>
          </div>
          <button class="btn btn-danger btn-sm" type="button" onclick="settings.revokeKey('${esc(key.id)}')">Revoke</button>
        </div>
      `).join('');
    } catch (err) {
      const message = err.status === 404
        ? 'This backend does not expose API keys yet.'
        : 'Could not load API keys: ' + (err.message || 'backend unavailable');
      container.innerHTML = '<p class="field-hint" style="margin:0;">' + esc(message) + '</p>';
    }
  }

  function openCreateKeyModal() {
    const form = document.getElementById('settings-key-form');
    if (form) form.reset();
    const result = document.getElementById('settings-key-result');
    if (result) result.style.display = 'none';
    const modal = document.getElementById('settings-create-key-modal');
    if (modal) modal.classList.remove('hidden');
  }

  function closeCreateKeyModal() {
    const modal = document.getElementById('settings-create-key-modal');
    if (modal) modal.classList.add('hidden');
    const result = document.getElementById('settings-key-result');
    if (result) result.style.display = 'none';
  }

  async function handleCreateKeySubmit(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('settings-key-name');
    const name = input ? input.value.trim() : '';
    if (!name) {
      ui.toast('Enter a key name.', 'error');
      return false;
    }
    const submit = document.querySelector('#settings-key-form button[type="submit"]');
    ui.setButtonLoading(submit, true);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createApiKey({ name: name }, token);
      const resultEl = document.getElementById('settings-key-result');
      if (resultEl) {
        resultEl.innerHTML = '<i class="fas fa-key"></i><span><strong>Copy this key now — it is shown only once:</strong><br>' + esc(data.key || '') + '</span>';
        resultEl.style.display = 'flex';
      }
      if (input) input.value = '';
      ui.toast('API key created', 'success');
      await loadApiKeys();
    } catch (err) {
      ui.toast(err.message || 'Failed to create API key', 'error');
    } finally {
      ui.setButtonLoading(submit, false);
    }
    return false;
  }

  async function revokeKey(id) {
    ui.confirm('Revoke API key', 'This immediately invalidates the key. Continue?', async () => {
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.revokeApiKey(id, token);
        ui.toast('API key revoked', 'success');
        await loadApiKeys();
      } catch (err) {
        ui.toast(err.message || 'Revoke failed', 'error');
      }
    });
  }

  // Real client-side export of the metadata the API returns.
  async function exportData() {
    try {
      const token = await state.getAccessToken();
      const results = await Promise.allSettled([
        window.CORPUS_API.listModels(token),
        window.CORPUS_API.listDatasets(token),
        window.CORPUS_API.listTrainingJobs(token),
      ]);
      const payload = {
        exported_at: new Date().toISOString(),
        api_base: (window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_BASE_URL) || null,
        models: results[0].status === 'fulfilled' ? results[0].value : null,
        datasets: results[1].status === 'fulfilled' ? results[1].value : null,
        training_jobs: results[2].status === 'fulfilled' ? results[2].value : null,
        errors: results
          .map((result, index) => result.status === 'rejected'
            ? ['models', 'datasets', 'training_jobs'][index] + ': ' + (result.reason && result.reason.message)
            : null)
          .filter(Boolean),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'corpus-workspace-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      ui.toast('Workspace metadata exported', 'success');
    } catch (err) {
      ui.toast(err.message || 'Export failed', 'error');
    }
  }

  return {
    render,
    setTheme,
    loadApiKeys,
    revokeKey,
    openCreateKeyModal,
    closeCreateKeyModal,
    handleCreateKeySubmit,
    exportData,
    checkBackendHealth,
  };
})();
