/* ========================================
   CORPUS ULTIMATE — Training Center

   Structure: A) model & dataset, B) training configuration (advanced
   settings collapsible), C) resource estimate, D) training controls,
   E) live monitor. All progress/metric values come from the backend; when
   nothing has been reported the UI says so instead of drawing fake curves.
   ======================================== */

window.training = (function () {
  'use strict';

  let chartInstances = {};
  let wsJobId = null;
  let activeSocket = null;
  let pollTimer = null;
  let pollJob = null;
  let seenSteps = new Set();
  let metricSeries = { steps: [], loss: [], throughput: [] };

  // Datasets/models fetched from the backend for this page (never invented).
  let datasetsCache = [];
  let modelsCache = [];
  let datasetsError = null;
  let listRefreshBound = false;
  let startInFlight = false;
  let checkpointsCache = [];
  let checkpointsModelId = null;
  let reportedFailureJobId = null;

  const DATASET_UNUSABLE_STATUSES = ['failed', 'deleted'];
  const ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'paused', 'stopping'];

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Please sign in to configure and run training jobs.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    // Reset any stream/series state from a previous visit to this page.
    dispose();
    wsJobId = null;
    metricSeries = { steps: [], loss: [], throughput: [] };
    seenSteps = new Set();
    checkpointsCache = [];
    checkpointsModelId = null;
    reportedFailureJobId = null;

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-flask"></i> Training center</span>
          <h1 class="section-title">Train a model</h1>
          <p class="section-subtitle">Pick a model and one of your uploaded datasets, tune the configuration, then start a real backend job.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="training.loadJobs()">
            <i class="fas fa-rotate"></i> Refresh jobs
          </button>
        </div>
      </div>

      <div class="training-controls">
        <!-- A. Model & dataset -->
        <section class="training-panel" aria-labelledby="t-panel-a">
          <div class="training-panel-header">
            <div class="training-panel-title">
              <span class="step-badge">A</span>
              <h3 id="t-panel-a">Model &amp; dataset</h3>
            </div>
            <button class="btn btn-ghost btn-sm" id="t-refresh-datasets" type="button" onclick="training.refreshDatasets()" title="Reload your datasets from the backend">
              <i class="fas fa-rotate"></i> Refresh
            </button>
          </div>

          <div class="input-field">
            <label for="t-model">Model</label>
            <select id="t-model" onchange="training.onModelChange()">
              <option value="">Loading models…</option>
            </select>
            <span class="field-hint">Only models owned by your account are listed.</span>
          </div>

          <div class="input-field">
            <label for="t-dataset">Dataset</label>
            <select id="t-dataset" disabled>
              <option value="">Loading datasets…</option>
            </select>
            <span class="field-hint" id="t-dataset-hint">Fetching your uploaded datasets…</span>
          </div>

          <div id="t-dataset-info" class="dataset-selection"></div>

          <p class="dataset-manage-link">
            <a href="#/datasets" onclick="training.openDatasetManager(event)"><i class="fas fa-database"></i> Manage datasets &amp; uploads</a>
          </p>
        </section>

        <!-- B. Training configuration -->
        <section class="training-panel" aria-labelledby="t-panel-b">
          <div class="training-panel-header">
            <div class="training-panel-title">
              <span class="step-badge">B</span>
              <h3 id="t-panel-b">Training configuration</h3>
            </div>
          </div>

          <div class="form-grid">
            <div class="input-field">
              <label for="t-engine">Engine</label>
              <select id="t-engine" onchange="training.updateEstimate()">
                <option value="pytorch">PyTorch (torch.nn)</option>
                <option value="numerical">Custom numerical</option>
              </select>
            </div>
            <div class="input-field">
              <label for="t-compute">Compute</label>
              <select id="t-compute" onchange="training.updateEstimate()">
                <option value="local">Local (this device)</option>
                <option value="cloud">Cloud worker</option>
              </select>
            </div>
            <div class="input-field">
              <label for="t-batch">Batch size</label>
              <input type="number" id="t-batch" value="16" min="1" step="1" inputmode="numeric">
            </div>
            <div class="input-field">
              <label for="t-lr">Learning rate</label>
              <input type="number" id="t-lr" value="0.001" step="0.0001" min="0" inputmode="decimal">
            </div>
            <div class="input-field">
              <label for="t-epochs">Epochs</label>
              <input type="number" id="t-epochs" value="10" min="1" step="1" inputmode="numeric">
            </div>
          </div>

          <details class="accordion" style="margin-top:var(--space-3);">
            <summary>Advanced settings</summary>
            <div class="accordion-body">
              <div class="form-grid">
                <div class="input-field">
                  <label for="t-accum">Gradient accumulation</label>
                  <input type="number" id="t-accum" value="1" min="1" step="1" inputmode="numeric">
                  <span class="field-hint">Micro-batches per optimiser step.</span>
                </div>
                <div class="input-field">
                  <label for="t-clip">Gradient clipping</label>
                  <input type="number" id="t-clip" value="1.0" step="0.1" min="0" inputmode="decimal">
                  <span class="field-hint">Max gradient norm.</span>
                </div>
                <div class="input-field">
                  <label for="t-seed">Random seed</label>
                  <input type="number" id="t-seed" value="42" min="0" step="1" inputmode="numeric">
                  <span class="field-hint">Reproducibility seed.</span>
                </div>
              </div>
              <p class="field-hint">The backend may clamp large values so jobs stay within CPU limits.</p>
            </div>
          </details>

          <p class="field-hint">Defaults come from your CORPUS configuration. Only values supported by the backend API are sent.</p>
        </section>

        <!-- C. Resource estimate -->
        <section class="training-panel" aria-labelledby="t-panel-c">
          <div class="training-panel-header">
            <div class="training-panel-title">
              <span class="step-badge">C</span>
              <h3 id="t-panel-c">Resource estimate</h3>
            </div>
          </div>
          <div id="t-estimate">
            <p class="field-hint" id="t-estimate-text">Select a model and a dataset to see the estimate.</p>
          </div>
        </section>
      </div>

      <!-- D. Training controls -->
      <section class="training-panel" aria-labelledby="t-panel-d" style="margin-bottom:var(--space-4);">
        <div class="training-panel-header">
          <div class="training-panel-title">
            <span class="step-badge">D</span>
            <h3 id="t-panel-d">Training controls</h3>
          </div>
          <span class="field-hint">Start is disabled until a model and a dataset with an uploaded file are selected.</span>
        </div>

        <div id="t-form-error" class="form-alert error hidden" role="alert"></div>

        <div class="training-actions">
          <button class="btn btn-primary" id="t-start" type="button" onclick="training.startTraining()" disabled>
            <i class="fas fa-play"></i> Start training
          </button>
          <button class="btn btn-outline" id="t-pause" type="button" onclick="training.pauseTraining()" disabled>
            <i class="fas fa-pause"></i> Pause
          </button>
          <button class="btn btn-outline" id="t-resume" type="button" onclick="training.resumeTraining()" disabled>
            <i class="fas fa-play"></i> Resume
          </button>
          <button class="btn btn-danger" id="t-stop" type="button" onclick="training.stopTraining()" disabled>
            <i class="fas fa-stop"></i> Stop
          </button>
        </div>
      </section>

      <!-- E. Live monitor -->
      <section class="training-panel" aria-labelledby="t-panel-e">
        <div class="training-panel-header">
          <div class="training-panel-title">
            <span class="step-badge">E</span>
            <h3 id="t-panel-e">Live monitor</h3>
          </div>
          <span class="field-hint">Streams real status and metrics from the training WebSocket.</span>
        </div>

        <div class="monitor-status" id="t-monitor-status">
          <span class="status-badge cancelled"><i class="fas fa-circle"></i> Idle</span>
          <span class="field-hint" style="margin:0;">No job running. Start a job to stream progress here.</span>
        </div>

        <div class="metric-strip" id="t-metrics">
          <div class="metric-tile"><div class="metric-value" id="t-metric-step">—</div><div class="metric-label">Latest step</div></div>
          <div class="metric-tile"><div class="metric-value" id="t-metric-loss">—</div><div class="metric-label">Loss</div></div>
          <div class="metric-tile"><div class="metric-value" id="t-metric-tps">—</div><div class="metric-label">Tokens / sec</div></div>
          <div class="metric-tile"><div class="metric-value" id="t-metric-progress">—</div><div class="metric-label">Job completion</div></div>
        </div>

        <div class="training-charts" id="training-charts">
          <!-- live charts -->
        </div>

        <div class="training-logs">
          <div class="training-panel-header" style="margin-bottom:var(--space-2);">
            <h3 style="margin:0; font-size:var(--text-body-medium); color:var(--color-text);">Training log</h3>
            <button class="btn btn-ghost btn-sm" type="button" onclick="training.clearLog()">
              <i class="fas fa-eraser"></i> Clear
            </button>
          </div>
          <div class="log-panel" id="t-logs" aria-live="polite">
            <div class="log-entry info"><span class="log-time">[system]</span> Ready to train.</div>
          </div>
        </div>

        <div class="grid-2" style="margin-top:var(--space-4);">
          <div>
            <h3 style="font-size:var(--text-body-medium); margin-bottom:var(--space-2);">Recent training jobs</h3>
            <div id="t-jobs" class="training-jobs">
              <div class="skeleton skeleton-block"></div>
            </div>
          </div>
          <div>
            <h3 style="font-size:var(--text-body-medium); margin-bottom:var(--space-2);">Checkpoints</h3>
            <div id="t-checkpoints">
              <p class="field-hint" style="margin:0;">Checkpoints appear after a training run saves one.</p>
            </div>
          </div>
        </div>
      </section>
    `;

    // Live-refresh the dataset selector whenever a dataset is uploaded/deleted.
    bindDatasetRefreshListener();

    const datasetSelect = document.getElementById('t-dataset');
    if (datasetSelect) datasetSelect.addEventListener('change', onDatasetChange);

    renderCharts();
    await Promise.all([loadModels(), refreshDatasets(), loadJobs()]);

    const pendingId = state.getPendingDatasetId ? state.getPendingDatasetId() : null;
    if (pendingId) applySelectedDataset(pendingId);

    const activeModel = state.getActiveModel();
    if (activeModel) {
      const modelSelect = document.getElementById('t-model');
      if (modelSelect && modelsCache.some(m => m.id === activeModel.id)) {
        modelSelect.value = activeModel.id;
        onModelChange();
      }
    }

    updateEstimate();
  }

  function escapeHtml(text) {
    return ui.escapeHtml(text == null ? '' : String(text));
  }

  function log(message, type) {
    const panel = document.getElementById('t-logs');
    if (!panel) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + (type || 'info');
    entry.innerHTML = '<span class="log-time">[' + time + ']</span><span>' + escapeHtml(message) + '</span>';
    const keepPinnedToBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
    panel.appendChild(entry);
    // Bound the live DOM log to prevent long sessions from accumulating
    // thousands of nodes and forcing repeated layout work on mobile browsers.
    while (panel.children.length > 200) panel.removeChild(panel.firstElementChild);
    if (keepPinnedToBottom) panel.scrollTop = panel.scrollHeight;
  }

  function clearLog() {
    const panel = document.getElementById('t-logs');
    if (!panel) return;
    panel.innerHTML = '<div class="log-entry info"><span class="log-time">[system]</span><span>Log cleared.</span></div>';
  }

  /* ---------------- Datasets ---------------- */

  function normalizeList(data, key) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data[key])) return data[key];
    return [];
  }

  function isDatasetUsable(dataset) {
    if (!dataset) return false;
    if (DATASET_UNUSABLE_STATUSES.indexOf(dataset.status) !== -1) return false;
    // The backend reports has_file from dataset_files; fall back to status for
    // responses produced before file metadata was exposed.
    if (typeof dataset.has_file === 'boolean') return dataset.has_file;
    return dataset.status === 'uploaded';
  }

  function datasetLabel(dataset) {
    const parts = [dataset.name || 'Unnamed dataset'];
    parts.push(dataset.file_name || 'no file');
    if (dataset.size || dataset.file_size) {
      parts.push(CORPUS_UTILS.formatBytes(dataset.file_size || dataset.size));
    }
    parts.push(dataset.status || 'unknown');
    return parts.join('  ·  ');
  }

  async function loadModels() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listModels(token);
      modelsCache = normalizeList(data, 'models');
      state.setModels(modelsCache);
    } catch (err) {
      modelsCache = [];
      state.setModels([]);
      log('Could not load models: ' + (err.message || 'unknown error'), 'error');
    }
    populateModelSelect();
  }

  function populateModelSelect() {
    const select = document.getElementById('t-model');
    if (!select) return;
    const previous = select.value;
    if (modelsCache.length === 0) {
      select.innerHTML = '<option value="">No models available — create one first</option>';
      return;
    }
    select.innerHTML = '<option value="">Select a model</option>' + modelsCache
      .map(m => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name || 'Unnamed') +
        (m.status && m.status !== 'idle' ? ' (' + escapeHtml(m.status) + ')' : '') + '</option>')
      .join('');
    if (previous && modelsCache.some(m => m.id === previous)) select.value = previous;
  }

  async function refreshDatasets() {
    const select = document.getElementById('t-dataset');
    const hint = document.getElementById('t-dataset-hint');
    const token = await state.getAccessToken();
    try {
      const data = await window.CORPUS_API.listDatasets(token);
      datasetsCache = window.CORPUS_API.asDatasetList
        ? window.CORPUS_API.asDatasetList(data)
        : normalizeList(data, 'datasets');
      state.setDatasets(datasetsCache);
      datasetsError = null;
    } catch (err) {
      datasetsCache = [];
      state.setDatasets([]);
      datasetsError = err && err.message ? err.message : 'Could not load datasets';
      log('Could not load datasets: ' + datasetsError, 'error');
    }
    if (select) populateDatasetSelect();
    if (hint && !select) {
      hint.textContent = datasetsCache.length === 0 && !datasetsError
        ? 'No datasets yet. Upload one in Dataset Manager to enable training.'
        : hint.textContent;
    }
  }

  function populateDatasetSelect() {
    const select = document.getElementById('t-dataset');
    const hint = document.getElementById('t-dataset-hint');
    if (!select) return;
    const previous = select.value;
    const pendingId = state.getPendingDatasetId ? state.getPendingDatasetId() : null;

    if (datasetsCache.length === 0) {
      select.innerHTML = '<option value="">No datasets available</option>';
      select.disabled = true;
      if (hint) {
        hint.textContent = datasetsError
          ? 'Datasets could not be loaded: ' + datasetsError
          : 'No datasets yet. Upload one in Dataset Manager to enable training.';
      }
    } else {
      const usableCount = datasetsCache.filter(isDatasetUsable).length;
      select.disabled = usableCount === 0;
      select.innerHTML = '<option value="">Select a dataset</option>' + datasetsCache.map(d => {
        const usable = isDatasetUsable(d);
        const suffix = usable ? '' : ' — upload required';
        return '<option value="' + escapeHtml(d.id) + '"' + (usable ? '' : ' disabled') + '>' +
          escapeHtml(datasetLabel(d)) + escapeHtml(suffix) + '</option>';
      }).join('');
      if (hint) {
        hint.textContent = usableCount === 0
          ? 'None of your datasets has an uploaded file yet. Upload a file in Dataset Manager first.'
          : usableCount + ' of ' + datasetsCache.length + ' dataset(s) ready for training.';
      }
    }

    const restore = [previous, pendingId].filter(Boolean).find(id =>
      datasetsCache.some(d => d.id === id && isDatasetUsable(d))
    );
    if (restore) {
      select.value = restore;
      if (state.setPendingDatasetId) state.setPendingDatasetId(null);
    } else {
      select.value = '';
    }
    updateDatasetInfo();
    updateStartButtonState();
    updateEstimate();
  }

  function selectedDataset() {
    const select = document.getElementById('t-dataset');
    if (!select || !select.value) return null;
    return datasetsCache.find(d => d.id === select.value) || null;
  }

  function applySelectedDataset(datasetId) {
    const select = document.getElementById('t-dataset');
    if (!select) return;
    if (datasetsCache.some(d => d.id === datasetId && isDatasetUsable(d))) {
      select.value = datasetId;
      if (state.setPendingDatasetId) state.setPendingDatasetId(null);
    }
    onDatasetChange();
  }

  function onDatasetChange() {
    const dataset = selectedDataset();
    if (dataset && state.setPendingDatasetId) state.setPendingDatasetId(dataset.id);
    clearFormError();
    updateDatasetInfo();
    updateStartButtonState();
    updateEstimate();
  }

  function updateDatasetInfo() {
    const panel = document.getElementById('t-dataset-info');
    if (!panel) return;
    const dataset = selectedDataset();
    if (!dataset) {
      const usable = datasetsCache.filter(isDatasetUsable);
      panel.innerHTML = usable.length > 0
        ? '<p class="field-hint">Select a dataset to train on. ' + usable.length + ' dataset(s) ready.</p>'
        : '<p class="field-hint">No trainable dataset selected. Upload a file in <a href="#/datasets" onclick="training.openDatasetManager(event)">Dataset Manager</a> first.</p>';
      return;
    }
    const status = dataset.status || 'unknown';
    panel.innerHTML = `
      <div class="dataset-selection-card">
        <div class="dataset-selection-head">
          <span class="dataset-selection-name"><i class="fas fa-database"></i> ${escapeHtml(dataset.name || 'Unnamed dataset')}</span>
          <span class="status-badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
        </div>
        <dl class="dataset-selection-grid">
          <div><dt>File</dt><dd>${escapeHtml(dataset.file_name || '—')}</dd></div>
          <div><dt>Size</dt><dd>${dataset.file_size || dataset.size ? escapeHtml(CORPUS_UTILS.formatBytes(dataset.file_size || dataset.size)) : '—'}</dd></div>
          <div><dt>Uploaded</dt><dd>${escapeHtml(dataset.uploaded_at ? CORPUS_UTILS.formatDate(dataset.uploaded_at) : '—')}</dd></div>
          <div><dt>Tokens seen</dt><dd>${escapeHtml(CORPUS_UTILS.formatNumber(dataset.token_count || 0))}</dd></div>
          <div><dt>Dataset ID</dt><dd class="mono">${escapeHtml(dataset.id)}</dd></div>
        </dl>
      </div>
    `;
  }

  function updateStartButtonState() {
    const btn = document.getElementById('t-start');
    if (!btn) return;
    const modelId = document.getElementById('t-model') ? document.getElementById('t-model').value : '';
    const dataset = selectedDataset();
    const activeJob = wsJobId ? state.getTrainingJob(wsJobId) : null;
    const jobActive = !!(activeJob && ACTIVE_STATUSES.indexOf(activeJob.status) !== -1);
    btn.disabled = startInFlight || !modelId || !dataset || !isDatasetUsable(dataset) || jobActive;
  }

  function validateSelection() {
    const modelSelect = document.getElementById('t-model');
    const modelId = modelSelect ? modelSelect.value : '';
    if (!modelId) {
      return { ok: false, message: 'Select a model before starting training.' };
    }
    const select = document.getElementById('t-dataset');
    const datasetId = select ? select.value : '';
    if (!datasetId) {
      return { ok: false, message: 'Select a dataset before starting training.' };
    }
    const dataset = datasetsCache.find(d => d.id === datasetId);
    if (!dataset) {
      return { ok: false, message: 'The selected dataset is no longer available. Refresh the dataset list and try again.' };
    }
    if (DATASET_UNUSABLE_STATUSES.indexOf(dataset.status) !== -1) {
      return { ok: false, message: 'Dataset "' + (dataset.name || dataset.id) + '" is ' + dataset.status + ' and cannot be used for training.' };
    }
    if (!isDatasetUsable(dataset)) {
      return { ok: false, message: 'Dataset "' + (dataset.name || dataset.id) + '" has no uploaded file. Upload it in Dataset Manager first.' };
    }
    return { ok: true, dataset: dataset, modelId: modelId };
  }

  function showFormError(message) {
    const box = document.getElementById('t-form-error');
    if (!box) return;
    box.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>' + escapeHtml(message) + '</span>';
    box.classList.remove('hidden');
  }

  function clearFormError() {
    const box = document.getElementById('t-form-error');
    if (!box) return;
    box.textContent = '';
    box.classList.add('hidden');
  }

  function openDatasetManager(event) {
    if (event) event.preventDefault();
    router.navigate('datasets');
  }

  function bindDatasetRefreshListener() {
    if (listRefreshBound) return;
    listRefreshBound = true;
    window.addEventListener('corpus:datasets-changed', () => {
      // Only refresh when the Training page is actually mounted.
      if (document.getElementById('t-dataset')) {
        refreshDatasets();
      }
    });
  }

  /* ---------------- Models ---------------- */

  async function onModelChange() {
    const select = document.getElementById('t-model');
    const id = select ? select.value : '';
    const model = modelsCache.find(item => item.id === id) || state.getModel(id);
    if (model) state.setActiveModel(model);
    updateEstimate();
    clearFormError();
    updateStartButtonState();
    if (id) {
      await loadCheckpoints(id);
    } else {
      checkpointsCache = [];
      checkpointsModelId = null;
      renderCheckpoints();
    }
  }

  function updateEstimate() {
    const container = document.getElementById('t-estimate');
    if (!container) return;
    const modelSelect = document.getElementById('t-model');
    const modelId = modelSelect ? modelSelect.value : '';
    const model = modelsCache.find(item => item.id === modelId);
    const dataset = selectedDataset();

    if (!model) {
      container.innerHTML = '<p class="field-hint" id="t-estimate-text" style="margin:0;">Select a model and a dataset to see the estimate.</p>';
      return;
    }

    const config = model.config || {};
    const hasArch = ['n_layers', 'n_heads', 'd_model', 'vocab_size', 'context_length', 'd_ff'].some(key => config[key]);
    const params = hasArch ? CORPUS_UTILS.calculateParameters(config) : null;
    const bytes = dataset ? (dataset.file_size || dataset.size || 0) : 0;
    // The real tokenizer runs on the backend; this is a character-based guess.
    const approxTokens = bytes ? Math.max(0, Math.round(bytes / 4)) : null;
    const engineSelect = document.getElementById('t-engine');
    const engine = engineSelect && engineSelect.value === 'numerical' ? 'Custom numerical' : 'PyTorch';
    const computeSelect = document.getElementById('t-compute');
    const compute = computeSelect ? computeSelect.value : 'local';
    const memoryMb = params ? (params * 4) / 1024 / 1024 : null;

    const hardware = [];
    if (typeof navigator !== 'undefined') {
      if (navigator.hardwareConcurrency) hardware.push(navigator.hardwareConcurrency + ' CPU threads');
      if (navigator.deviceMemory) hardware.push(navigator.deviceMemory + ' GB device memory');
    }

    container.innerHTML = `
      <div class="estimate-grid">
        <div class="estimate-item">
          <div class="estimate-label">Parameters</div>
          <div class="estimate-value">${params ? CORPUS_UTILS.formatNumber(params) + ' (computed)' : 'Unknown'}</div>
        </div>
        <div class="estimate-item">
          <div class="estimate-label">Dataset size</div>
          <div class="estimate-value">${bytes ? escapeHtml(CORPUS_UTILS.formatBytes(bytes)) : 'Not selected'}</div>
        </div>
        <div class="estimate-item">
          <div class="estimate-label">Tokens (estimate)</div>
          <div class="estimate-value estimate">${approxTokens != null ? '~' + CORPUS_UTILS.formatNumber(approxTokens) : '—'}</div>
        </div>
        <div class="estimate-item">
          <div class="estimate-label">Weights memory (FP32)</div>
          <div class="estimate-value estimate">${memoryMb != null ? '~' + memoryMb.toFixed(1) + ' MB' : '—'}</div>
        </div>
        <div class="estimate-item">
          <div class="estimate-label">Engine</div>
          <div class="estimate-value">${escapeHtml(engine)}</div>
        </div>
        <div class="estimate-item">
          <div class="estimate-label">Compute</div>
          <div class="estimate-value">${escapeHtml(compute === 'cloud' ? 'Cloud worker' : 'Local device')}</div>
        </div>
      </div>
      <p class="estimate-note" id="t-estimate-text" style="margin-bottom:var(--space-2);">
        Parameter count and memory are computed from the stored architecture (weights only — optimizer state,
        activations and the tokenizer are not included). Token count is an estimate from file size; the backend
        tokenizer is authoritative. ${hardware.length ? 'Hardware reported by this browser: ' + escapeHtml(hardware.join(', ')) + '.' : 'This browser does not report hardware details.'}
      </p>
      <p class="estimate-note">${dataset ? 'Training on <strong>' + escapeHtml(dataset.name || dataset.id) + '</strong>.' : 'No dataset selected yet.'}</p>
    `;
  }

  /* ---------------- Jobs ---------------- */

  async function loadJobs() {
    let token;
    try {
      token = await state.getAccessToken();
      const data = await window.CORPUS_API.listTrainingJobs(token);
      state.setTrainingJobs(normalizeList(data, 'jobs'));
    } catch (err) {
      state.setTrainingJobs([]);
      log('Could not load training jobs: ' + (err.message || 'unknown error'), 'error');
      renderJobList();
      return;
    }

    renderJobList();
    const jobs = state.getTrainingJobs() || [];
    if (!jobs.length) {
      wsJobId = null;
      metricSeries = { steps: [], loss: [], throughput: [] };
      seenSteps = new Set();
      updateMetricTiles();
      updateCharts();
      updateMonitorStatus(null);
      return;
    }

    // Restore the newest real backend job on page load. This makes completed
    // runs inspectable after navigation/reload instead of showing a misleading
    // Idle monitor with empty charts.
    const selected = jobs.find(item => item.id === wsJobId) || jobs[0];
    const changedJob = wsJobId !== selected.id;
    wsJobId = selected.id;
    if (changedJob) {
      metricSeries = { steps: [], loss: [], throughput: [] };
      seenSteps = new Set();
      updateMetricTiles();
      updateCharts();
    }

    updateMonitorStatus(selected);
    updateControls(selected);
    await refreshJob(selected.id, true);

    if (window.CORPUS_API.listTrainingLogs) {
      try {
        const events = await window.CORPUS_API.listTrainingLogs(selected.id, token);
        (events || []).forEach(entry => {
          if (!entry || !entry.event) return;
          if (entry.event === 'started') {
            log('Worker started training from the selected stored dataset.', 'info');
          } else if (entry.event === 'completed') {
            log('Training completed and checkpoint saved.', 'success');
          } else if (entry.event === 'failed') {
            reportJobFailure(selected.id, entry.data && entry.data.error);
          }
        });
      } catch (err) {
        log('Could not restore training event history: ' + (err.message || 'unknown error'), 'warn');
      }
    }

    if (selected.model_id) await loadCheckpoints(selected.model_id);
    const latest = state.getTrainingJob(selected.id) || selected;
    if (isActiveStatus(latest.status) && !startInFlight) {
      connectJobStream(selected.id);
    }
  }

  function renderJobList() {
    const container = document.getElementById('t-jobs');
    if (!container) return;
    const jobs = state.getTrainingJobs() || [];
    if (jobs.length === 0) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-hourglass-half',
        title: 'No training jobs yet',
        text: 'Jobs you start appear here with their real backend status.',
        compact: true,
      });
      return;
    }
    container.innerHTML = jobs.slice(0, 8).map(job => {
      const datasetName = (datasetsCache.find(d => d.id === job.dataset_id) || {}).name;
      const modelName = (modelsCache.find(m => m.id === job.model_id) || {}).name;
      return `
        <div class="job-row">
          <div class="job-row-main">
            ${ui.statusBadge(job.status || 'queued')}
            <span class="job-row-id mono">${escapeHtml(job.id)}</span>
          </div>
          <div class="job-row-meta">
            <span><i class="fas fa-cube"></i> ${escapeHtml(modelName || job.model_id || '—')}</span>
            <span><i class="fas fa-database"></i> ${escapeHtml(datasetName || job.dataset_id || 'no dataset')}</span>
            <span><i class="fas fa-clock"></i> ${escapeHtml(CORPUS_UTILS.formatDate(job.created_at))}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  async function loadCheckpoints(modelId) {
    const container = document.getElementById('t-checkpoints');
    if (!container) return;
    if (checkpointsModelId === modelId && checkpointsCache.length) {
      renderCheckpoints();
      return;
    }
    container.innerHTML = '<div class="skeleton skeleton-block"></div>';
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listCheckpoints(modelId, token);
      checkpointsCache = Array.isArray(data) ? data : (data && Array.isArray(data.checkpoints) ? data.checkpoints : []);
      checkpointsModelId = modelId;
    } catch (err) {
      checkpointsCache = [];
      checkpointsModelId = modelId;
    }
    renderCheckpoints();
  }

  function renderCheckpoints() {
    const container = document.getElementById('t-checkpoints');
    if (!container) return;
    if (!checkpointsCache.length) {
      container.innerHTML = '<p class="field-hint" style="margin:0;">No checkpoints stored for this model yet. They are written when a training run finishes.</p>';
      return;
    }
    const sorted = checkpointsCache.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    container.innerHTML = sorted.slice(0, 5).map(ckpt => `
      <div class="job-row" style="margin-bottom:var(--space-2);">
        <div class="job-row-main">
          <span class="chip accent"><i class="fas fa-save"></i> ${escapeHtml(ckpt.id)}</span>
          ${ckpt.loss != null ? '<span class="mono">loss ' + Number(ckpt.loss).toFixed(4) + '</span>' : ''}
        </div>
        <div class="job-row-meta">
          <span><i class="fas fa-step-forward"></i> step ${escapeHtml(ckpt.step != null ? ckpt.step : '—')}</span>
          <span><i class="fas fa-clock"></i> ${escapeHtml(CORPUS_UTILS.formatDate(ckpt.created_at))}</span>
        </div>
      </div>
    `).join('');
  }

  function readConfig() {
    const intField = (id, fallback, min) => {
      const el = document.getElementById(id);
      const value = el ? parseInt(el.value, 10) : NaN;
      return Number.isFinite(value) && value >= (min == null ? 0 : min) ? value : fallback;
    };
    const floatField = (id, fallback, min) => {
      const el = document.getElementById(id);
      const value = el ? parseFloat(el.value) : NaN;
      return Number.isFinite(value) && value >= (min == null ? 0 : min) ? value : fallback;
    };
    return {
      engine: document.getElementById('t-engine') ? document.getElementById('t-engine').value : 'pytorch',
      compute: document.getElementById('t-compute') ? document.getElementById('t-compute').value : 'local',
      batch_size: intField('t-batch', 16, 1),
      learning_rate: floatField('t-lr', 0.001, 0),
      epochs: intField('t-epochs', 10, 1),
      gradient_accumulation_steps: intField('t-accum', 1, 1),
      gradient_clip: floatField('t-clip', 1.0, 0),
      seed: intField('t-seed', 42, 0),
    };
  }

  async function startTraining() {
    if (startInFlight) return;
    const check = validateSelection();
    if (!check.ok) {
      showFormError(check.message);
      ui.toast(check.message, 'error');
      log('Cannot start training: ' + check.message, 'error');
      return;
    }
    clearFormError();

    const dataset = check.dataset;
    const config = Object.assign({ model_id: check.modelId, dataset_id: dataset.id }, readConfig());

    const startBtn = document.getElementById('t-start');
    startInFlight = true;
    ui.setButtonLoading(startBtn, true);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createTrainingJob(config, token);
      const job = data && data.job ? data.job : data;
      if (!job || !job.id) {
        throw new Error('The backend did not return a training job.');
      }
      state.addTrainingJob(job);
      state.setActiveJob(job);
      wsJobId = job.id;
      reportedFailureJobId = null;
      seenSteps = new Set();
      metricSeries = { steps: [], loss: [], throughput: [] };
      ui.toast('Training job queued', 'success');
      log('Job ' + job.id + ' created — status: ' + job.status);
      log('Dataset: ' + (dataset.name || dataset.id) + ' (' + dataset.id + ')');
      updateControls(job);
      updateMonitorStatus(job);
      await loadJobs();
      connectJobStream(job.id);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to start training';
      showFormError(message);
      ui.toast(message, 'error');
      log('Error: ' + message, 'error');
    } finally {
      startInFlight = false;
      ui.setButtonLoading(startBtn, false);
      updateStartButtonState();
      updateControls(state.getTrainingJob(wsJobId) || null);
    }
  }

  async function runControl(btnId, action, label) {
    const jobId = wsJobId;
    if (!jobId) return;
    const btn = document.getElementById(btnId);
    ui.setButtonLoading(btn, true);
    try {
      const token = await state.getAccessToken();
      const response = await action(jobId, token);
      if (response && response.status) {
        const current = state.getTrainingJob(jobId) || { id: jobId };
        state.updateTrainingJob(jobId, { ...current, status: response.status });
        const updated = state.getTrainingJob(jobId) || { ...current, status: response.status };
        updateControls(updated);
        updateMonitorStatus(updated);
        updateMetricTiles();
      }
      log(label + ' signal accepted for job ' + jobId +
        (response && response.status ? ' — status: ' + response.status : ''));
    } catch (err) {
      ui.toast(err.message || (label + ' failed'), 'error');
      log(label + ' failed: ' + (err.message || 'unknown error'), 'error');
    } finally {
      ui.setButtonLoading(btn, false);
      updateControls(state.getTrainingJob(jobId) || null);
    }
  }

  function pauseTraining() {
    return runControl('t-pause', window.CORPUS_API.pauseTrainingJob, 'Pause');
  }

  function resumeTraining() {
    return runControl('t-resume', window.CORPUS_API.resumeTrainingJob, 'Resume');
  }

  function stopTraining() {
    if (!wsJobId) return;
    ui.confirm('Stop training', 'Stop this training job? The worker saves a checkpoint before it exits.', async () => {
      const btn = document.getElementById('t-stop');
      ui.setButtonLoading(btn, true);
      try {
        const jobId = wsJobId;
        const token = await state.getAccessToken();
        const response = await window.CORPUS_API.stopTrainingJob(jobId, token);
        if (response && response.status) {
          const current = state.getTrainingJob(jobId) || { id: jobId };
          state.updateTrainingJob(jobId, { ...current, status: response.status });
          const updated = state.getTrainingJob(jobId) || { ...current, status: response.status };
          updateControls(updated);
          updateMonitorStatus(updated);
          updateMetricTiles();
        }
        log('Stop signal accepted for job ' + jobId +
          (response && response.status ? ' — status: ' + response.status : ''));
      } catch (err) {
        ui.toast(err.message || 'Stop failed', 'error');
      } finally {
        ui.setButtonLoading(btn, false);
        updateControls(state.getTrainingJob(wsJobId) || null);
      }
    });
  }

  function isActiveStatus(status) {
    return ACTIVE_STATUSES.indexOf(status) !== -1;
  }

  function updateControls(job) {
    const status = job ? job.status : null;
    const startEl = document.getElementById('t-start');
    const pauseEl = document.getElementById('t-pause');
    const resumeEl = document.getElementById('t-resume');
    const stopEl = document.getElementById('t-stop');
    if (!startEl) return;
    const active = isActiveStatus(status);
    startEl.disabled = startInFlight || active || !validateSelection().ok;
    if (pauseEl) pauseEl.disabled = status !== 'running';
    if (resumeEl) resumeEl.disabled = !(status === 'paused' || status === 'pausing');
    if (stopEl) stopEl.disabled = !(status === 'running' || status === 'paused' || status === 'queued' || status === 'pausing');
  }

  function updateMonitorStatus(job) {
    const container = document.getElementById('t-monitor-status');
    if (!container) return;
    if (!job) {
      container.innerHTML = '<span class="status-badge cancelled"><i class="fas fa-circle"></i> Idle</span>' +
        '<span class="field-hint" style="margin:0;">No job running. Start a job to stream progress here.</span>';
      return;
    }
    const dataset = datasetsCache.find(d => d.id === job.dataset_id);
    const model = modelsCache.find(m => m.id === job.model_id);
    container.innerHTML = `
      ${ui.statusBadge(job.status || 'queued')}
      <span class="mono">${escapeHtml(job.id)}</span>
      <span class="field-hint" style="margin:0; min-width:0;">
        ${escapeHtml(model ? (model.name || model.id) : (job.model_id || 'model'))}
        ${dataset ? ' · ' + escapeHtml(dataset.name || dataset.id) : ''}
      </span>
    `;
  }

  function reportJobFailure(jobId, message) {
    const text = message || 'Training job failed.';
    if (reportedFailureJobId !== jobId) {
      reportedFailureJobId = jobId;
      log('Job ' + jobId + ' failed: ' + text, 'error');
      showFormError(text);
      ui.toast(text, 'error');
    }
  }

  function extractStreamError(err) {
    if (!err) return 'unknown';
    if (typeof err === 'string') return err;
    if (err.data && typeof err.data.error === 'string' && err.data.error) return err.data.error;
    if (err.message) return err.message;
    if (err.detail) return err.detail;
    return 'unknown';
  }

  function connectJobStream(jobId) {
    disconnectJobStream();
    startPolling(jobId);
    window.CORPUS_API.connectTrainingWS(jobId, {
      onMetric: (metric) => applyMetric(metric),
      onStatus: (payload) => applyStatus(jobId, payload),
      onComplete: (payload) => {
        log('Job ' + jobId + ' finished: ' + ((payload && payload.status) || 'completed'), 'success');
        refreshJob(jobId);
      },
      onError: (err) => {
        const message = extractStreamError(err);
        if (err && err.status === 'failed') {
          applyStatus(jobId, err);
          reportJobFailure(jobId, message);
          return;
        }
        log('Live stream error: ' + message, 'error');
        if (isActiveStatus((state.getTrainingJob(jobId) || {}).status)) startPolling(jobId);
      },
      onClose: () => {
        if (isActiveStatus((state.getTrainingJob(jobId) || {}).status)) startPolling(jobId);
      },
    }).then((socket) => {
      activeSocket = socket;
      if (!socket) {
        log('Live progress stream unavailable — using periodic refresh instead.', 'warn');
        startPolling(jobId);
        return;
      }
      // Keep the polling fallback only until the WebSocket is actually open.
      // This avoids polling the same job while its live stream is healthy.
      if (socket.readyState === 1) stopPolling();
      else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', () => stopPolling(), { once: true });
        socket.addEventListener('error', () => {
          if (isActiveStatus((state.getTrainingJob(jobId) || {}).status)) startPolling(jobId);
        }, { once: true });
      }
    });
  }

  function disconnectJobStream() {
    if (activeSocket) {
      try { activeSocket.close(); } catch (e) { /* ignore */ }
      activeSocket = null;
    }
  }

  function applyMetric(metric) {
    if (!metric || metric.step == null) return;
    const step = Number(metric.step);
    if (seenSteps.has(step)) return;
    seenSteps.add(step);
    const loss = metric.loss == null ? null : Number(metric.loss);
    const tps = metric.tokens_per_second == null ? null : Number(metric.tokens_per_second);
    if (loss !== null) {
      metricSeries.steps.push(step);
      metricSeries.loss.push(loss);
      metricSeries.throughput.push(tps === null ? null : tps);
      if (metricSeries.steps.length > 200) {
        metricSeries.steps.shift();
        metricSeries.loss.shift();
        metricSeries.throughput.shift();
      }
      log('Step ' + step + ' — loss: ' + loss.toFixed(4) +
        (tps !== null ? ' — ' + Math.round(tps) + ' tok/s' : ''), 'info');
    }
    updateMetricTiles();
    updateCharts();
  }

  function updateMetricTiles() {
    const last = metricSeries.steps.length - 1;
    const stepEl = document.getElementById('t-metric-step');
    const lossEl = document.getElementById('t-metric-loss');
    const tpsEl = document.getElementById('t-metric-tps');
    const progressEl = document.getElementById('t-metric-progress');
    if (!stepEl) return;
    stepEl.textContent = last >= 0 ? String(metricSeries.steps[last]) : '—';
    lossEl.textContent = last >= 0 && metricSeries.loss[last] != null ? metricSeries.loss[last].toFixed(4) : '—';
    tpsEl.textContent = last >= 0 && metricSeries.throughput[last] != null
      ? Math.round(metricSeries.throughput[last]).toLocaleString()
      : '—';
    if (progressEl) {
      const job = wsJobId ? state.getTrainingJob(wsJobId) : null;
      const status = job && job.status ? String(job.status).toLowerCase() : '';
      if (status === 'completed') progressEl.textContent = '100%';
      else if (status === 'failed') progressEl.textContent = 'Failed';
      else if (status === 'stopped' || status === 'cancelled') progressEl.textContent = 'Stopped';
      else if (ACTIVE_STATUSES.indexOf(status) !== -1) progressEl.textContent = 'In progress';
      else if (status === 'queued') progressEl.textContent = 'Queued';
      else progressEl.textContent = '—';
    }
  }

  function applyStatus(jobId, payload) {
    if (!payload) return;
    state.updateTrainingJob(jobId, {
      status: payload.status,
      dataset_id: payload.dataset_id,
      model_id: payload.model_id,
    });
    const job = state.getTrainingJob(jobId) || { id: jobId, status: payload.status };
    updateControls(job);
    updateMonitorStatus(job);
    updateMetricTiles();
    log('Job ' + jobId + ' status: ' + payload.status);
    if (!isActiveStatus(payload.status)) {
      stopPolling();
      disconnectJobStream();
      loadJobs();
      if (job.model_id) loadCheckpoints(job.model_id);
    }
  }

  function startPolling(jobId) {
    stopPolling();
    pollJob = jobId;
    const tickFn = async () => {
      if (pollJob !== jobId) return;
      if (!document.getElementById('t-logs')) { stopPolling(); disconnectJobStream(); return; }
      await refreshJob(jobId, true);
      if (pollJob === jobId) {
        pollTimer = setTimeout(tickFn, 5000);
      }
    };
    pollTimer = setTimeout(tickFn, 5000);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollJob = null;
  }

  async function refreshJob(jobId, quiet) {
    try {
      const token = await state.getAccessToken();
      const job = await window.CORPUS_API.getTrainingJob(jobId, token);
      state.updateTrainingJob(jobId, job);
      updateControls(job);
      updateMonitorStatus(job);
      if (!isActiveStatus(job.status)) {
        stopPolling();
        disconnectJobStream();
        if (!quiet) loadJobs();
        if (job.status === 'failed' && reportedFailureJobId !== jobId && window.CORPUS_API.listTrainingLogs) {
          try {
            const events = await window.CORPUS_API.listTrainingLogs(jobId, token);
            const failed = Array.isArray(events)
              ? events.slice().reverse().find(ev => ev && ev.event === 'failed' && ev.data && ev.data.error)
              : null;
            if (failed) reportJobFailure(jobId, failed.data.error);
          } catch (e) { /* ignore log lookup error */ }
        }
      }
      const metrics = await window.CORPUS_API.listTrainingMetrics(jobId, token);
      (metrics || []).forEach(applyMetric);
      return job;
    } catch (err) {
      if (!quiet) log('Could not refresh job ' + jobId + ': ' + (err.message || 'unknown error'), 'warn');
      return null;
    }
  }

  /* ---------------- Charts ---------------- */

  function renderCharts() {
    const container = document.getElementById('training-charts');
    if (!container) return;
    container.innerHTML = `
      <div class="card">
        <div class="card-head" style="margin-bottom:var(--space-2);">
          <h3 class="card-title">Training loss</h3>
          <span class="chip">step → loss</span>
        </div>
        <div class="chart-container">
          <canvas id="training-loss-chart"></canvas>
          <div id="training-loss-empty" class="chart-empty">
            <i class="fas fa-chart-line"></i>
            <span>No loss values yet. Metrics appear here as soon as the worker reports a step.</span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head" style="margin-bottom:var(--space-2);">
          <h3 class="card-title">Throughput</h3>
          <span class="chip">step → tokens/sec</span>
        </div>
        <div class="chart-container">
          <canvas id="training-throughput-chart"></canvas>
          <div id="training-throughput-empty" class="chart-empty">
            <i class="fas fa-gauge-high"></i>
            <span>No throughput reported yet.</span>
          </div>
        </div>
      </div>
    `;
    chartInstances.loss = window.charts.createLineChart('training-loss-chart', [], [
      { label: 'Loss', data: [], borderColor: '#b9a7ff', backgroundColor: 'rgba(124, 92, 255, 0.14)', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 2 },
    ]);
    chartInstances.throughput = window.charts.createLineChart('training-throughput-chart', [], [
      { label: 'Tokens/sec', data: [], borderColor: '#4ade80', borderWidth: 2, fill: false, tension: 0.3, pointRadius: 2 },
    ]);
    updateCharts();
  }

  function updateCharts() {
    if (!chartInstances.loss || !chartInstances.throughput) return;
    const hasLoss = metricSeries.loss.length > 0;
    const hasTps = metricSeries.throughput.some(value => value != null);
    const lossEmpty = document.getElementById('training-loss-empty');
    const tpsEmpty = document.getElementById('training-throughput-empty');
    if (lossEmpty) lossEmpty.classList.toggle('hidden', hasLoss);
    if (tpsEmpty) tpsEmpty.classList.toggle('hidden', hasTps);
    window.charts.updateChart('training-loss-chart', metricSeries.steps.slice(), [{
      label: 'Loss', data: metricSeries.loss.slice(), borderColor: '#b9a7ff',
      backgroundColor: 'rgba(124, 92, 255, 0.14)', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 2,
    }]);
    window.charts.updateChart('training-throughput-chart', metricSeries.steps.slice(), [{
      label: 'Tokens/sec', data: metricSeries.throughput.map(value => value == null ? null : value),
      borderColor: '#4ade80', borderWidth: 2, fill: false, tension: 0.3, pointRadius: 2,
    }]);
  }

  function dispose() {
    disconnectJobStream();
    stopPolling();
    if (window.charts && typeof window.charts.destroyChart === 'function') {
      window.charts.destroyChart('training-loss-chart');
      window.charts.destroyChart('training-throughput-chart');
    }
    chartInstances = {};
    startInFlight = false;
  }

  return {
    render,
    onModelChange,
    onDatasetChange,
    startTraining,
    pauseTraining,
    resumeTraining,
    stopTraining,
    refreshDatasets,
    openDatasetManager,
    loadJobs,
    renderCharts,
    log,
    clearLog,
    updateEstimate,
    dispose,
    // exposed for tests/diagnostics
    validateSelection,
    isDatasetUsable,
  };
})();
