/* ========================================
   CORPUS ULTIMATE — Dataset Manager

   Upload flow (real): 1) create the dataset record, 2) upload the bytes to
   private Supabase Storage through the backend with progress events,
   3) refresh the library from the API. One record is created per file;
   multiple files are uploaded sequentially so nothing is silently dropped.
   ======================================== */

window.datasets = (function () {
  'use strict';

  let queue = [];
  let uploading = false;
  let searchTerm = '';

  function esc(value) {
    return ui.escapeHtml(value == null ? '' : String(value));
  }

  function formats() {
    return (window.CORPUS_CONFIG && window.CORPUS_CONFIG.SUPPORTED_DATASET_FORMATS) || ['txt', 'md', 'csv', 'json', 'jsonl', 'pdf'];
  }

  function maxSize() {
    return (window.CORPUS_CONFIG && window.CORPUS_CONFIG.MAX_FILE_SIZE) || 104857600;
  }

  function formatsLabel() {
    return formats().map(ext => ext.toUpperCase()).join(', ');
  }

  function acceptAttr() {
    const mimeByExt = {
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      jsonl: 'application/x-ndjson',
      pdf: 'application/pdf',
    };
    const tokens = [];
    formats().forEach(ext => {
      tokens.push('.' + ext);
      if (mimeByExt[ext]) tokens.push(mimeByExt[ext]);
    });
    return tokens.join(',');
  }

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Please sign in to upload and manage datasets.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-database"></i> Dataset library</span>
          <h1 class="section-title">Dataset Manager</h1>
          <p class="section-subtitle">Upload training text to private storage, inspect what the backend stored, and send a dataset straight to training.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="datasets.loadDatasets()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
          <button class="btn btn-primary" type="button" onclick="datasets.showUpload()">
            <i class="fas fa-upload"></i> Upload dataset
          </button>
        </div>
      </div>

      <section class="upload-panel" id="datasets-upload-area" style="display:none;" aria-label="Upload dataset">
        <div class="card-head" style="margin-bottom:var(--space-3);">
          <div>
            <h2 class="card-title">New upload</h2>
            <p class="card-subtitle">Files are stored in your private Supabase bucket and registered one dataset per file.</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" onclick="datasets.showUpload()" aria-label="Close upload panel">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!--
          Mobile-first file picking.

          The <input type="file"> below is NOT visually hidden with a 1px clip and
          it is NOT pointer-events:none. It is a transparent, full-size overlay
          covering the whole drop zone (CSS: .drop-zone > input[type="file"]).
          A real tap therefore lands directly on the real native control, which
          is what reliably opens Android Chrome's file manager. No JavaScript
          click handler and no programmatic input.click() is involved, so the
          picker can never open twice. The decorative text/icons are
          pointer-events:none so they never swallow the tap.
        -->
        <label for="datasets-file" class="drop-zone" id="datasets-drop" aria-label="Choose dataset files">
          <i class="fas fa-file-import" aria-hidden="true"></i>
          <strong>Drop files here, or tap to browse</strong>
          <span class="drop-zone-meta">${esc(formatsLabel())} · up to ${esc(CORPUS_UTILS.formatBytes(maxSize()))} per file</span>
          <span class="drop-zone-cta"><i class="fas fa-folder-open" aria-hidden="true"></i> Tap to choose files</span>
          <input type="file" id="datasets-file" name="datasets-file" class="drop-zone-input"
                 multiple accept="${esc(acceptAttr())}" aria-label="Choose dataset files">
        </label>

        <div class="file-queue" id="datasets-file-list"></div>

        <div class="upload-form-grid">
          <div class="input-field">
            <label for="datasets-name">Dataset name</label>
            <input type="text" id="datasets-name" placeholder="e.g. Wiki corpus" maxlength="120" autocomplete="off">
            <span class="field-hint" id="datasets-name-hint">Required for a single file. Multiple files get their own record named after each file.</span>
          </div>
          <div class="input-field">
            <label for="datasets-format-note">Format support</label>
            <input type="text" id="datasets-format-note" value="${esc(formatsLabel())}" readonly>
            <span class="field-hint">Text is extracted on the backend before tokenization (PDF pages are extracted too).</span>
          </div>
        </div>

        <div class="upload-actions">
          <button class="btn btn-primary" id="datasets-upload-btn" type="button" onclick="datasets.handleUpload()">
            <i class="fas fa-upload"></i> Upload
          </button>
          <button class="btn btn-outline" type="button" onclick="datasets.clearSelection()">Clear</button>
        </div>

        <div class="upload-progress-list" id="datasets-progress" aria-live="polite"></div>

        <p class="field-hint" style="margin-top:var(--space-3);">The file is stored privately; only your account can read it. Training requires an uploaded file.</p>
      </section>

      <div class="toolbar">
        <div class="search-field">
          <i class="fas fa-search"></i>
          <input type="search" id="datasets-search" placeholder="Search datasets by name or file" autocomplete="off"
                 oninput="datasets.setSearch(this.value)">
        </div>
        <span class="chip" id="datasets-count">—</span>
      </div>

      <div class="dataset-library" id="datasets-library">
        ${ui.skeletonCards(2)}
      </div>
    `;

    bindUploadInputs();
    await loadDatasets();
  }

  function normalizeList(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.datasets)) return data.datasets;
    return [];
  }

  function showUpload() {
    const area = document.getElementById('datasets-upload-area');
    if (!area) return;
    const isHidden = area.style.display === 'none' || !area.style.display;
    area.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      const name = document.getElementById('datasets-name');
      if (name) setTimeout(() => name.focus(), 60);
    }
  }

  function setSearch(value) {
    searchTerm = String(value || '').trim().toLowerCase();
    renderDatasetList();
  }

  function bindUploadInputs() {
    const input = document.getElementById('datasets-file');
    const drop = document.getElementById('datasets-drop');
    if (input && input.dataset.bound !== '1') {
      input.dataset.bound = '1';
      input.addEventListener('change', () => {
        const picked = Array.prototype.slice.call(input.files || []);
        if (picked.length) setQueue(picked);
        // Reset input value so re-picking the exact same file after clear/retry still fires change.
        try { input.value = ''; } catch (e) { /* read-only in mocked inputs */ }
      });
    }
    if (!drop || drop.dataset.bound === '1') return;
    drop.dataset.bound = '1';
    // No keydown/click handler that calls input.click(): the native file input is
    // itself the full-size tap target inside the label, so a synthetic click
    // would open the Android picker a second time.
    ['dragenter', 'dragover'].forEach(type => {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('is-dragover');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach(type => {
      drop.addEventListener(type, () => drop.classList.remove('is-dragover'));
    });
    // `drop` fires on the transparent overlay input and bubbles up to the label.
    // preventDefault() stops the browser from also assigning input.files (which
    // would fire a second `change` event) — the queue is filled exactly once.
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      const files = event.dataTransfer && event.dataTransfer.files
        ? Array.prototype.slice.call(event.dataTransfer.files)
        : [];
      if (!files.length) return;
      setQueue(files);
    });
  }

  function setQueue(files) {
    queue = files.map(file => {
      const invalid = validateFile(file);
      return {
        file: file,
        name: file.name,
        size: file.size,
        datasetId: null,
        state: invalid ? 'failed' : 'ready',
        progress: 0,
        message: invalid || '',
      };
    });
    renderQueue();
    const firstError = queue.find(item => item.state === 'failed');
    if (firstError && firstError.message) {
      ui.toast(firstError.message, 'error');
    }
  }

  function renderQueue() {
    const list = document.getElementById('datasets-file-list');
    if (!list) return;
    if (!queue.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = queue.map((item, index) => `
      <div class="file-row">
        <span class="file-row-icon"><i class="fas fa-file"></i></span>
        <div class="file-row-main">
          <div class="file-row-name" title="${esc(item.name)}">${esc(item.name)}</div>
          <div class="file-row-meta">${esc(CORPUS_UTILS.formatBytes(item.size))} · ${esc((item.name.split('.').pop() || '').toLowerCase())}
            ${item.message ? ' · ' + esc(item.message) : ''}</div>
        </div>
        <span class="upload-progress-state ${item.state === 'done' ? 'done' : item.state === 'failed' ? 'failed' : ''}">${esc(item.state)}</span>
        <button class="btn btn-ghost btn-sm" type="button" aria-label="Remove file" onclick="datasets.removeQueued(${index})">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `).join('');
  }

  function removeQueued(index) {
    if (uploading) return;
    queue.splice(index, 1);
    renderQueue();
  }

  function clearSelection() {
    if (uploading) return;
    queue = [];
    renderQueue();
    const input = document.getElementById('datasets-file');
    if (input) input.value = '';
    const progress = document.getElementById('datasets-progress');
    if (progress) progress.innerHTML = '';
  }

  async function loadDatasets() {
    const container = document.getElementById('datasets-library');
    if (container && !(state.getDatasets() || []).length) container.innerHTML = ui.skeletonCards(2);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listDatasets(token);
      state.setDatasets(normalizeList(data));
    } catch (err) {
      state.setDatasets([]);
      if (container) {
        container.innerHTML = ui.emptyState({
          icon: 'fa-plug-circle-xmark',
          title: 'Could not load datasets',
          text: err.message || 'The backend did not return a dataset list.',
          actionLabel: 'Retry',
          actionOnclick: 'datasets.loadDatasets()',
          actionIcon: 'fa-rotate',
        });
      }
      ui.toast(err.message || 'Could not load datasets from the backend', 'error');
      updateCount();
      return;
    }
    renderDatasetList();
  }

  function statusLabel(dataset) {
    if (dataset.status === 'uploaded') return 'uploaded';
    if (dataset.status === 'failed') return 'failed';
    if (!dataset.has_file) return 'pending upload';
    return dataset.status || 'unknown';
  }

  function updateCount() {
    const chip = document.getElementById('datasets-count');
    if (!chip) return;
    const total = (state.getDatasets() || []).length;
    const visible = filterDatasets(state.getDatasets() || []).length;
    chip.textContent = searchTerm ? visible + ' of ' + total + ' shown' : total + ' dataset' + (total === 1 ? '' : 's');
  }

  function filterDatasets(list) {
    if (!searchTerm) return list;
    return list.filter(d => {
      const haystack = [d.name, d.file_name, d.format, d.id].filter(Boolean).join(' ').toLowerCase();
      return haystack.indexOf(searchTerm) !== -1;
    });
  }

  function renderDatasetList() {
    const container = document.getElementById('datasets-library');
    if (!container) return;
    const datasets = state.getDatasets() || [];
    updateCount();

    if (datasets.length === 0) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-database',
        title: 'No datasets yet',
        text: 'Upload a training file to create your first dataset. Accepted formats: ' + formatsLabel() + '.',
        actionLabel: 'Upload dataset',
        actionOnclick: 'datasets.showUpload()',
        actionIcon: 'fa-upload',
      });
      return;
    }

    const visible = filterDatasets(datasets);
    if (!visible.length) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-magnifying-glass',
        title: 'No matching datasets',
        text: 'No dataset matches “' + searchTerm + '”. Clear the search to see all datasets.',
        actionLabel: 'Clear search',
        actionClass: 'btn-outline',
        actionOnclick: "datasets.setSearch('');document.getElementById('datasets-search').value='';",
        actionIcon: 'fa-times',
        compact: true,
      });
      return;
    }

    container.innerHTML = visible.map(d => {
      const status = statusLabel(d);
      const statusClass = d.status || (d.has_file ? 'uploaded' : 'pending');
      const size = d.file_size || d.size;
      const tokens = typeof d.token_count === 'number' ? d.token_count : null;
      return `
      <article class="dataset-card" data-aos="fade-up">
        <div class="dataset-header">
          <div class="dataset-title" title="${esc(d.name || 'Unnamed')}">${esc(d.name || 'Unnamed dataset')}</div>
          <span class="status-badge ${esc(statusClass)}">${esc(status)}</span>
        </div>
        <div class="dataset-meta">
          <span><i class="fas fa-file"></i> ${esc(d.file_name || 'no file uploaded')}</span>
          <span><i class="fas fa-hdd"></i> ${size ? esc(CORPUS_UTILS.formatBytes(size)) : '—'}</span>
          <span><i class="fas fa-font"></i> ${esc((d.format || '—').toUpperCase())}</span>
          <span><i class="fas fa-hashtag"></i> ${tokens ? esc(CORPUS_UTILS.formatNumber(tokens)) + ' tokens' : 'token count not recorded'}</span>
          <span><i class="fas fa-clock"></i> ${esc(d.uploaded_at || d.created_at ? CORPUS_UTILS.formatDate(d.uploaded_at || d.created_at) : 'never uploaded')}</span>
        </div>
        <div class="dataset-actions">
          ${d.has_file ? '' : `<button class="btn btn-primary btn-sm" type="button" onclick="datasets.uploadFileFor('${esc(d.id)}')" title="Attach the missing file"><i class="fas fa-upload"></i> Upload file</button>`}
          <button class="btn btn-outline btn-sm" type="button" onclick="datasets.previewDataset('${esc(d.id)}')" ${d.has_file ? '' : 'disabled title="Upload a file first"'}>
            <i class="fas fa-eye"></i> Preview
          </button>
          <button class="btn btn-outline btn-sm" type="button" onclick="datasets.useDataset('${esc(d.id)}')" ${d.has_file ? '' : 'disabled title="Upload a file first"'}>
            <i class="fas fa-flask"></i> Use for training
          </button>
          <button class="btn btn-danger btn-sm" type="button" onclick="datasets.deleteDataset('${esc(d.id)}')" title="Delete dataset">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </article>
    `;
    }).join('');
  }

  function validateFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (formats().indexOf(ext) === -1) {
      return 'Unsupported format "' + ext + '". Supported: ' + formatsLabel() + '.';
    }
    if (file.size > maxSize()) {
      return 'File too large (max ' + CORPUS_UTILS.formatBytes(maxSize()) + ').';
    }
    if (!file.size) {
      return 'That file is empty.';
    }
    return null;
  }

  function progressRow(index, item) {
    return `
      <div class="upload-progress-row" data-index="${index}">
        <div class="upload-progress-head">
          <span class="upload-progress-name" title="${esc(item.name)}">${esc(item.name)}</span>
          <span class="upload-progress-state ${item.state === 'done' ? 'done' : item.state === 'failed' ? 'failed' : ''}">${esc(item.state)}</span>
        </div>
        <div class="progress-container"><div class="progress-bar ${item.state === 'failed' ? 'is-error' : item.state === 'done' ? 'is-success' : ''}" style="width:${item.progress}%"></div></div>
        ${item.message ? '<p class="field-hint" style="margin-top:var(--space-1);">' + esc(item.message) + '</p>' : ''}
      </div>
    `;
  }

  function renderProgress() {
    const container = document.getElementById('datasets-progress');
    if (!container) return;
    container.innerHTML = queue.map((item, index) => progressRow(index, item)).join('');
  }

  function updateProgress(index) {
    const container = document.getElementById('datasets-progress');
    if (!container) return;
    const row = container.querySelector('[data-index="' + index + '"]');
    if (row) {
      row.outerHTML = progressRow(index, queue[index]);
    } else {
      renderProgress();
    }
  }

  async function handleUpload() {
    if (uploading) return;
    const nameInput = document.getElementById('datasets-name');
    const baseName = nameInput ? nameInput.value.trim() : '';
    const files = queue.map(item => item.file).filter(Boolean);

    if (!files.length) {
      ui.toast('Choose at least one file to upload.', 'error');
      return;
    }
    const invalids = queue.map(item => validateFile(item.file)).filter(Boolean);
    if (invalids.length) {
      ui.toast(invalids[0], 'error');
      return;
    }

    if (files.length === 1 && !baseName) {
      ui.toast('Enter a dataset name for this file.', 'error');
      if (nameInput) nameInput.focus();
      return;
    }

    uploading = true;
    const uploadBtn = document.getElementById('datasets-upload-btn');
    ui.setButtonLoading(uploadBtn, true);
    let successCount = 0;
    let failedCount = 0;
    let lastDatasetId = null;

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (item.state === 'done') {
        successCount += 1;
        continue;
      }
      const file = item.file;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const datasetName = files.length === 1
        ? baseName
        : (baseName ? baseName + ' · ' : '') + file.name.replace(/\.[^.]+$/, '');

      queue[index].state = 'uploading';
      queue[index].progress = 0;
      queue[index].message = item.datasetId ? 'Retrying upload…' : 'Creating dataset record…';
      updateProgress(index);

      try {
        const token = await state.getAccessToken();
        let datasetId = item.datasetId;
        if (!datasetId) {
          const created = await window.CORPUS_API.createDataset({
            name: datasetName,
            format: ext,
            size: file.size,
          }, token);
          datasetId = (created && created.dataset && created.dataset.id) || (created && created.id);
          if (!datasetId) throw new Error('The backend did not return a dataset id.');
          queue[index].datasetId = datasetId;
        }

        queue[index].message = 'Uploading bytes…';
        updateProgress(index);

        await window.CORPUS_API.uploadDatasetFileWithProgress(datasetId, file, token, (percent) => {
          if (percent == null) return;
          queue[index].progress = percent;
          updateProgress(index);
        });

        queue[index].state = 'done';
        queue[index].progress = 100;
        queue[index].message = 'Stored and registered.';
        updateProgress(index);
        successCount += 1;
        lastDatasetId = datasetId;
      } catch (err) {
        queue[index].state = 'failed';
        queue[index].message = err && err.message ? err.message : 'Upload failed';
        updateProgress(index);
        failedCount += 1;
      }
    }

    uploading = false;
    ui.setButtonLoading(uploadBtn, false);

    if (failedCount === 0 && successCount > 0) {
      ui.toast(successCount + ' dataset' + (successCount === 1 ? '' : 's') + ' uploaded', 'success');
      const area = document.getElementById('datasets-upload-area');
      if (area) area.style.display = 'none';
      const input = document.getElementById('datasets-file');
      if (input) input.value = '';
      if (nameInput) nameInput.value = '';
      queue = [];
      renderQueue();
      const progress = document.getElementById('datasets-progress');
      if (progress) progress.innerHTML = '';
    } else if (successCount > 0) {
      queue = queue.filter(item => item.state !== 'done');
      renderQueue();
      renderProgress();
      ui.toast(successCount + ' uploaded, ' + failedCount + ' failed — fix or retry below.', 'warning');
    } else {
      renderQueue();
      ui.toast('Upload failed — see the progress list for details.', 'error');
    }

    // Refresh from the backend so file metadata and status are authoritative.
    await loadDatasets();
    notifyDatasetsChanged(lastDatasetId);
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
    input.accept = formats().map(ext => '.' + ext).join(',');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const invalid = validateFile(file);
      if (invalid) {
        ui.toast(invalid, 'error');
        return;
      }
      ui.toast('Uploading ' + file.name + '…', 'info', 1500);
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
    const dataset = state.getDataset(id);
    if (!dataset) return;
    ui.toast('Loading preview…', 'info', 1200);
    try {
      const token = await state.getAccessToken();
      const preview = await window.CORPUS_API.previewDataset(id, token);
      const body = esc(preview.preview || '').replace(/\n/g, '<br>');
      const meta = [
        preview.file_name ? 'File: ' + esc(preview.file_name) : null,
        preview.file_size ? 'Size: ' + esc(CORPUS_UTILS.formatBytes(preview.file_size)) : null,
        'Characters: ' + CORPUS_UTILS.formatNumber(preview.total_characters || 0),
        'Lines: ' + CORPUS_UTILS.formatNumber(preview.total_lines || 0),
        preview.truncated ? 'Showing the first ' + CORPUS_UTILS.formatNumber((preview.preview || '').length) + ' characters' : null,
      ].filter(Boolean).join(' · ');
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: dataset.name || 'Dataset preview',
          html: '<p style="font-size:0.78rem;color:#a6a1b3;margin-bottom:0.75rem;">' + meta + '</p>' +
            '<pre style="text-align:left;white-space:pre-wrap;word-break:break-word;max-height:55vh;overflow:auto;background:#131217;color:#e6e1e5;padding:1rem;border-radius:0.5rem;font-size:0.78rem;line-height:1.6;">' + body + '</pre>',
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
    const dataset = state.getDataset(id);
    if (!dataset) return;
    if (!dataset.has_file) {
      ui.toast('Upload a file for this dataset before training on it.', 'error');
      return;
    }
    if (state.setPendingDatasetId) state.setPendingDatasetId(id);
    ui.toast('Dataset selected: ' + (dataset.name || 'Unnamed'), 'info');
    router.navigate('training');
  }

  async function deleteDataset(id) {
    const dataset = state.getDataset(id);
    const label = dataset ? '"' + (dataset.name || dataset.id) + '"' : 'this dataset';
    ui.confirm('Delete dataset', 'Permanently delete ' + label + ' and its stored file? This cannot be undone.', async () => {
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

  return {
    render,
    showUpload,
    handleUpload,
    uploadFileFor,
    previewDataset,
    useDataset,
    deleteDataset,
    loadDatasets,
    setSearch,
    removeQueued,
    clearSelection,
  };
})();
