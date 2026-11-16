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
        <p class="field-hint" style="margin-top:var(--space-3);">The file is stored in private Supabase Storage. Training requires an uploaded file.</p>
      </div>

      <div class="dataset-library" id="datasets-library">
        <!-- dataset cards -->
      </div>
    `;

    await loadDatasets();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }

  function normalizeList(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.datasets)) return data.datasets;
    return [];
  }

  function showUpload() {
    const area = document.getElementById('datasets-upload-area');
    if (!area) return;
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
  }

  async function loadDatasets() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listDatasets(token);
      state.setDatasets(normalizeList(data));
    } catch (err) {
      state.setDatasets([]);
      ui.toast(err.message || 'Could not load datasets from the backend', 'error');
    }
    renderDatasetList();
  }

  function statusLabel(dataset) {
    if (dataset.status === 'uploaded') return 'uploaded';
    if (dataset.status === 'failed') return 'failed';
    if (!dataset.has_file) return 'pending upload';
    return dataset.status || 'unknown';
  }

  function renderDatasetList() {
    const container = document.getElementById('datasets-library');
    if (!container) return;
    const datasets = state.getDatasets() || [];
    if (datasets.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-database"></i><h3>No datasets</h3><p>Upload a dataset to get started.</p></div>';
      return;
    }
    container.innerHTML = datasets.map(d => {
      const status = statusLabel(d);
      const statusClass = d.status || (d.has_file ? 'uploaded' : 'pending');
      const size = d.file_size || d.size;
      return `
      <div class="dataset-card" data-aos="fade-up">
        <div class="dataset-header">
          <div class="dataset-title">${escapeHtml(d.name || 'Unnamed')}</div>
          <span class="status-badge ${escapeHtml(statusClass)}">${escapeHtml(status)}</span>
        </div>
        <div class="dataset-meta">
          <span><i class="fas fa-file"></i> ${escapeHtml(d.file_name || 'no file uploaded')}</span>
          <span><i class="fas fa-hdd"></i> ${size ? escapeHtml(CORPUS_UTILS.formatBytes(size)) : '—'}</span>
          <span><i class="fas fa-font"></i> ${escapeHtml(d.format || '—')}</span>
          <span><i class="fas fa-hashtag"></i> ${CORPUS_UTILS.formatNumber(d.token_count || 0)} tokens</span>
          <span><i class="fas fa-clock"></i> ${escapeHtml(CORPUS_UTILS.formatDate(d.uploaded_at || d.created_at))}</span>
        </div>
        <div class="dataset-actions">
          ${d.has_file ? '' : `<button class="btn btn-primary" onclick="datasets.uploadFileFor('${escapeHtml(d.id)}')"><i class="fas fa-upload"></i> Upload file</button>`}
          <button class="btn btn-outline" onclick="datasets.previewDataset('${escapeHtml(d.id)}')" ${d.has_file ? '' : 'disabled title="Upload a file first"'}><i class="fas fa-eye"></i> Preview</button>
          <button class="btn btn-outline" onclick="datasets.useDataset('${escapeHtml(d.id)}')" ${d.has_file ? '' : 'disabled title="Upload a file first"'}><i class="fas fa-flask"></i> Use for Training</button>
          <button class="btn btn-danger btn-sm" onclick="datasets.deleteDataset('${escapeHtml(d.id)}')"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    `;
    }).join('');
  }

  async function handleUpload() {
    const fileInput = document.getElementById('datasets-file');
    const nameInput = document.getElementById('datasets-name');
    if (!fileInput || !nameInput) return;
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

    const uploadBtn = document.querySelector('#datasets-upload-area .btn-primary');
    ui.setButtonLoading(uploadBtn, true);
    try {
      const token = await state.getAccessToken();
      // 1. Create the dataset record (status: pending)
      const created = await window.CORPUS_API.createDataset({
        name: nameInput.value.trim(),
        format: ext,
        size: file.size,
      }, token);
      const datasetId = created.dataset?.id || created.id;
      if (!datasetId) throw new Error('The backend did not return a dataset id.');

      // 2. Upload the bytes to private storage (status becomes "uploaded")
      await window.CORPUS_API.uploadDatasetFile(datasetId, file, token);
      ui.toast('Dataset uploaded successfully', 'success');

      const area = document.getElementById('datasets-upload-area');
      if (area) area.style.display = 'none';
      fileInput.value = '';
      nameInput.value = '';

      // 3. Refresh the library from the backend so file metadata and status
      //    are exactly what the server reports.
      await loadDatasets();
      notifyDatasetsChanged(datasetId);
    } catch (err) {
      ui.toast(err.message || 'Upload failed', 'error');
      // A created-but-not-uploaded record must still show up as pending.
      await loadDatasets();
    } finally {
      ui.setButtonLoading(uploadBtn, false);
    }
  }

  function notifyDatasetsChanged(datasetId) {
    try {
      window.dispatchEvent(new CustomEvent('corpus:datasets-changed', { detail: { datasetId: datasetId } }));
    } catch (e) {
      // CustomEvent unsupported — ignore, pages reload on navigation anyway.
    }
  }

  // Attach (or replace) the stored file for an existing dataset record.
  // Used when the record was created but the upload step failed.
  function uploadFileFor(datasetId) {
    const dataset = state.getDataset(datasetId);
    if (!dataset) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.' + window.CORPUS_CONFIG.SUPPORTED_DATASET_FORMATS.join(',.');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      if (!window.CORPUS_CONFIG.SUPPORTED_DATASET_FORMATS.includes(ext)) {
        ui.toast('Unsupported file format: ' + ext, 'error');
        return;
      }
      if (file.size > window.CORPUS_CONFIG.MAX_FILE_SIZE) {
        ui.toast('File too large (max ' + CORPUS_UTILS.formatBytes(window.CORPUS_CONFIG.MAX_FILE_SIZE) + ')', 'error');
        return;
      }
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.uploadDatasetFile(datasetId, file, token);
        ui.toast('Dataset file uploaded', 'success');
        await loadDatasets();
        notifyDatasetsChanged(datasetId);
      } catch (err) {
        ui.toast(err.message || 'Upload failed', 'error');
        await loadDatasets();
      }
    };
    input.click();
  }

  async function previewDataset(id) {
    const d = state.getDataset(id);
    if (!d) return;
    ui.toast('Loading preview…', 'info', 1500);
    try {
      const token = await state.getAccessToken();
      const preview = await window.CORPUS_API.previewDataset(id, token);
      const body = escapeHtml(preview.preview || '').replace(/\n/g, '<br>');
      const meta = [
        preview.file_name ? 'File: ' + escapeHtml(preview.file_name) : null,
        preview.file_size ? 'Size: ' + escapeHtml(CORPUS_UTILS.formatBytes(preview.file_size)) : null,
        'Characters: ' + CORPUS_UTILS.formatNumber(preview.total_characters || 0),
        'Lines: ' + CORPUS_UTILS.formatNumber(preview.total_lines || 0),
        preview.truncated ? 'Showing the first ' + CORPUS_UTILS.formatNumber((preview.preview || '').length) + ' characters' : null,
      ].filter(Boolean).join(' · ');
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: d.name || 'Dataset preview',
          html: '<p style="font-size:0.8rem;color:#9e9aab;margin-bottom:0.75rem;">' + meta + '</p>' +
            '<pre style="text-align:left;white-space:pre-wrap;word-break:break-word;max-height:55vh;overflow:auto;background:#1c1b1f;color:#e6e1e5;padding:1rem;border-radius:0.5rem;font-size:0.8rem;">' + body + '</pre>',
          width: 'min(880px, 92vw)',
          confirmButtonText: 'Close',
        });
      } else {
        ui.toast('Preview: ' + (preview.preview || '').slice(0, 200), 'info', 8000);
      }
    } catch (err) {
      ui.toast(err.message || 'Preview failed', 'error');
    }
  }

  function useDataset(id) {
    const d = state.getDataset(id);
    if (!d) return;
    if (!d.has_file) {
      ui.toast('Upload a file for this dataset before training on it.', 'error');
      return;
    }
    if (state.setPendingDatasetId) state.setPendingDatasetId(id);
    ui.toast('Dataset selected: ' + (d.name || 'Unnamed'), 'info');
    router.navigate('training');
  }

  async function deleteDataset(id) {
    ui.confirm('Delete dataset', 'This will permanently delete the dataset and its stored file. This cannot be undone.', async () => {
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.deleteDataset(id, token);
        if (state.removeDataset) state.removeDataset(id);
        if (state.getPendingDatasetId && state.getPendingDatasetId() === id && state.clearPendingDatasetId) {
          state.clearPendingDatasetId();
        }
        ui.toast('Dataset deleted', 'success');
        await loadDatasets();
        notifyDatasetsChanged(null);
      } catch (err) {
        ui.toast(err.message || 'Delete failed', 'error');
      }
    });
  }

  return { render, showUpload, handleUpload, uploadFileFor, previewDataset, useDataset, deleteDataset, loadDatasets };
})();
