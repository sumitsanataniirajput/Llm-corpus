/* ========================================
   CORPUS ULTIMATE — Cloud Storage

   The summary is computed from the objects the backend actually returns.
   No quota percentage is shown because the API does not report a quota.
   ======================================== */

window.storage = (function () {
  'use strict';

  let objects = [];
  let loadError = null;

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
        text: 'Please sign in to browse your cloud storage.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-cloud"></i> Private bucket</span>
          <h1 class="section-title">Cloud Storage</h1>
          <p class="section-subtitle">Objects stored for your account: dataset uploads, checkpoints and tokenizers.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="storage.loadFiles()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
        </div>
      </div>

      <div class="storage-grid">
        <section class="card">
          <div class="card-head">
            <div>
              <h2 class="card-title">Usage</h2>
              <p class="card-subtitle">Totals from the listed objects.</p>
            </div>
          </div>
          <div id="storage-summary">
            <div class="skeleton skeleton-line short"></div>
            <div class="skeleton skeleton-line"></div>
          </div>
          <p class="field-hint" style="margin-top:var(--space-3);">The storage API does not report a quota, so no usage percentage is shown.</p>
        </section>

        <section class="card">
          <div class="card-head">
            <div>
              <h2 class="card-title">Backups</h2>
              <p class="card-subtitle">Snapshot and restore endpoints are not part of this deployment.</p>
            </div>
          </div>
          <div class="info-panel">
            <i class="fas fa-circle-info"></i>
            <div>Backups are unavailable because the backend does not expose a backup endpoint yet. Model checkpoints saved by training runs are listed on the right and can be restored from the Training Center.</div>
          </div>
          <div class="training-actions">
            <button class="btn btn-outline" type="button" disabled title="Not available in this deployment">
              <i class="fas fa-save"></i> Create backup
            </button>
            <button class="btn btn-outline" type="button" disabled title="Not available in this deployment">
              <i class="fas fa-upload"></i> Restore
            </button>
          </div>
        </section>
      </div>

      <section class="card" style="padding:0; overflow:hidden;">
        <div class="card-head" style="padding:var(--space-4) var(--space-4) 0;">
          <div>
            <h2 class="card-title">Stored objects</h2>
            <p class="card-subtitle">Read directly from the storage endpoint.</p>
          </div>
          <span class="chip" id="storage-count">—</span>
        </div>
        <div class="table-wrapper" style="border:none; border-radius:0;">
          <table>
            <thead>
              <tr><th>Name</th><th>Type</th><th>Size</th><th>Updated</th><th>Actions</th></tr>
            </thead>
            <tbody id="storage-files-body">
              <tr><td colspan="5" class="table-empty">Loading objects…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    await loadFiles();
  }

  async function loadFiles() {
    const body = document.getElementById('storage-files-body');
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listStorageObjects(token);
      objects = Array.isArray(data) ? data : (data && Array.isArray(data.objects) ? data.objects : []);
      loadError = null;
    } catch (err) {
      objects = [];
      loadError = err && err.message ? err.message : 'Could not load storage objects';
    }
    renderSummary();
    renderTable();
  }

  function totalSize() {
    return objects.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  }

  function renderSummary() {
    const container = document.getElementById('storage-summary');
    if (!container) return;
    const count = objects.length;
    const size = totalSize();
    container.innerHTML = `
      <div class="stat-card" style="margin-bottom:var(--space-3); box-shadow:none;">
        <div class="stat-label">Objects</div>
        <div class="stat-value">${loadError ? '—' : CORPUS_UTILS.formatNumber(count)}</div>
        <div class="stat-foot">${esc(loadError || 'Files listed for your account')}</div>
      </div>
      <div class="stat-card" style="box-shadow:none;">
        <div class="stat-label">Listed size</div>
        <div class="stat-value">${loadError ? '—' : (size ? esc(CORPUS_UTILS.formatBytes(size)) : '0 B')}</div>
        <div class="stat-foot">Sum of the sizes reported by the API</div>
      </div>
    `;
    const chip = document.getElementById('storage-count');
    if (chip) chip.textContent = loadError ? 'Unavailable' : count + ' object' + (count === 1 ? '' : 's');
  }

  function renderTable() {
    const body = document.getElementById('storage-files-body');
    if (!body) return;
    if (loadError) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(loadError) + '</td></tr>';
      return;
    }
    if (!objects.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">No stored objects yet. Dataset uploads and training checkpoints appear here.</td></tr>';
      return;
    }
    body.innerHTML = objects.map((file, index) => {
      const name = file.name || file.path || '—';
      const id = file.id || file.path || name;
      return `
        <tr>
          <td style="max-width:320px;">
            <div style="font-weight:500; overflow-wrap:anywhere;">${esc(name)}</div>
            ${file.path && file.name ? '<div class="field-hint" style="margin:0; overflow-wrap:anywhere;">' + esc(file.path) + '</div>' : ''}
          </td>
          <td>${esc(file.type || (file.content_type || '—'))}</td>
          <td>${file.size ? esc(CORPUS_UTILS.formatBytes(file.size)) : '—'}</td>
          <td>${esc(CORPUS_UTILS.formatDate(file.updated_at || file.created_at))}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-outline btn-sm" type="button" onclick="storage.downloadFile('${esc(id)}')" title="Download object">
              <i class="fas fa-download"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function downloadFile(id) {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.downloadStorageObject(id, token);
      if (data && data.url) {
        window.open(data.url, '_blank', 'noopener');
        return;
      }
      ui.toast('The backend did not return a download URL for this object.', 'warning');
    } catch (err) {
      ui.toast(err.message || 'Download unavailable for this object', 'error');
    }
  }

  return { render, loadFiles, downloadFile };
})();
