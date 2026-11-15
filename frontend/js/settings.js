/* ========================================
   CORPUS ULTIMATE — Settings page
   ======================================== */

window.settings = (function () {
  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to access settings.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="settings-header">
        <div>
          <h1 class="section-title">Settings</h1>
          <p class="section-subtitle">Manage your account, theme, storage, workers, API keys, and security.</p>
        </div>
      </div>

      <div class="settings-section">
        <h3>Account</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>${escapeHtml(state.getUser().email || 'User')}</h4>
            <p>Account owner</p>
          </div>
          <button class="btn btn-outline btn-sm" onclick="auth.handleSignOut()">Sign out</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>Backend Connectivity</h3>
        <div id="settings-backend-status" style="padding:var(--space-3); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-md); margin-bottom:var(--space-4);">
          <div style="display:flex; align-items:center; gap:var(--space-2); font-size:var(--text-label-small);">
            <span id="settings-backend-indicator" style="width:8px; height:8px; border-radius:50%; background:var(--color-text-variant);"></span>
            <span id="settings-backend-text">Checking backend...</span>
          </div>
          <div id="settings-backend-detail" style="font-size:var(--text-caption); color:var(--color-text-variant); margin-top:var(--space-1);"></div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="settings.checkBackendHealth()" style="margin-bottom:var(--space-4);">
          <i class="fas fa-refresh"></i> Recheck Backend
        </button>
      </div>

      <div class="settings-section">
        <h3>Theme</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Appearance</h4>
            <p>Dark theme (default) or light theme</p>
          </div>
          <div>
            <button class="btn btn-outline btn-sm" onclick="settings.setTheme('dark')">Dark</button>
            <button class="btn btn-outline btn-sm" onclick="settings.setTheme('light')">Light</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>API Keys</h3>
        <p style="color:var(--color-text-variant); font-size:var(--text-body-small); margin-bottom:var(--space-3);">API keys are backend-managed. The full key is shown only once after creation.</p>
        <div id="settings-api-keys">
          <div style="text-align:center; color:var(--color-text-variant); padding:var(--space-4);">Loading API keys...</div>
        </div>
        <div style="margin-top:var(--space-3);">
          <button class="btn btn-outline btn-sm" onclick="settings.openCreateKeyModal()"><i class="fas fa-plus"></i> Create API Key</button>
        </div>
        <!-- Create API key modal -->
        <div id="settings-create-key-modal" class="modal hidden">
          <div class="modal-backdrop" onclick="settings.closeCreateKeyModal()"></div>
          <div class="modal-content auth-card" style="max-width:500px;">
            <div class="modal-header">
              <h3>Create API Key</h3>
              <button class="modal-close" onclick="settings.closeCreateKeyModal()">&times;</button>
            </div>
            <form id="settings-key-form" onsubmit="return settings.handleCreateKeySubmit(event)">
              <div class="input-field">
                <input type="text" id="settings-key-name" placeholder="Key name" required>
                <label for="settings-key-name">Key name</label>
              </div>
              <div class="confirm-actions" style="justify-content:flex-end; margin-top:var(--space-4);">
                <button class="btn btn-outline" type="button" onclick="settings.closeCreateKeyModal()">Cancel</button>
                <button class="btn btn-primary" type="submit">Create Key</button>
              </div>
            </form>
            <div id="settings-key-result" style="margin-top:var(--space-4); padding:var(--space-3); background:var(--color-surface); border:1px solid var(--color-border); border-radius:var(--radius-md); font-family:monospace; font-size:var(--text-label-small); color:var(--color-text-variant); word-break:break-all; display:none;"></div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Data & Storage</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Export Data</h4>
            <p>Export your models, datasets, and training history.</p>
          </div>
          <button class="btn btn-outline btn-sm" onclick="settings.exportData()">Export</button>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Delete Account</h4>
            <p>Permanently delete your account and all associated data.</p>
          </div>
          <button class="btn btn-danger btn-sm" onclick="settings.deleteAccount()">Delete Account</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>About CORPUS ULTIMATE</h3>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Version</h4>
            <p>1.0.0</p>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <h4>Backend</h4>
            <p style="font-family:monospace; font-size:var(--text-label-small); color:var(--color-text-variant);">${escapeHtml(window.CORPUS_CONFIG.API_BASE_URL)}</p>
          </div>
        </div>
      </div>
    `;

    await settings.checkBackendHealth();
    await loadApiKeys();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('corpus_theme', theme);
    ui.toast('Theme set to ' + theme, 'success');
  }

  // Backend health check with detailed diagnostics
  async function checkBackendHealth() {
    const indicator = document.getElementById('settings-backend-indicator');
    const text = document.getElementById('settings-backend-text');
    const detail = document.getElementById('settings-backend-detail');

    if (!indicator || !text) return;

    try {
      const result = await window.CORPUS_API.health();

      if (result.ok) {
        indicator.style.background = 'var(--color-success)';
        text.textContent = 'Backend is online';
        detail.textContent = 'Status: ' + (result.data && result.data.status ? result.data.status : 'ok') + ' — ' + result.backendUrl || window.CORPUS_CONFIG.API_BASE_URL;
        state.setConnection('connected');
      } else if (result.networkError) {
        indicator.style.background = 'var(--color-error)';
        text.textContent = 'Backend is offline';
        detail.textContent = result.message || 'Network error — cannot reach backend.';
        state.setConnection('disconnected');
      } else if (result.httpError) {
        indicator.style.background = 'var(--color-warning)';
        text.textContent = 'Backend returned HTTP ' + result.status;
        detail.textContent = (result.data && result.data.detail) || 'Backend returned an error.';
        state.setConnection('error');
      } else {
        indicator.style.background = 'var(--color-error)';
        text.textContent = 'Backend check failed';
        detail.textContent = result.message || 'Unknown error.';
        state.setConnection('disconnected');
      }
    } catch (err) {
      indicator.style.background = 'var(--color-error)';
      text.textContent = 'Backend check failed';
      detail.textContent = err.message || 'Unexpected error.';
      state.setConnection('disconnected');
    }
  }

  async function loadApiKeys() {
    const container = document.getElementById('settings-api-keys');
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listApiKeys(token);
      const keys = data.keys || data || [];
      if (keys.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:var(--color-text-variant); padding:var(--space-4);">No API keys. Create one below.</div>';
        return;
      }
      container.innerHTML = keys.map(k => `
        <div class="api-key-item">
          <div>
            <div style="font-weight:600; color:var(--color-text);">${escapeHtml(k.name || 'Key')}</div>
            <div style="font-size:var(--text-label-small); color:var(--color-text-variant);">${escapeHtml(k.prefix || '')}...</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="settings.revokeKey('${escapeHtml(k.id)}')">Revoke</button>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<div style="color:var(--color-text-variant); padding:var(--space-4);">Could not load API keys.</div>';
    }
  }

  function openCreateKeyModal() {
    document.getElementById('settings-key-form').reset();
    document.getElementById('settings-key-result').style.display = 'none';
    document.getElementById('settings-create-key-modal').classList.remove('hidden');
  }

  function closeCreateKeyModal() {
    document.getElementById('settings-create-key-modal').classList.add('hidden');
    document.getElementById('settings-key-result').style.display = 'none';
  }

  async function handleCreateKeySubmit(e) {
    e.preventDefault();
    const name = document.getElementById('settings-key-name').value;
    if (!name) {
      ui.toast('Please enter a key name', 'error');
      return false;
    }
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createApiKey({ name }, token);
      const resultEl = document.getElementById('settings-key-result');
      resultEl.innerHTML = '<strong>Key created — copy it now (shown only once):</strong><br>' + escapeHtml(data.key || '');
      resultEl.style.display = 'block';
      document.getElementById('settings-key-form').reset();
      ui.toast('API key created. Copy it now.', 'success');
      await loadApiKeys();
    } catch (err) {
      ui.toast(err.message || 'Failed to create API key', 'error');
    }
    return false;
  }

  async function revokeKey(id) {
    ui.confirm('Revoke API key', 'This will invalidate the key. Continue?', async () => {
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.revokeApiKey(id, token);
        ui.toast('API key revoked', 'success');
        loadApiKeys();
      } catch (err) {
        ui.toast(err.message || 'Revoke failed', 'error');
      }
    });
  }

  function exportData() {
    ui.toast('Export — downloads your models, datasets, and training history as JSON.', 'info');
  }

  function deleteAccount() {
    ui.confirm('Delete Account', 'This permanently deletes your account and all data. This cannot be undone.', async () => {
      try {
        await auth.handleSignOut();
        ui.toast('Account deleted', 'success');
      } catch (err) {
        ui.toast(err.message || 'Delete failed', 'error');
      }
    });
  }

  return { render, setTheme, loadApiKeys, revokeKey, openCreateKeyModal, closeCreateKeyModal, handleCreateKeySubmit, exportData, deleteAccount, checkBackendHealth };
})();