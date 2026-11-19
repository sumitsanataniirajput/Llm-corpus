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
  // Every mounted Training Center gets a generation token. Async reads started
  // by an older visit must not write into a newly opened page.
  let pageGeneration = 0;
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
  let reportedFailureMessage = null;
  // A confirmed deletion stays hidden for this page session even if a stale
  // list response races the DELETE response. The backend remains authoritative
  // across reloads; this set only prevents an already-confirmed row reappearing.
  const confirmedDeletedJobIds = new Set();

  function isCurrentPage(generation) {
    try {
      const container = window.CORPUS_APP && typeof window.CORPUS_APP.getPageContainer === 'function'
        ? window.CORPUS_APP.getPageContainer()
        : null;
      const marker = container ? container.getAttribute('data-training-page-generation') : null;
      // A null marker is allowed for direct diagnostic/test invocations on the
      // currently mounted page; a mismatched marker always means a stale visit.
      return generation === pageGeneration
        && !!document.getElementById('t-model')
        && !!container
        && (marker === null || marker === String(generation));
    } catch (err) {
      // A scheduled flush can fire while the document is being torn down;
      // that visit is definitionally no longer current.
      return false;
    }
  }

  // Backend list endpoints have used bare arrays and keyed envelopes. Normalize
  // without assuming a response is iterable, so a malformed/error object can
  // never trigger `for ... of` or `.map()` on a non-array.
  function normalizeList(data, key) {
    if (Array.isArray(data)) return data.filter(item => item && typeof item === 'object');
    if (!data || typeof data !== 'object') return [];
    const candidates = [key, 'items', 'data', 'results'].filter(Boolean);
    for (let index = 0; index < candidates.length; index += 1) {
      const value = data[candidates[index]];
      if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
    }
    return [];
  }

  function normalizeEvents(data) {
    const onlyObjects = (list) => list.filter(item => item && typeof item === 'object');
    if (Array.isArray(data)) return onlyObjects(data);
    if (!data || typeof data !== 'object') return [];
    const keys = ['events', 'logs', 'metrics', 'checkpoints', 'items', 'data', 'results'];
    for (let index = 0; index < keys.length; index += 1) {
      if (Array.isArray(data[keys[index]])) return onlyObjects(data[keys[index]]);
    }
    return [];
  }

  // Charts are optional. A missing helper, CDN failure, or constructor/update
  // exception must leave the form, controls and live job information intact.
  function callChart(method) {
    const args = Array.prototype.slice.call(arguments, 1);
    if (!window.charts || typeof window.charts[method] !== 'function') return null;
    try {
      return window.charts[method].apply(window.charts, args);
    } catch (err) {
      try {
        if (window.CORPUS_APP && typeof window.CORPUS_APP.logDiagnostic === 'function') {
          window.CORPUS_APP.logDiagnostic('training.charts:' + method + ': ' + (err && err.message ? err.message : err));
        }
      } catch (e) { /* diagnostics are optional */ }
      return null;
    }
  }

  function resetPageResources() {
    disconnectJobStream();
    stopPolling();
    callChart('destroyChart', 'training-loss-chart');
    callChart('destroyChart', 'training-throughput-chart');
    chartInstances = {};
    pendingLogLines = [];
    startInFlight = false;
  }

  const DATASET_UNUSABLE_STATUSES = ['failed', 'deleted'];
  const ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'paused', 'stopping', 'preparing', 'finalizing'];
  // Terminal states can have their history deleted; active ones must be stopped first.
  const DELETABLE_STATUSES = ['completed', 'failed', 'cancelled', 'stopped', 'interrupted'];

  // Human labels for the backend's real training stages.
  const STAGE_LABELS = {
    queued: 'Queued',
    preparing: 'Preparing dataset',
    tokenizing: 'Tokenizing',
    loading_model: 'Loading model',
    initializing: 'Initialising training',
    training: 'Training',
    saving_checkpoints: 'Saving checkpoints',
    validating: 'Validating',
    finalizing: 'Finalising',
    completed: 'Completed',
    paused: 'Paused',
    interrupted: 'Interrupted',
    failed: 'Failed',
    cancelled: 'Cancelled',
    stopping: 'Stopping',
    pausing: 'Pausing',
  };

  async function render() {
    // Invalidate work from the previous visit before touching the new DOM.
    const generation = ++pageGeneration;
    resetPageResources();
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
    // (resetPageResources() above already detached those resources without
    // advancing the generation token for this newly mounted page.)
    wsJobId = null;
    metricSeries = { steps: [], loss: [], throughput: [] };
    seenSteps = new Set();
    checkpointsCache = [];
    checkpointsModelId = null;
    reportedFailureJobId = null;
    reportedFailureMessage = null;

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-flask"></i> Training center</span>
          <h1 class="section-title">Train a model</h1>
          <p class="section-subtitle">Pick a model and one of your uploaded datasets, tune the configuration, then start a real backend job.</p>
        </div>
        <div class="page-header-actions">
          <a class="btn btn-outline" href="#/provider-management" onclick="router.navigate('provider-management')"><i class="fas fa-key"></i> Connect AI API</a>
          <a class="btn btn-outline" href="#/ai-teachers" onclick="router.navigate('ai-teachers')"><i class="fas fa-graduation-cap"></i> AI Teachers</a>
          <a class="btn btn-outline" href="#/knowledge-distillation" onclick="router.navigate('knowledge-distillation')"><i class="fas fa-brain"></i> AI Training Studio</a>
          <button class="btn btn-outline" type="button" onclick="training.loadJobs(this)">
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
                <option value="local">Local (backend in-process CPU)</option>
              </select>
              <span class="field-hint">Training runs in the backend process on CPU. Connected devices currently preprocess data only — they do not run gradient training or synchronize gradients.</span>
            </div>
            <div class="input-field">
              <label for="t-batch">Batch size</label>
              <input type="number" id="t-batch" value="16" min="1" step="1" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
            </div>
            <div class="input-field">
              <label for="t-lr">Learning rate</label>
              <input type="number" id="t-lr" value="0.001" step="0.0001" min="0" inputmode="decimal" enterkeyhint="done" autocapitalize="off" spellcheck="false">
            </div>
            <div class="input-field">
              <label for="t-epochs">Epochs</label>
              <input type="number" id="t-epochs" value="10" min="1" step="1" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
            </div>
          </div>

          <details class="accordion" style="margin-top:var(--space-3);">
            <summary>Advanced settings</summary>
            <div class="accordion-body">
              <div class="form-grid">
                <div class="input-field">
                  <label for="t-accum">Gradient accumulation</label>
                  <input type="number" id="t-accum" value="1" min="1" step="1" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
                  <span class="field-hint">Micro-batches per optimiser step.</span>
                </div>
                <div class="input-field">
                  <label for="t-clip">Gradient clipping</label>
                  <input type="number" id="t-clip" value="1.0" step="0.1" min="0" inputmode="decimal" enterkeyhint="done" autocapitalize="off" spellcheck="false">
                  <span class="field-hint">Max gradient norm.</span>
                </div>
                <div class="input-field">
                  <label for="t-seed">Random seed</label>
                  <input type="number" id="t-seed" value="42" min="0" step="1" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
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

        <div class="job-progress-panel" id="t-progress-panel" aria-live="polite">
          <div class="job-progress-head">
            <span class="job-progress-stage" id="t-progress-stage">No stage reported yet</span>
            <span class="job-progress-percent mono" id="t-progress-percent">—</span>
          </div>
          <div class="job-progress-track" id="t-progress-track" role="progressbar"
               aria-valuemin="0" aria-valuemax="100" aria-valuetext="No progress reported yet">
            <span id="t-progress-fill" style="width:0%"></span>
          </div>
          <div class="job-progress-meta">
            <span id="t-progress-steps">Steps: not reported yet</span>
            <span id="t-progress-epoch">Epoch: not reported yet</span>
            <span id="t-progress-tokens">Tokens: not reported yet</span>
            <span id="t-progress-speed">Speed: not measurable yet</span>
            <span id="t-progress-eta">ETA: not available yet</span>
          </div>
          <p class="field-hint" id="t-progress-note" style="margin:0;">Progress is the share of the engine's optimizer steps that have completed. It is not a measure of how intelligent the model is.</p>
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
    container.setAttribute('data-training-page-generation', String(generation));

    // Live-refresh the dataset selector whenever a dataset is uploaded/deleted.
    bindDatasetRefreshListener(generation);

    const datasetSelect = document.getElementById('t-dataset');
    if (datasetSelect) datasetSelect.addEventListener('change', onDatasetChange);

    renderCharts(generation);
    await Promise.all([loadModels(generation), refreshDatasets(generation), loadJobs(null, generation)]);
    if (!isCurrentPage(generation)) return;

    const pendingId = state.getPendingDatasetId ? state.getPendingDatasetId() : null;
    if (pendingId) applySelectedDataset(pendingId);

    const activeModel = state.getActiveModel();
    if (activeModel) {
      const modelSelect = document.getElementById('t-model');
      if (modelSelect && modelsCache.some(m => m.id === activeModel.id)) {
        modelSelect.value = activeModel.id;
        onModelChange(generation);
      }
    }

    updateEstimate();
  }

  function escapeHtml(text) {
    return ui.escapeHtml(text == null ? '' : String(text));
  }

  const LOG_LIMIT = 300;

  function log(message, type) {
    const panel = document.getElementById('t-logs');
    if (!panel) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + (type || 'info');
    entry.innerHTML = '<span class="log-time">[' + time + ']</span><span>' + escapeHtml(message) + '</span>';
    const keepPinnedToBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
    panel.appendChild(entry);
    // A long training run produced thousands of nodes; keep the newest lines
    // and drop the oldest so the panel cannot grow without bound.
    while (panel.childElementCount > LOG_LIMIT) panel.removeChild(panel.firstElementChild);
    if (keepPinnedToBottom) panel.scrollTop = panel.scrollHeight;
  }

  function clearLog() {
    const panel = document.getElementById('t-logs');
    if (!panel) return;
    panel.innerHTML = '<div class="log-entry info"><span class="log-time">[system]</span><span>Log cleared.</span></div>';
  }

  /* ---------------- Datasets ---------------- */

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

  async function loadModels(generation = pageGeneration) {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listModels(token);
      if (!isCurrentPage(generation)) return;
      modelsCache = normalizeList(data, 'models');
      state.setModels(modelsCache);
    } catch (err) {
      if (!isCurrentPage(generation) || (ui.isAborted && ui.isAborted(err))) return;
      modelsCache = [];
      state.setModels([]);
      log('Could not load models: ' + (err.message || 'unknown error'), 'error');
    }
    if (isCurrentPage(generation)) populateModelSelect();
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

  async function refreshDatasets(generation = pageGeneration) {
    const select = document.getElementById('t-dataset');
    const hint = document.getElementById('t-dataset-hint');
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listDatasets(token);
      if (!isCurrentPage(generation)) return;
      const apiList = window.CORPUS_API.asDatasetList
        ? window.CORPUS_API.asDatasetList(data) : null;
      datasetsCache = normalizeList(
        Array.isArray(apiList) && apiList.length ? apiList : data,
        'datasets'
      );
      state.setDatasets(datasetsCache);
      datasetsError = null;
    } catch (err) {
      if (!isCurrentPage(generation)) return;
      datasetsCache = [];
      state.setDatasets([]);
      datasetsError = err && err.message ? err.message : 'Could not load datasets';
      log('Could not load datasets: ' + datasetsError, 'error');
    }
    if (!isCurrentPage(generation)) return;
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
      // Only refresh when this exact Training Center generation is mounted.
      const generation = pageGeneration;
      if (!isCurrentPage(generation)) return;
      // An upload/rollback just changed dataset state: drop cached reads so
      // the selector shows the real (post-change) file status, not a copy
      // that is up to one cache TTL old.
      if (window.CORPUS_API && typeof window.CORPUS_API.invalidateCache === 'function') {
        window.CORPUS_API.invalidateCache();
      }
      refreshDatasets(generation);
    });
  }

  /* ---------------- Models ---------------- */

  async function onModelChange(generation = pageGeneration) {
    const select = document.getElementById('t-model');
    const id = select ? select.value : '';
    const model = modelsCache.find(item => item.id === id) || state.getModel(id);
    if (model) state.setActiveModel(model);
    updateEstimate();
    clearFormError();
    updateStartButtonState();
    if (id) {
      await loadCheckpoints(id, generation);
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
          <div class="estimate-value">Backend in-process CPU</div>
        </div>
      </div>
      <p class="estimate-note" id="t-estimate-text" style="margin-bottom:var(--space-2);">
        Parameter count and memory are computed from the stored architecture (weights only — optimizer state,
        activations and the tokenizer are not included). Training executes in the backend process on CPU;
        connected-device tasks preprocess data only. Token count is an estimate from file size; the backend
        tokenizer is authoritative. ${hardware.length ? 'Hardware reported by this browser: ' + escapeHtml(hardware.join(', ')) + '.' : 'This browser does not report hardware details.'}
      </p>
      <p class="estimate-note">${dataset ? 'Training on <strong>' + escapeHtml(dataset.name || dataset.id) + '</strong>.' : 'No dataset selected yet.'}</p>
    `;
  }

  /* ---------------- Jobs ---------------- */

  // Terminal states (completed/failed/cancelled/stopped/interrupted) never
  // revert to an active state for the same job id — the backend starts a new
  // job instead. A REST read can be in flight when the terminal WebSocket
  // event arrives; that read predates the terminal write and must not clobber
  // the truthful terminal status the stream already reported.
  function reconcileJobStatus(fresh) {
    if (!fresh || !fresh.id) return fresh;
    const known = state.getTrainingJob(fresh.id);
    if (!known) return fresh;
    const knownStatus = String(known.status || '').toLowerCase();
    const freshStatus = String(fresh.status || '').toLowerCase();
    if (DELETABLE_STATUSES.indexOf(knownStatus) !== -1
        && DELETABLE_STATUSES.indexOf(freshStatus) === -1) {
      return Object.assign({}, fresh, {
        status: known.status,
        failure_reason: fresh.failure_reason || known.failure_reason,
        stage: fresh.stage || known.stage,
      });
    }
    return fresh;
  }

  async function loadJobs(sourceButton, generation = pageGeneration) {
    if (sourceButton) {
      // The refresh control says what it is doing and comes back afterwards.
      window.CORPUS_ACTIONS.refresh({
        name: 'Refresh training jobs',
        element: sourceButton,
        run: function () { return loadJobsData(generation); },
      });
      return;
    }
    return loadJobsData(generation);
  }

  async function loadJobsData(generation = pageGeneration) {
    let token;
    try {
      token = await state.getAccessToken();
      // Job state is live: never serve it from the read cache.
      const data = await window.CORPUS_API.listTrainingJobs(token, { noCache: true });
      if (!isCurrentPage(generation)) return;
      const jobs = normalizeList(data, 'jobs').map(reconcileJobStatus);
      state.setTrainingJobs(jobs.filter(item => item && !confirmedDeletedJobIds.has(item.id)));
    } catch (err) {
      if (!isCurrentPage(generation) || (ui.isAborted && ui.isAborted(err))) return;
      state.setTrainingJobs([]);
      log('Could not load training jobs: ' + (err.message || 'unknown error'), 'error');
      renderJobList();
      return;
    }

    if (!isCurrentPage(generation)) return;
    renderJobList();
    const jobs = state.getTrainingJobs() || [];
    if (!jobs.length) {
      wsJobId = null;
      metricSeries = { steps: [], loss: [], throughput: [] };
      seenSteps = new Set();
      updateMetricTiles();
      updateCharts(generation);
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
      updateCharts(generation);
    }

    updateMonitorStatus(selected);
    updateControls(selected);

    // Opening this page used to cost four sequential round trips (job refresh,
    // event history, checkpoints, then the model's checkpoints again). They are
    // independent reads, so they run together and the page settles in one
    // backend latency instead of four.
    let historyEnabled = false;
    let historyPromise = Promise.resolve(null);
    if (window.CORPUS_API.listTrainingLogs && !isActiveStatus(selected.status)) {
      historyEnabled = true;
      try {
        historyPromise = Promise.resolve(
          window.CORPUS_API.listTrainingLogs(selected.id, token, { limit: 200 })
        ).catch(() => null);
      } catch (err) {
        historyPromise = Promise.resolve(null);
      }
    }
    await Promise.all([
      refreshJob(selected.id, true, generation),
      historyPromise,
      selected.model_id ? loadCheckpoints(selected.model_id, generation) : Promise.resolve(),
    ]);
    if (!isCurrentPage(generation)) return;

    if (historyEnabled) {
      try {
        // Already resolved above; awaiting it again costs nothing.
        const events = normalizeEvents(await historyPromise);
        events.forEach(entry => {
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

    const latest = state.getTrainingJob(selected.id) || selected;
    if (isCurrentPage(generation) && isActiveStatus(latest.status) && !startInFlight) {
      connectJobStream(selected.id, generation);
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
      const status = String(job.status || 'queued').toLowerCase();
      const deletable = DELETABLE_STATUSES.indexOf(status) !== -1;
      const percent = Number.isFinite(Number(job.progress_percent)) ? Number(job.progress_percent) : null;
      const steps = job.total_steps
        ? escapeHtml((job.completed_steps || 0) + ' / ' + job.total_steps + ' steps')
        : null;
      return `
        <div class="job-row" data-job-row="${escapeHtml(job.id)}">
          <div class="job-row-main">
            ${ui.statusBadge(job.status || 'queued')}
            <span class="job-row-id mono">${escapeHtml(job.id)}</span>
            <span class="job-row-stage">${escapeHtml(STAGE_LABELS[job.stage] || STAGE_LABELS[status] || 'Stage not reported')}</span>
          </div>
          ${percent === null
            ? '<div class="job-row-progress indeterminate" role="progressbar" aria-valuetext="Progress not measurable yet"><span></span></div>'
            : `<div class="job-row-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}" aria-valuetext="${percent.toFixed(1)} percent complete"><span style="width:${percent.toFixed(2)}%"></span></div>
               <span class="job-row-percent mono">${percent.toFixed(1)}%${steps ? ' · ' + steps : ''}</span>`}
          <div class="job-row-meta">
            <span><i class="fas fa-cube"></i> ${escapeHtml(modelName || job.model_id || '—')}</span>
            <span><i class="fas fa-database"></i> ${escapeHtml(datasetName || job.dataset_id || 'no dataset')}</span>
            <span><i class="fas fa-clock"></i> ${escapeHtml(CORPUS_UTILS.formatDate(job.created_at))}</span>
            ${job.failure_reason ? '<span class="text-warning"><i class="fas fa-triangle-exclamation"></i> ' + escapeHtml(job.failure_reason) + '</span>' : ''}
          </div>
          <div class="job-row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-delete-job="${escapeHtml(job.id)}"
              onclick="training.deleteJob('${escapeHtml(job.id)}', this)"
              ${deletable ? '' : 'disabled title="Stop this job before deleting its history"'}>
              <i class="fas fa-trash"></i> Delete
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function loadCheckpoints(modelId, generation = pageGeneration) {
    const container = document.getElementById('t-checkpoints');
    if (!container || !isCurrentPage(generation)) return;
    if (checkpointsModelId === modelId && checkpointsCache.length) {
      renderCheckpoints();
      return;
    }
    container.innerHTML = '<div class="skeleton skeleton-block"></div>';
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listCheckpoints(modelId, token);
      if (!isCurrentPage(generation)) return;
      checkpointsCache = normalizeEvents(data);
      checkpointsModelId = modelId;
    } catch (err) {
      if (!isCurrentPage(generation)) return;
      checkpointsCache = [];
      checkpointsModelId = modelId;
    }
    if (isCurrentPage(generation)) renderCheckpoints();
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
    const generation = pageGeneration;
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
    // REQUESTED: the button says what is happening and cannot be pressed twice.
    // The backend accepting the job is not completion — the operation stays in
    // the operation centre until the worker reports a real terminal state.
    const model = modelsCache.find(m => m.id === check.modelId);
    const outcome = await window.CORPUS_ACTIONS.run({
      name: 'Start training' + (model ? ' on ' + (model.name || model.id) : ''),
      key: 'training:start',
      element: startBtn,
      label: 'Starting…',
      success: 'Training job submitted — the worker will report progress here.',
      failure: 'Training could not be started.',
      notifyFailure: false,
      run: async function () {
        const token = await state.getAccessToken();
        const data = await window.CORPUS_API.createTrainingJob(config, token);
        const job = data && data.job ? data.job : data;
        if (!job || !job.id) {
          throw new Error('The backend did not return a training job.');
        }
        return job;
      },
      onSuccess: async function (job) {
        if (!isCurrentPage(generation)) return;
        state.addTrainingJob(job);
        state.setActiveJob(job);
        wsJobId = job.id;
        reportedFailureJobId = null;
        seenSteps = new Set();
        metricSeries = { steps: [], loss: [], throughput: [] };
        window.CORPUS_ACTIONS.syncJob(job, { name: jobOperationName(job) });
        log('Job ' + job.id + ' created — status: ' + job.status);
        log('Dataset: ' + (dataset.name || dataset.id) + ' (' + dataset.id + ')');
        updateControls(job);
        updateMonitorStatus(job);
        await loadJobs(null, generation);
        if (isCurrentPage(generation)) connectJobStream(job.id, generation);
      },
    });

    if (!isCurrentPage(generation)) return;
    startInFlight = false;
    if (!outcome.ok && outcome.state !== window.CORPUS_ACTIONS.STATES.CANCELLED) {
      const message = outcome.message || 'Failed to start training';
      showFormError(message);
      log('Error: ' + message, 'error');
    }
    updateStartButtonState();
    updateControls(state.getTrainingJob(wsJobId) || null);
  }

  async function runControl(btnId, action, label, generation = pageGeneration) {
    const jobId = wsJobId;
    if (!jobId) return;
    const btn = document.getElementById(btnId);
    // Pause/Resume/Stop change backend state: one press = one request, the
    // control reports the work, and it is restored whatever the outcome.
    const outcome = await window.CORPUS_ACTIONS.run({
      name: label + ' training',
      key: 'training:' + btnId + ':' + jobId,
      element: btn,
      label: label + '…',
      success: label + ' signal accepted — the worker applies it on its next step.',
      failure: label + ' failed.',
      notifyFailure: false,
      run: async function () {
        const token = await state.getAccessToken();
        return action(jobId, token);
      },
      onSuccess: function (response) {
        if (!isCurrentPage(generation)) return;
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
      },
      onFailure: function (err) {
        if (!isCurrentPage(generation) || (ui.isAborted && ui.isAborted(err))) return;
        log(label + ' failed: ' + ((err && err.message) || 'unknown error'), 'error');
      },
    });
    if (!isCurrentPage(generation)) return outcome;
    if (!outcome.ok && outcome.state !== window.CORPUS_ACTIONS.STATES.CANCELLED) {
      ui.toast(outcome.message || (label + ' failed'), 'error');
    }
    updateControls(state.getTrainingJob(jobId) || null);
    return outcome;
  }

  function pauseTraining() {
    return runControl('t-pause', window.CORPUS_API.pauseTrainingJob, 'Pause');
  }

  function resumeTraining() {
    return runControl('t-resume', window.CORPUS_API.resumeTrainingJob, 'Resume');
  }

  function stopTraining() {
    if (!wsJobId) return;
    const generation = pageGeneration;
    ui.confirm('Stop training', 'Stop this training job? The worker saves a checkpoint before it exits.', function () {
      const btn = document.getElementById('t-stop');
      const jobId = wsJobId;
      return window.CORPUS_ACTIONS.run({
        name: 'Stop training',
        key: 'training:stop:' + jobId,
        element: btn,
        label: 'Stopping…',
        success: 'Stop signal accepted — the worker saves a checkpoint and exits.',
        failure: 'Stop failed.',
        notifyFailure: false,
        run: async function () {
          const token = await state.getAccessToken();
          return window.CORPUS_API.stopTrainingJob(jobId, token);
        },
        onSuccess: function (response) {
          if (!isCurrentPage(generation)) return;
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
        },
      }).then(function (outcome) {
        if (!isCurrentPage(generation)) return outcome;
        if (!outcome.ok && outcome.state !== window.CORPUS_ACTIONS.STATES.CANCELLED) {
          ui.toast(outcome.message || 'Stop failed', 'error');
        }
        updateControls(state.getTrainingJob(jobId) || null);
        return outcome;
      });
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

  function jobOperationName(job) {
    if (!job) return 'Training job';
    const model = modelsCache.find(m => m.id === job.model_id);
    const dataset = datasetsCache.find(d => d.id === job.dataset_id);
    return 'Training ' + (model ? (model.name || model.id) : (job.model_id || 'job')) +
      (dataset ? ' on ' + (dataset.name || dataset.id) : '');
  }

  /**
   * Reconcile the tracked operation with whatever the backend says. Called from
   * every status source (create response, WebSocket event, polling fallback),
   * so the operation centre, the toast and the monitor can never disagree, and
   * a terminal state is announced exactly once.
   */
  function syncJobOperation(job, options) {
    if (!window.CORPUS_ACTIONS || !job || !job.id || !job.status) return null;
    if (!(options && options.force) && !window.CORPUS_ACTIONS.isJobTracked(job.id)) return null;

    const opts = Object.assign({ name: jobOperationName(job) }, options || {});
    if (job.status === 'completed') {
      const lastLoss = metricSeries.loss.length ? metricSeries.loss[metricSeries.loss.length - 1] : null;
      const lastStep = metricSeries.steps.length ? metricSeries.steps[metricSeries.steps.length - 1] : null;
      opts.result = jobOperationName(job) + ' completed successfully!' +
        (lastLoss != null ? ' Final loss ' + Number(lastLoss).toFixed(4) : '') +
        (lastStep != null ? ' at step ' + lastStep + '.' : '');
    } else if (job.status === 'failed') {
      // The precise backend error is announced by reportJobFailure(), once.
      opts.notify = false;
      opts.error = job.error || 'The backend reported this training job as failed.';
    } else if (job.status === 'cancelled' || job.status === 'canceled') {
      opts.result = 'Training job cancelled.';
    }
    return window.CORPUS_ACTIONS.syncJob(job, opts);
  }

  /* ---------------- Live progress (backend truth only) ---------------- */

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return hours + ' h ' + minutes + ' min';
    if (minutes) return minutes + ' min ' + seconds + ' s';
    return seconds + ' s';
  }

  /**
   * ETA is shown only when it can be derived from real data: a backend start
   * time plus a non-zero completed share. Otherwise it says so.
   */
  function estimateEta(job) {
    if (!job || !job.started_at || ACTIVE_STATUSES.indexOf(String(job.status).toLowerCase()) === -1) return null;
    const percent = Number(job.progress_percent);
    if (!Number.isFinite(percent) || percent <= 0.5 || percent >= 100) return null;
    const startedAt = new Date(job.started_at).getTime();
    if (!Number.isFinite(startedAt)) return null;
    const elapsed = Date.now() - startedAt;
    if (elapsed <= 0) return null;
    return (elapsed / percent) * (100 - percent);
  }

  function lastMeasuredSpeed() {
    for (let index = metricSeries.throughput.length - 1; index >= 0; index -= 1) {
      const value = metricSeries.throughput[index];
      if (value !== null && value !== undefined) return Number(value);
    }
    return null;
  }

  function renderProgress(job) {
    const panel = document.getElementById('t-progress-panel');
    if (!panel) return;
    const stageEl = document.getElementById('t-progress-stage');
    const percentEl = document.getElementById('t-progress-percent');
    const trackEl = document.getElementById('t-progress-track');
    const fillEl = document.getElementById('t-progress-fill');
    const stepsEl = document.getElementById('t-progress-steps');
    const epochEl = document.getElementById('t-progress-epoch');
    const tokensEl = document.getElementById('t-progress-tokens');
    const speedEl = document.getElementById('t-progress-speed');
    const etaEl = document.getElementById('t-progress-eta');
    const noteEl = document.getElementById('t-progress-note');

    if (!job) {
      if (stageEl) stageEl.textContent = 'No job selected';
      if (percentEl) percentEl.textContent = '—';
      if (trackEl) {
        trackEl.removeAttribute('aria-valuenow');
        trackEl.setAttribute('aria-valuetext', 'No progress reported yet');
      }
      if (fillEl) fillEl.style.width = '0%';
      if (stepsEl) stepsEl.textContent = 'Steps: not reported yet';
      if (epochEl) epochEl.textContent = 'Epoch: not reported yet';
      if (tokensEl) tokensEl.textContent = 'Tokens: not reported yet';
      if (speedEl) speedEl.textContent = 'Speed: not measurable yet';
      if (etaEl) etaEl.textContent = 'ETA: not available yet';
      return;
    }

    const status = String(job.status || '').toLowerCase();
    const rawPercent = job.progress_percent;
    let percent = rawPercent === null || rawPercent === undefined || rawPercent === ''
      ? null
      : Number(rawPercent);
    if (percent !== null && !Number.isFinite(percent)) percent = null;
    if (status === 'completed') percent = 100;
    if (percent !== null) percent = Math.max(0, Math.min(100, percent));

    if (stageEl) {
      stageEl.textContent = STAGE_LABELS[job.stage] || STAGE_LABELS[status] || 'Stage not reported';
    }
    if (percentEl) percentEl.textContent = percent === null ? '—' : percent.toFixed(1) + '%';
    if (trackEl && fillEl) {
      if (percent === null) {
        trackEl.removeAttribute('aria-valuenow');
        trackEl.setAttribute('aria-valuetext', 'Progress not measurable at this stage');
        fillEl.style.width = '0%';
        trackEl.classList.add('indeterminate');
      } else {
        trackEl.classList.remove('indeterminate');
        trackEl.setAttribute('aria-valuenow', percent.toFixed(1));
        trackEl.setAttribute('aria-valuetext', percent.toFixed(1) + ' percent complete');
        fillEl.style.width = percent.toFixed(2) + '%';
      }
    }
    if (stepsEl) {
      stepsEl.textContent = job.total_steps
        ? 'Steps: ' + Number(job.completed_steps || 0) + ' / ' + Number(job.total_steps)
        : 'Steps: not reported yet';
    }
    if (epochEl) {
      epochEl.textContent = job.total_epochs
        ? 'Epoch: ' + Number(job.current_epoch || 0) + ' / ' + Number(job.total_epochs)
        : 'Epoch: not reported yet';
    }
    if (tokensEl) {
      tokensEl.textContent = Number.isFinite(Number(job.processed_tokens)) && Number(job.processed_tokens) > 0
        ? 'Tokens: ' + Number(job.processed_tokens).toLocaleString()
        : 'Tokens: not reported yet';
    }
    if (speedEl) {
      const speed = lastMeasuredSpeed();
      speedEl.textContent = speed !== null && Number.isFinite(speed)
        ? 'Speed: ' + Math.round(speed).toLocaleString() + ' tokens/s'
        : 'Speed: not measurable yet';
    }
    if (etaEl) {
      if (status === 'completed') etaEl.textContent = 'ETA: finished';
      else if (status === 'paused' || status === 'pausing') etaEl.textContent = 'ETA: paused';
      else {
        const remaining = estimateEta(job);
        etaEl.textContent = remaining === null
          ? 'ETA: not available yet'
          : 'ETA: about ' + (formatDuration(remaining) || 'a moment');
      }
    }
    if (noteEl) {
      if (status === 'failed') {
        noteEl.textContent = 'This job failed: ' + (job.failure_reason || 'the backend did not report a reason.');
      } else if (status === 'interrupted') {
        noteEl.textContent = 'This job was interrupted. It resumes from its last saved checkpoint. ' +
          (job.failure_reason || '');
      } else if (percent === null) {
        noteEl.textContent = 'This stage cannot be measured in steps yet, so the bar stays indeterminate. It will fill as soon as the engine reports progress.';
      } else {
        noteEl.textContent = 'Progress is the share of the engine\'s optimizer steps that have completed. It is not a measure of how intelligent the model is.';
      }
    }
  }

  /** Update the panel from fresh backend fields; never invents a number. */
  function applyProgress(jobId, payload, generation = pageGeneration) {
    if (!payload || !isCurrentPage(generation)) return;
    const patch = {
      progress_percent: payload.progress_percent,
      stage: payload.stage,
      completed_steps: payload.completed_steps,
      total_steps: payload.total_steps,
      current_epoch: payload.current_epoch,
      total_epochs: payload.total_epochs,
      processed_tokens: payload.processed_tokens,
      last_loss: payload.last_loss,
    };
    Object.keys(patch).forEach((key) => {
      if (patch[key] === undefined) delete patch[key];
    });
    state.updateTrainingJob(jobId, patch);
    const job = state.getTrainingJob(jobId);
    if (job) renderProgress(job);
    updateMetricTiles();
  }

  function updateMonitorStatus(job) {
    if (job) syncJobOperation(job);
    renderProgress(job);
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

  /* ---------------- Delete job history ---------------- */

  async function deleteJob(jobId, sourceButton) {
    if (!jobId) return null;
    const generation = pageGeneration;
    const job = state.getTrainingJob(jobId) || (state.getTrainingJobs() || []).find(item => item.id === jobId) || {};
    const status = String(job.status || '').toLowerCase();
    if (DELETABLE_STATUSES.indexOf(status) === -1) {
      ui.toast('Stop this job before deleting its history — an active job still owns its worker.', 'warning');
      return null;
    }

    return new Promise((resolve) => {
      ui.confirm(
        'Delete training job',
        'Remove job ' + jobId + ' from your history? The model, the dataset and any saved checkpoint are kept. ' +
          'This only hides the job record from your list.',
        () => {
          resolve(window.CORPUS_ACTIONS.run({
            name: 'Delete training job',
            key: 'training:delete:' + jobId,
            element: sourceButton || document.querySelector('[data-delete-job="' + jobId + '"]'),
            label: 'Deleting…',
            // The backend's own message is the useful one (409 for an active job).
            notifyFailure: false,
            run: async function () {
              const token = await state.getAccessToken();
              if (!token) throw new Error('Authentication required. Please sign in again.');
              return window.CORPUS_API.deleteTrainingJob(jobId, token);
            },
            onSuccess: async function () {
              confirmedDeletedJobIds.add(jobId);
              if (!isCurrentPage(generation)) return;
              // Remove the visible card immediately after the server confirms
              // deletion. Do not wait for a second list request to finish.
              state.setTrainingJobs((state.getTrainingJobs() || []).filter(item => item.id !== jobId));
              const row = document.querySelector('[data-job-row="' + jobId.replace(/["\\]/g, '') + '"]');
              if (row && row.parentNode) row.parentNode.removeChild(row);
              if (wsJobId === jobId) {
                stopPolling();
                disconnectJobStream();
                wsJobId = null;
                metricSeries = { steps: [], loss: [], throughput: [] };
                seenSteps = new Set();
                updateMetricTiles();
                updateCharts(generation);
                updateMonitorStatus(null);
              }
              renderJobList();
              // Reconcile with the backend; loadJobsData also filters any stale
              // response for this just-deleted id during the current page visit.
              await loadJobs(null, generation);
              if (isCurrentPage(generation)) ui.toast('Training job removed from your history.', 'success');
            },
            onFailure: function (err) {
              if (!isCurrentPage(generation)) return;
              const detail = err && err.data && err.data.detail;
              const message = typeof detail === 'string' && detail
                ? detail
                : (err && err.message) || 'Could not delete the training job.';
              log('Could not delete job ' + jobId + ': ' + message, 'error');
              ui.toast(message, 'error');
            },
          }));
        }
      );
    });
  }

  function reportJobFailure(jobId, message) {
    const text = message || 'Training job failed.';
    // A generic report must never mask the backend's real message arriving
    // later on the same job (e.g. status frame first, error detail second).
    if (reportedFailureJobId === jobId && reportedFailureMessage && reportedFailureMessage !== 'Training job failed.') {
      return;
    }
    if (reportedFailureJobId === jobId && reportedFailureMessage === text) return;
    reportedFailureJobId = jobId;
    reportedFailureMessage = text;
    log('Job ' + jobId + ' failed: ' + text, 'error');
    showFormError(text);
    ui.toast(text, 'error');
  }

  function extractStreamError(err) {
    if (!err) return 'unknown';
    if (typeof err === 'string') return err;
    if (err.data && typeof err.data.error === 'string' && err.data.error) return err.data.error;
    if (err.message) return err.message;
    if (err.detail) return err.detail;
    return 'unknown';
  }

  function connectJobStream(jobId, generation = pageGeneration) {
    if (!isCurrentPage(generation) || !window.CORPUS_API || typeof window.CORPUS_API.connectTrainingWS !== 'function') return;
    const streamGeneration = generation;
    disconnectJobStream();
    startPolling(jobId, streamGeneration);
    const guard = () => isCurrentPage(streamGeneration);
    let pending;
    try {
      pending = window.CORPUS_API.connectTrainingWS(jobId, {
        onMetric: (metric) => applyMetric(metric, streamGeneration),
        onProgress: (payload) => applyProgress(jobId, payload, streamGeneration),
        onStatus: (payload) => applyStatus(jobId, payload, streamGeneration),
        onComplete: (payload) => {
          if (!guard()) return;
          log('Job ' + jobId + ' finished: ' + ((payload && payload.status) || 'completed'), 'success');
          refreshJob(jobId, false, streamGeneration);
        },
        onError: (err) => {
          if (!guard()) return;
          const message = extractStreamError(err);
          if (err && err.status === 'failed') {
            applyStatus(jobId, err, streamGeneration);
            reportJobFailure(jobId, message);
            return;
          }
          log('Live stream error: ' + message, 'error');
          if (isActiveStatus((state.getTrainingJob(jobId) || {}).status)) startPolling(jobId, streamGeneration);
        },
        onClose: () => {
          if (guard() && isActiveStatus((state.getTrainingJob(jobId) || {}).status)) {
            startPolling(jobId, streamGeneration);
          }
        },
      });
    } catch (err) {
      pending = Promise.resolve(null);
    }
    Promise.resolve(pending).then((socket) => {
      if (!guard()) {
        try { if (socket) socket.close(); } catch (e) { /* stale socket */ }
        return;
      }
      activeSocket = socket;
      if (!socket) {
        log('Live progress stream unavailable — using periodic refresh instead.', 'warn');
        startPolling(jobId, streamGeneration);
        return;
      }
      // Keep the polling fallback only until the WebSocket is actually open.
      // This avoids polling the same job while its live stream is healthy.
      if (socket.readyState === 1) stopPolling();
      else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', () => { if (guard()) stopPolling(); }, { once: true });
        socket.addEventListener('error', () => {
          if (guard() && isActiveStatus((state.getTrainingJob(jobId) || {}).status)) {
            startPolling(jobId, streamGeneration);
          }
        }, { once: true });
      }
    }).catch(() => {
      if (guard()) startPolling(jobId, streamGeneration);
    });
  }

  function disconnectJobStream() {
    if (activeSocket) {
      try { activeSocket.close(); } catch (e) { /* ignore */ }
      activeSocket = null;
    }
  }

  // Live metrics arrive in bursts (one event per step, several per second). Each
  // one used to write the log, the tiles and two animated charts; at a few
  // dozen events per second that alone made the page unresponsive. Data is
  // still recorded synchronously and exactly; only the DOM/chart flush is
  // coalesced into one animation frame.
  let metricFlushScheduled = false;
  let pendingLogLines = [];

  function scheduleMetricFlush(generation = pageGeneration) {
    if (metricFlushScheduled) return;
    metricFlushScheduled = true;
    const flush = () => {
      metricFlushScheduled = false;
      if (!isCurrentPage(generation)) return;
      if (pendingLogLines.length) {
        const lines = pendingLogLines;
        pendingLogLines = [];
        const panel = document.getElementById('t-logs');
        if (panel) {
          const html = lines.map((line) => line).join('');
          panel.insertAdjacentHTML('beforeend', html);
          while (panel.childElementCount > LOG_LIMIT) panel.removeChild(panel.firstElementChild);
          panel.scrollTop = panel.scrollHeight;
        }
      }
      updateMetricTiles();
      updateCharts(generation);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  function metricLogLine(step, loss, tps) {
    const time = new Date().toLocaleTimeString();
    return '<div class="log-entry info"><span class="log-time">[' + time + ']</span><span>' +
      escapeHtml('Step ' + step + ' — loss: ' + loss.toFixed(4) +
        (tps !== null ? ' — ' + Math.round(tps) + ' tok/s' : '')) + '</span></div>';
  }

  function applyMetric(metric, generation = pageGeneration) {
    if (!metric || metric.step == null || !isCurrentPage(generation)) return;
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
      pendingLogLines.push(metricLogLine(step, loss, tps));
    }
    // Tiles are cheap text writes: update them synchronously so restored
    // history is visible immediately. Only log DOM + chart redraws are
    // coalesced into the next animation frame.
    updateMetricTiles();
    scheduleMetricFlush(generation);
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

  function applyStatus(jobId, payload, generation = pageGeneration) {
    if (!payload || !isCurrentPage(generation)) return;
    // The backend nests the human-readable reason under data.error on stream
    // frames; accept every shape it actually sends.
    const failureMessage = payload.failure_reason || payload.error
      || (payload.data && typeof payload.data === 'object' ? payload.data.error : null)
      || (typeof payload.data === 'string' ? payload.data : null);
    state.updateTrainingJob(jobId, {
      status: payload.status,
      dataset_id: payload.dataset_id,
      model_id: payload.model_id,
      progress_percent: payload.progress_percent,
      stage: payload.stage,
      completed_steps: payload.completed_steps,
      total_steps: payload.total_steps,
      current_epoch: payload.current_epoch,
      total_epochs: payload.total_epochs,
      processed_tokens: payload.processed_tokens,
      failure_reason: failureMessage,
    });
    const job = state.getTrainingJob(jobId) || { id: jobId, status: payload.status };
    updateControls(job);
    updateMonitorStatus(job);
    updateMetricTiles();
    log('Job ' + jobId + ' status: ' + payload.status);
    if (!isActiveStatus(payload.status)) {
      stopPolling();
      disconnectJobStream();
      loadJobs(null, generation);
      if (job.model_id) loadCheckpoints(job.model_id, generation);
      // A terminal state that arrives over the socket must be reported exactly
      // like one that arrives by polling.
      if (payload.status === 'failed') {
        reportJobFailure(jobId, failureMessage);
      }
    }
  }

  function startPolling(jobId, generation = pageGeneration) {
    stopPolling();
    pollJob = jobId;
    const tickFn = async () => {
      if (!isCurrentPage(generation) || pollJob !== jobId) return;
      if (!document.getElementById('t-logs')) { stopPolling(); disconnectJobStream(); return; }
      await refreshJob(jobId, true, generation);
      if (isCurrentPage(generation) && pollJob === jobId) {
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

  async function refreshJob(jobId, quiet, generation = pageGeneration) {
    try {
      const token = await state.getAccessToken();
      const job = reconcileJobStatus(await window.CORPUS_API.getTrainingJob(jobId, token));
      if (!isCurrentPage(generation)) return null;
      state.updateTrainingJob(jobId, job);
      updateControls(job);
      updateMonitorStatus(job);
      renderProgress(state.getTrainingJob(jobId) || job);
      if (!isActiveStatus(job.status)) {
        stopPolling();
        disconnectJobStream();
        if (!quiet) loadJobs(null, generation);
        if (job.status === 'failed' && reportedFailureJobId !== jobId && window.CORPUS_API.listTrainingLogs) {
          try {
            const events = normalizeEvents(await window.CORPUS_API.listTrainingLogs(jobId, token, { limit: 200 }));
            if (!isCurrentPage(generation)) return null;
            const failed = events.slice().reverse().find(ev => ev && ev.event === 'failed' && ev.data && ev.data.error);
            if (failed) reportJobFailure(jobId, failed.data.error);
          } catch (e) { /* ignore log lookup error */ }
        }
      }
      const metricsData = await window.CORPUS_API.listTrainingMetrics(jobId, token, { limit: 200 });
      if (!isCurrentPage(generation)) return null;
      normalizeEvents(metricsData).forEach(metric => applyMetric(metric, generation));
      return job;
    } catch (err) {
      if (isCurrentPage(generation) && !quiet) {
        log('Could not refresh job ' + jobId + ': ' + (err.message || 'unknown error'), 'warn');
      }
      return null;
    }
  }

  /* ---------------- Charts ---------------- */

  function showChartFallback() {
    const fallback = 'Charting is unavailable in this browser. Training controls, jobs, metrics and progress remain available.';
    ['training-loss-empty', 'training-throughput-empty'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = fallback;
      el.classList.remove('hidden');
    });
  }

  function renderCharts(generation = pageGeneration) {
    if (!isCurrentPage(generation)) return;
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
    chartInstances.loss = callChart('createLineChart', 'training-loss-chart', [], [
      { label: 'Loss', data: [], borderColor: '#b9a7ff', backgroundColor: 'rgba(124, 92, 255, 0.14)', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 2 },
    ]);
    chartInstances.throughput = callChart('createLineChart', 'training-throughput-chart', [], [
      { label: 'Tokens/sec', data: [], borderColor: '#4ade80', borderWidth: 2, fill: false, tension: 0.3, pointRadius: 2 },
    ]);
    if (!chartInstances.loss || !chartInstances.throughput) showChartFallback();
    updateCharts(generation);
  }

  function updateCharts(generation = pageGeneration) {
    if (!isCurrentPage(generation)) return;
    const hasLoss = metricSeries.loss.length > 0;
    const hasTps = metricSeries.throughput.some(value => value != null);
    const lossEmpty = document.getElementById('training-loss-empty');
    const tpsEmpty = document.getElementById('training-throughput-empty');
    if (lossEmpty) lossEmpty.classList.toggle('hidden', hasLoss);
    if (tpsEmpty) tpsEmpty.classList.toggle('hidden', hasTps);
    if (chartInstances.loss) {
      callChart('updateChart', 'training-loss-chart', metricSeries.steps.slice(), [{
        label: 'Loss', data: metricSeries.loss.slice(), borderColor: '#b9a7ff',
        backgroundColor: 'rgba(124, 92, 255, 0.14)', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 2,
      }], { animate: false });
    }
    if (chartInstances.throughput) {
      callChart('updateChart', 'training-throughput-chart', metricSeries.steps.slice(), [{
        label: 'Tokens/sec', data: metricSeries.throughput.map(value => value == null ? null : value),
        borderColor: '#4ade80', borderWidth: 2, fill: false, tension: 0.3, pointRadius: 2,
      }], { animate: false });
    }
  }

  function dispose() {
    // Called by the router when leaving. Incrementing here is the stale-request
    // barrier: every in-flight promise from this visit has an older generation.
    pageGeneration += 1;
    const container = window.CORPUS_APP && typeof window.CORPUS_APP.getPageContainer === 'function'
      ? window.CORPUS_APP.getPageContainer() : null;
    if (container) container.removeAttribute('data-training-page-generation');
    resetPageResources();
  }

  return {
    render,
    // Exposed for the WebSocket handler's callers, diagnostics and tests: these
    // are the same functions the live stream uses, not a parallel code path.
    applyMetric,
    appendLog: log,
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
    deleteJob,
    renderProgress,
    applyProgress,
    estimateEta,
    log,
    clearLog,
    updateEstimate,
    dispose,
    // exposed for tests/diagnostics
    validateSelection,
    isDatasetUsable,
    isCurrentPage,
    getPageGeneration: () => pageGeneration,
  };
})();
