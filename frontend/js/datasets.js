/* ========================================
   CORPUS ULTIMATE — Dataset Manager page
   ======================================== */

window.datasets = (function () {
  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to manage datasets.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="datasets-header">
        <div>
          <h1 class="section-title">Dataset Manager</h1>
          <p class="section-subtitle">Upload, inspect, and prepare datasets for training your CORPUS models.</p>
        </div>
        <button class="btn btn-primary" onclick="datasets.showUpload()"><i class="fas fa-upload"></i> Upload Dataset</button>
      </div>

      <div class="upload-area" id="datasets-upload-area" style="display:none; margin:var(--space-4) 0;">
        <i class="fas fa-file-import"></i>
        <h3 style="margin-bottom:var(--space-2); color:var(--color-text);">Upload Dataset</h3>
        <p style="color:var(--color-text-variant);">Supported: TXT, PDF, CSV, JSON, JSONL (max ${CORPUS_UTILS.formatBytes(window.CORPUS_CONFIG.MAX_FILE_SIZE)}).</p>
        <input type="file" id="datasets-file" multiple>
        <div style="margin-top:var(--space-3);">
          <input type="text" id="datasets-name" placeholder="Dataset name" style="padding:var(--space-2) var(--space-4); border:1px solid var(--color-outline-variant); border-radius:var(--radius-md); width:260px; background:var(--color-surface-elevated); color:var(--color-text);">
          <button class="btn btn-primary" onclick="datasets.handleUpload()" style="margin-left:var(--space-2);">Upload</button>
        </div>
      </div>

      <div class="dataset-library" id="datasets-library">
        <!-- dataset cards -->
      </div>
    `;

    await loadDatasets();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function showUpload() {
    const area = document.getElementById('datasets-upload-area');
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
  }

  async function loadDatasets() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listDatasets(token);
      state.setDatasets(data.datasets || data || []);
    } catch (err) {
      state.setDatasets([]);
      ui.toast('Backend unavailable — showing empty dataset list', 'warning');
    }
    renderDatasetList();
  }

  function renderDatasetList() {
    const container = document.getElementById('datasets-library');
    const datasets = state.getDatasets() || [];
    if (datasets.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-database"></i><h3>No datasets</h3><p>Upload a dataset to get started.</p></div>';
      return;
    }
    container.innerHTML = datasets.map(d => `
      <div class="dataset-card" data-aos="fade-up">
        <div class="dataset-header">
          <div class="dataset-title">${escapeHtml(d.name || 'Unnamed')}</div>
          <span class="status-badge ${d.status || 'ready'}">${d.status || 'ready'}</span>
        </div>
        <div class="dataset-meta">
          <span><i class="fas fa-file"></i> ${d.format || '—'}</span>
          <span><i class="fas fa-hashtag"></i> ${CORPUS_UTILS.formatNumber(d.token_count || 0)} tokens</span>
          <span><i class="fas fa-clock"></i> ${CORPUS_UTILS.formatDate(d.created_at)}</span>
        </div>
        <div class="dataset-actions">
          <button class="btn btn-outline" onclick="datasets.previewDataset('${escapeHtml(d.id)}')"><i class="fas fa-eye"></i> Preview</button>
          <button class="btn btn-outline" onclick="datasets.useDataset('${escapeHtml(d.id)}')"><i class="fas fa-flask"></i> Use for Training</button>
          <button class="btn btn-danger btn-sm" onclick="datasets.deleteDataset('${escapeHtml(d.id)}')"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    `).join('');
  }

  async function handleUpload() {
    const fileInput = document.getElementById('datasets-file');
    const nameInput = document.getElementById('datasets-name');
    const file = fileInput.files[0];
    if (!file) {
      ui.toast('Please select a file', 'error');
      return;
    }
    if (!nameInput.value.trim()) {
      ui.toast('Please enter a dataset name', 'error');
      return;
    }

    const ext = file.name.split('.').pop().toLowerCase();
    if (!window.CORPUS_CONFIG.SUPPORTED_DATASET_FORMATS.includes(ext)) {
      ui.toast('Unsupported file format: ' + ext, 'error');
      return;
    }
    if (file.size > window.CORPUS_CONFIG.MAX_FILE_SIZE) {
      ui.toast('File too large (max ' + CORPUS_UTILS.formatBytes(window.CORPUS_CONFIG.MAX_FILE_SIZE) + ')', 'error');
      return;
    }

    ui.setButtonLoading(document.querySelector('#datasets-upload-area .btn-primary'), true);
    try {
      const token = await state.getAccessToken();
      // First create dataset record
      const created = await window.CORPUS_API.createDataset({
        name: nameInput.value.trim(),
        format: ext,
        size: file.size,
      }, token);
      const datasetId = created.dataset?.id || created.id;

      // Then upload file
      const result = await window.CORPUS_API.uploadDatasetFile(datasetId, file, token);
      ui.toast('Dataset uploaded successfully', 'success');
      showUpload();
      fileInput.value = '';
      nameInput.value = '';
      await loadDatasets();
    } catch (err) {
      ui.toast(err.message || 'Upload failed', 'error');
    } finally {
      ui.setButtonLoading(document.querySelector('#datasets-upload-area .btn-primary'), false);
    }
  }

  function previewDataset(id) {
    const d = state.getDataset(id);
    if (!d) return;
    ui.toast('Preview for ' + (d.name || 'dataset') + ' — feature requires backend dataset endpoint', 'info');
  }

  function useDataset(id) {
    const d = state.getDataset(id);
    if (!d) return;
    document.getElementById('t-dataset')?.setAttribute('data-selected', id);
    ui.toast('Dataset selected: ' + (d.name || 'Unnamed'), 'info');
    router.navigate('training');
  }

  async function deleteDataset(id) {
    ui.confirm('Delete dataset', 'This will permanently delete the dataset. This cannot be undone.', async () => {
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.deleteDataset(id, token);
        state.removeDataset ? state.removeDataset(id) : null;
        ui.toast('Dataset deleted', 'success');
        await loadDatasets();
      } catch (err) {
        ui.toast(err.message || 'Delete failed', 'error');
      }
    });
  }

  return { render, showUpload, handleUpload, previewDataset, useDataset, deleteDataset };
})();