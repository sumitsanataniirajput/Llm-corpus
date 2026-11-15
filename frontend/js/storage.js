/* ========================================
   CORPUS ULTIMATE — Cloud Storage page
   ======================================== */

window.storage = (function () {
  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to access cloud storage.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="storage-header">
        <div>
          <h1 class="section-title">Cloud Storage</h1>
          <p class="section-subtitle">Manage your models, datasets, checkpoints, and backups in Supabase Storage.</p>
        </div>
      </div>

      <div class="storage-grid">
        <div class="storage-usage">
          <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Storage Usage</h3>
          <div class="stat-card" style="margin-bottom:var(--space-4);">
            <div class="stat-value">—</div>
            <div class="stat-label">Used</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">—</div>
            <div class="stat-label">Available</div>
          </div>
          <div class="progress-container" style="margin-top:var(--space-4);">
            <div class="progress-bar" style="width:45%; background:var(--color-primary);"></div>
          </div>
          <div class="progress-text"><span>45%</span><span>of quota</span></div>
        </div>
        <div class="file-list">
          <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Stored Objects</h3>
          <div class="table-wrapper" style="margin:0;">
            <table>
              <thead>
                <tr><th>Name</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Actions</th></tr>
              </thead>
              <tbody id="storage-files-body">
                <tr><td colspan="5" style="text-align:center; color:var(--color-text-variant);">No files yet.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:var(--space-6); padding:var(--space-5);">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Backups & Restore</h3>
        <div class="training-actions">
          <button class="btn btn-outline" onclick="storage.createBackup()"><i class="fas fa-save"></i> Create Backup</button>
          <button class="btn btn-outline" onclick="storage.restoreBackup()"><i class="fas fa-upload"></i> Restore</button>
        </div>
        <p style="margin-top:var(--space-3); font-size:var(--text-body-small); color:var(--color-text-variant);">Backups are stored in your private Supabase bucket and can only be accessed by your account.</p>
      </div>
    `;

    await loadFiles();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function loadFiles() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listStorageObjects(token);
      const files = data.objects || data || [];
      const body = document.getElementById('storage-files-body');
      if (files.length === 0) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--color-text-variant);">No files yet.</td></tr>';
        return;
      }
      body.innerHTML = files.map(f => `
        <tr>
          <td>${escapeHtml(f.name || f.path || '—')}</td>
          <td>${escapeHtml(f.type || '—')}</td>
          <td>${f.size ? CORPUS_UTILS.formatBytes(f.size) : '—'}</td>
          <td>${CORPUS_UTILS.formatDate(f.created_at || f.updated_at)}</td>
          <td>
            <button class="btn btn-outline btn-sm" onclick="storage.downloadFile('${escapeHtml(f.id || f.path)}')"><i class="fas fa-download"></i></button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      ui.toast('Could not load storage objects', 'error');
    }
  }

  function downloadFile(id) {
    ui.toast('Download requires backend storage endpoint', 'info');
  }

  function createBackup() {
    ui.toast('Backup — creates a snapshot of your models and datasets.', 'info');
  }

  function restoreBackup() {
    ui.toast('Restore — select a backup to restore from.', 'info');
  }

  return { render, loadFiles, downloadFile, createBackup, restoreBackup };
})();