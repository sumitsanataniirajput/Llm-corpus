/* ========================================
   CORPUS ULTIMATE — Training page
   ======================================== */

window.training = (function () {
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

  const DATASET_UNUSABLE_STATUSES = ['failed', 'deleted'];

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to start training.</p></div>';
      return;
    }

    // Reset any stream/series state from a previous visit to this page.
    disconnectJobStream();
    stopPolling();
    wsJobId = null;
    metricSeries = { steps: [], loss: [], throughput: [] };
    seenSteps = new Set();

    const activeModel = state.getActiveModel();
    container.innerHTML = `
      <div class="training-header">
        <div>
          <h1 class="section-title">Training Center</h1>
          <p class="section-subtitle">Configure and run genuine training jobs for your CORPUS models.</p>
        </div>
      </div>

      <div class="training-controls">
        <div class="training-panel">
          <div class="training-panel-header">
            <h3>1. Model &amp; Dataset</h3>
            <button class="btn btn-outline btn-sm" id="t-refresh-datasets" type="button" onclick="training.refreshDatasets()" title="Reload your datasets from the backend">
              <i class="fas fa-rotate"></i> Refresh
            </button>
          </div>
          <div class="input-field">
            <label for="t-model">Model</label>
            <select id="t-model" onchange="training.onModelChange()">
              <option value="">Loading models…</option>
            </select>
          </div>
          <div class="input-field">
            <label for="t-dataset">Dataset</label>
            <select id="t-dataset" disabled>
              <option value="">Loading datasets…</option>
            </select>
            <p class="field-hint" id="t-dataset-hint">Fetching your uploaded datasets…</p>
          </div>
          <div id="t-dataset-info" class="dataset-selection"></div>
          <p class="dataset-manage-link">
            <a href="#/datasets" onclick="training.openDatasetManager(event)"><i class="fas fa-database"></i> Manage datasets &amp; uploads</a>
          </p>
          <div class="input-field">
            <label for="t-engine">Engine</label>
            <select id="t-engine">
              <option value="pytorch">PyTorch Engine (real torch.nn)</option>
              <option value="numerical">Custom Numerical Engine (educational)</option>
            </select>
          </div>
          <div class="input-field">
            <label for="t-compute">Compute</label>
            <select id="t-compute">
              <option value="local">Local (this device)</option>
              <option value="cloud">Cloud (remote worker)</option>
            </select>
          </div>
        </div>

        <div class="training-panel">
          <h3>2. Hyperparameters</h3>
          <div class="form-grid">
            <div class="input-field">
              <input type="number" id="t-batch" value="16" min="1">
              <label for="t-batch">Batch size</label>
            </div>
            <div class="input-field">
              <input type="number" id="t-lr" value="0.001" step="0.0001" min="0">
              <label for="t-lr">Learning rate</label>
            </div>
            <div class="input-field">
              <input type="number" id="t-epochs" value="10" min="1">
              <label for="t-epochs">Epochs</label>
            </div>
            <div class="input-field">
              <input type="number" id="t-accum" value="1" min="1">
              <label for="t-accum">Gradient accumulation</label>
            </div>
            <div class="input-field">
              <input type="number" id="t-clip" value="1.0" step="0.1" min="0">
              <label for="t-clip">Gradient clipping</label>
            </div>
            <div class="input-field">
              <input type="number" id="t-seed" value="42" min="0">
              <label for="t-seed">Random seed</label>
            </div>
          </div>
        </div>

        <div class="training-panel">
          <h3>3. Resource Estimate</h3>
          <div id="t-estimate" class="card" style="padding:var(--space-4);">
            <p id="t-estimate-text">Configure a model and dataset to see the estimate.</p>
          </div>
          <div id="t-form-error" class="form-alert error hidden" role="alert"></div>
          <div class="training-actions">
            <button class="btn btn-primary" id="t-start" onclick="training.startTraining()" disabled><i class="fas fa-play"></i> Start Training</button>
            <button class="btn btn-outline" id="t-pause" onclick="training.pauseTraining()" disabled><i class="fas fa-pause"></i> Pause</button>
            <button class="btn btn-outline" id="t-resume" onclick="training.resumeTraining()" disabled><i class="fas fa-play"></i> Resume</button>
            <button class="btn btn-danger" id="t-stop" onclick="training.stopTraining()" disabled><i class="fas fa-stop"></i> Stop</button>
          </div>
        </div>
      </div>

      <div class="training-charts" id="training-charts">
        <!-- live charts -->
      </div>

      <div class="training-logs">
        <div class="training-panel-header">
          <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Recent Training Jobs</h3>
        </div>
        <div id="t-jobs" class="training-jobs">
          <p class="field-hint">Loading recent jobs…</p>
        </div>
      </div>

      <div class="training-logs">
        <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Training Logs</h3>
        <div class="log-panel" id="t-logs">
          <div class="log-entry info"><span class="log-time">[system]</span> Ready to train.</div>
        </div>
      </div>
    `;

    // Live-refresh the dataset selector whenever a dataset is uploaded/deleted.
    bindDatasetRefreshListener();

    document.getElementById('t-dataset').addEventListener('change', onDatasetChange);
    renderCharts();
    await Promise.all([loadModels(), refreshDatasets()]);

    const pendingId = state.getPendingDatasetId ? state.getPendingDatasetId() : null;
    if (pendingId) applySelectedDataset(pendingId);

    if (activeModel) {
      const modelSelect = document.getElementById('t-model');
      if (modelSelect && modelsCache.some(m => m.id === activeModel.id)) {
        modelSelect.value = activeModel.id;
        onModelChange();
      }
    }

    await loadJobs();
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }

  function log(message, type = 'info') {
    const panel = document.getElementById('t-logs');
    if (!panel) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    entry.innerHTML = '<span class="log-time">[' + time + ']</span> ' + escapeHtml(message);
    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
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
    populateDatasetSelect();
    if (hint && datasetsCache.length === 0 && !datasetsError) {
      hint.textContent = 'No datasets yet. Upload one in Dataset Manager to enable training.';
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
    const jobActive = wsJobId && state.getTrainingJob(wsJobId) &&
      ['queued', 'running', 'pausing', 'stopping', 'paused'].indexOf(state.getTrainingJob(wsJobId).status) !== -1;
    btn.disabled = !modelId || !dataset || !isDatasetUsable(dataset) || !!jobActive;
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
    box.textContent = message;
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
    const id = document.getElementById('t-model').value;
    const m = modelsCache.find(model => model.id === id) || state.getModel(id);
    if (m) {
      state.setActiveModel(m);
    }
    updateEstimate();
    clearFormError();
    updateStartButtonState();
  }

  function updateEstimate() {
    const text = document.getElementById('t-estimate-text');
    if (!text) return;
    const modelId = document.getElementById('t-model') ? document.getElementById('t-model').value : '';
    const m = modelsCache.find(model => model.id === modelId);
    const dataset = selectedDataset();
    if (!m) {
      text.textContent = 'Select a model to see the estimate.';
      return;
    }
    const params = CORPUS_UTILS.calculateParameters(m.config || {});
    const lines = [
      '<strong>Estimated parameters:</strong> ' + CORPUS_UTILS.formatNumber(params),
      '<strong>Engine:</strong> ' + escapeHtml(document.getElementById('t-engine').value === 'numerical' ? 'Custom Numerical' : 'PyTorch'),
      '<strong>Memory estimate:</strong> ~' + Math.round((params * 4) / 1024 / 1024) + ' MB (FP32 weights only)',
    ];
    if (dataset) {
      const bytes = dataset.file_size || dataset.size || 0;
      // Rough character-based estimate; the real tokenizer runs on the backend.
      const approxTokens = Math.max(0, Math.round(bytes / 4));
      lines.push('<strong>Dataset:</strong> ' + escapeHtml(dataset.name || '') +
        (bytes ? ' (~' + CORPUS_UTILS.formatNumber(approxTokens) + ' est. tokens)' : ''));
    } else {
      lines.push('<strong>Dataset:</strong> not selected yet');
    }
    text.innerHTML = lines.join('<br>');
  }

  /* ---------------- Jobs ---------------- */

  async function loadJobs() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listTrainingJobs(token);
      state.setTrainingJobs(normalizeList(data, 'jobs'));
    } catch (err) {
      state.setTrainingJobs([]);
      log('Could not load training jobs: ' + (err.message || 'unknown error'), 'error');
    }
    renderJobList();
  }

  function renderJobList() {
    const container = document.getElementById('t-jobs');
    if (!container) return;
    const jobs = state.getTrainingJobs() || [];
    if (jobs.length === 0) {
      container.innerHTML = '<p class="field-hint">No training jobs yet.</p>';
      return;
    }
    container.innerHTML = jobs.slice(0, 8).map(job => {
      const datasetName = (datasetsCache.find(d => d.id === job.dataset_id) || {}).name;
      const modelName = (modelsCache.find(m => m.id === job.model_id) || {}).name;
      return `
        <div class="job-row">
          <div class="job-row-main">
            <span class="status-badge ${escapeHtml(job.status || 'queued')}">${escapeHtml(job.status || 'queued')}</span>
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

  async function startTraining() {
    const check = validateSelection();
    if (!check.ok) {
      showFormError(check.message);
      ui.toast(check.message, 'error');
      log('Cannot start training: ' + check.message, 'error');
      return;
    }
    clearFormError();

    const dataset = check.dataset;
    const config = {
      model_id: check.modelId,
      dataset_id: dataset.id,
      engine: document.getElementById('t-engine').value,
      compute: document.getElementById('t-compute').value,
      batch_size: parseInt(document.getElementById('t-batch').value) || 16,
      learning_rate: parseFloat(document.getElementById('t-lr').value) || 0.001,
      epochs: parseInt(document.getElementById('t-epochs').value) || 10,
      gradient_accumulation_steps: parseInt(document.getElementById('t-accum').value) || 1,
      gradient_clip: parseFloat(document.getElementById('t-clip').value) || 1.0,
      seed: parseInt(document.getElementById('t-seed').value) || 42,
    };

    const startBtn = document.getElementById('t-start');
    ui.setButtonLoading(startBtn, true);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createTrainingJob(config, token);
      const job = data.job || data;
      if (!job || !job.id) {
        throw new Error('The backend did not return a training job.');
      }
      state.addTrainingJob(job);
      state.setActiveJob(job);
      wsJobId = job.id;
      seenSteps = new Set();
      metricSeries = { steps: [], loss: [], throughput: [] };
      ui.toast('Training job queued', 'success');
      log('Job ' + job.id + ' created — status: ' + job.status);
      log('Dataset: ' + (dataset.name || dataset.id) + ' (' + dataset.id + ')');
      updateControls(job);
      await loadJobs();
      updateStartButtonState();
      connectJobStream(job.id);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to start training';
      showFormError(message);
      ui.toast(message, 'error');
      log('Error: ' + message, 'error');
    } finally {
      ui.setButtonLoading(startBtn, false);
    }
  }

  async function pauseTraining() {
    if (!wsJobId) return;
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.pauseTrainingJob(wsJobId, token);
      log('Pause requested for job ' + wsJobId);
    } catch (err) {
      ui.toast(err.message || 'Pause failed', 'error');
    }
  }

  async function resumeTraining() {
    if (!wsJobId) return;
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.resumeTrainingJob(wsJobId, token);
      log('Resume requested for job ' + wsJobId);
    } catch (err) {
      ui.toast(err.message || 'Resume failed', 'error');
    }
  }

  async function stopTraining() {
    if (!wsJobId) return;
    ui.confirm('Stop training', 'Stop this training job? Checkpoint will be saved.', async () => {
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.stopTrainingJob(wsJobId, token);
        log('Stop requested for job ' + wsJobId);
      } catch (err) {
        ui.toast(err.message || 'Stop failed', 'error');
      }
    });
  }

  function isActiveStatus(status) {
    return ['queued', 'running', 'pausing', 'paused', 'stopping'].indexOf(status) !== -1;
  }

  function updateControls(job) {
    if (!job) return;
    const status = job.status;
    const startEl = document.getElementById('t-start');
    const pauseEl = document.getElementById('t-pause');
    const resumeEl = document.getElementById('t-resume');
    const stopEl = document.getElementById('t-stop');
    if (!startEl) return;
    const active = isActiveStatus(status);
    startEl.disabled = active || !validateSelection().ok;
    pauseEl.disabled = status !== 'running';
    resumeEl.disabled = status !== 'paused';
    stopEl.disabled = !(status === 'running' || status === 'paused' || status === 'queued');
  }

  function connectJobStream(jobId) {
    disconnectJobStream();
    startPolling(jobId);
    window.CORPUS_API.connectTrainingWS(jobId, {
      onMetric: (metric) => applyMetric(metric),
      onStatus: (payload) => applyStatus(jobId, payload),
      onComplete: (payload) => {
        log('Job ' + jobId + ' finished: ' + ((payload && payload.status) || 'completed'));
        refreshJob(jobId);
      },
      onError: (err) => {
        log('Live stream error: ' + ((err && (err.message || err.detail)) || 'unknown'), 'error');
      },
    }).then((socket) => {
      activeSocket = socket;
      if (!socket) log('Live progress stream unavailable — using periodic refresh instead.', 'warn');
    });
  }

  function disconnectJobStream() {
    if (activeSocket) {
      try { activeSocket.close(); } catch (e) {}
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
      metricSeries.throughput.push(tps === null ? 0 : tps);
      if (metricSeries.steps.length > 200) {
        metricSeries.steps.shift();
        metricSeries.loss.shift();
        metricSeries.throughput.shift();
      }
      log('Step ' + step + ' — loss: ' + loss.toFixed(4) +
        (tps !== null ? ' — ' + Math.round(tps) + ' tok/s' : ''), 'info');
    }
    updateCharts();
  }

  function applyStatus(jobId, payload) {
    if (!payload) return;
    state.updateTrainingJob(jobId, { status: payload.status, dataset_id: payload.dataset_id, model_id: payload.model_id });
    const job = state.getTrainingJob(jobId) || { id: jobId, status: payload.status };
    updateControls(job);
    log('Job ' + jobId + ' status: ' + payload.status);
    if (!isActiveStatus(payload.status)) {
      stopPolling();
      disconnectJobStream();
      loadJobs();
    }
  }

  function startPolling(jobId) {
    stopPolling();
    pollJob = jobId;
    const tick = async () => {
      if (pollJob !== jobId) return;
      if (!document.getElementById('t-logs')) { stopPolling(); disconnectJobStream(); return; }
      await refreshJob(jobId, true);
      if (pollJob === jobId) {
        pollTimer = setTimeout(tick, 5000);
      }
    };
    pollTimer = setTimeout(tick, 5000);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollJob = null;
  }

  async function refreshJob(jobId, quiet = false) {
    try {
      const token = await state.getAccessToken();
      const job = await window.CORPUS_API.getTrainingJob(jobId, token);
      state.updateTrainingJob(jobId, job);
      updateControls(job);
      if (!isActiveStatus(job.status)) {
        stopPolling();
        disconnectJobStream();
        if (!quiet) loadJobs();
      }
      const metrics = await window.CORPUS_API.listTrainingMetrics(jobId, token);
      (metrics || []).forEach(applyMetric);
      return job;
    } catch (err) {
      if (!quiet) log('Could not refresh job ' + jobId + ': ' + (err.message || 'unknown error'), 'warn');
      return null;
    }
  }

  function renderCharts() {
    const container = document.getElementById('training-charts');
    if (!container) return;
    container.innerHTML = `
      <div class="card">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Training Loss</h3>
        <div class="chart-container">
          <canvas id="training-loss-chart"></canvas>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Throughput</h3>
        <div class="chart-container">
          <canvas id="training-throughput-chart"></canvas>
        </div>
      </div>
    `;
    chartInstances.loss = window.charts.createLineChart('training-loss-chart', [], [
      { label: 'Loss', data: [], borderColor: '#6750a4', fill: false, tension: 0.4 },
    ]);
    chartInstances.throughput = window.charts.createLineChart('training-throughput-chart', [], [
      { label: 'Tokens/sec', data: [], borderColor: '#10b981', fill: false, tension: 0.4 },
    ]);
    updateCharts();
  }

  function updateCharts() {
    if (!chartInstances.loss || !chartInstances.throughput) return;
    window.charts.updateChart('training-loss-chart', metricSeries.steps.slice(), [
      { label: 'Loss', data: metricSeries.loss.slice(), borderColor: '#6750a4', fill: false, tension: 0.4 },
    ]);
    window.charts.updateChart('training-throughput-chart', metricSeries.steps.slice(), [
      { label: 'Tokens/sec', data: metricSeries.throughput.slice(), borderColor: '#10b981', fill: false, tension: 0.4 },
    ]);
  }

  function dispose() {
    disconnectJobStream();
    stopPolling();
    chartInstances = {};
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
    dispose,
    // exposed for tests/diagnostics
    validateSelection,
    isDatasetUsable,
  };
})();
