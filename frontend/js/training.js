/* ========================================
   CORPUS ULTIMATE — Training page
   ======================================== */

window.training = (function () {
  let charts = {};
  let wsJobId = null;

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to start training.</p></div>';
      return;
    }

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
          <h3>1. Model & Dataset</h3>
          <div class="input-field">
            <label>Model</label>
            <select id="t-model" onchange="training.onModelChange()">
              <option value="">Select a model</option>
              ${(state.getModels() || []).map(m => '<option value="' + m.id + '">' + (m.name || 'Unnamed') + '</option>').join('')}
            </select>
          </div>
          <div class="input-field">
            <label>Dataset</label>
            <select id="t-dataset">
              <option value="">Select a dataset</option>
              ${(state.getDatasets() || []).map(d => '<option value="' + d.id + '">' + (d.name || 'Unnamed') + '</option>').join('')}
            </select>
          </div>
          <div class="input-field">
            <label>Engine</label>
            <select id="t-engine">
              <option value="pytorch">PyTorch Engine (real torch.nn)</option>
              <option value="numerical">Custom Numerical Engine (educational)</option>
            </select>
          </div>
          <div class="input-field">
            <label>Compute</label>
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
          <div class="training-actions">
            <button class="btn btn-primary" id="t-start" onclick="training.startTraining()"><i class="fas fa-play"></i> Start Training</button>
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
        <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Training Logs</h3>
        <div class="log-panel" id="t-logs">
          <div class="log-entry info"><span class="log-time">[system]</span> Ready to train.</div>
        </div>
      </div>
    `;

    if (activeModel) {
      document.getElementById('t-model').value = activeModel.id;
      training.onModelChange();
    }

    // Load jobs
    await loadJobs();
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

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function onModelChange() {
    const id = document.getElementById('t-model').value;
    const m = state.getModel(id);
    if (m) {
      state.setActiveModel(m);
      const params = CORPUS_UTILS.calculateParameters(m.config || {});
      document.getElementById('t-estimate-text').innerHTML =
        '<strong>Estimated parameters:</strong> ' + CORPUS_UTILS.formatNumber(params) + '<br>' +
        '<strong>Engine:</strong> PyTorch / Custom Numerical<br>' +
        '<strong>Memory estimate:</strong> ~' + Math.round((params * 4) / 1024 / 1024) + ' MB (FP32 weights only)';
    } else {
      document.getElementById('t-estimate-text').textContent = 'Select a model to see the estimate.';
    }
  }

  async function loadJobs() {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listTrainingJobs(token);
      state.setTrainingJobs(data.jobs || data || []);
    } catch (err) {
      state.setTrainingJobs([]);
      log('Backend unavailable — jobs list empty', 'warn');
    }
    renderJobList();
  }

  function renderJobList() {
    // Jobs are shown inline in the page via charts/logs; list could be expanded
  }

  async function startTraining() {
    const modelId = document.getElementById('t-model').value;
    const datasetId = document.getElementById('t-dataset').value;
    if (!modelId) {
      ui.toast('Please select a model', 'error');
      return;
    }
    const config = {
      model_id: modelId,
      dataset_id: datasetId || null,
      engine: document.getElementById('t-engine').value,
      compute: document.getElementById('t-compute').value,
      batch_size: parseInt(document.getElementById('t-batch').value) || 16,
      learning_rate: parseFloat(document.getElementById('t-lr').value) || 0.001,
      epochs: parseInt(document.getElementById('t-epochs').value) || 10,
      gradient_accumulation_steps: parseInt(document.getElementById('t-accum').value) || 1,
      gradient_clip: parseFloat(document.getElementById('t-clip').value) || 1.0,
      seed: parseInt(document.getElementById('t-seed').value) || 42,
    };
    ui.setButtonLoading(document.getElementById('t-start'), true);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createTrainingJob(config, token);
      const job = data.job || data;
      state.addTrainingJob(job);
      state.setActiveJob(job);
      wsJobId = job.id;
      ui.toast('Training job started', 'success');
      log('Job ' + job.id + ' created — status: ' + job.status);
      updateControls(job);
      await loadJobs();
      connectJobWS(job.id);
      renderCharts();
    } catch (err) {
      ui.toast(err.message || 'Failed to start training', 'error');
      log('Error: ' + (err.message || 'unknown'), 'error');
    } finally {
      ui.setButtonLoading(document.getElementById('t-start'), false);
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

  function updateControls(job) {
    const running = job.status === 'running';
    const paused = job.status === 'paused';
    document.getElementById('t-start').disabled = running || paused;
    document.getElementById('t-pause').disabled = !running;
    document.getElementById('t-resume').disabled = !paused;
    document.getElementById('t-stop').disabled = !(running || paused);
  }

  function connectJobWS(jobId) {
    window.CORPUS_API.subscribeTraining(jobId, {
      onMetric: (m) => {
        updateMetrics(m);
      },
      onLog: (l) => {
        log(l.message || JSON.stringify(l), l.level || 'info');
      },
      onStatus: (s) => {
        state.updateTrainingJob(jobId, { status: s.status });
        updateControls(state.getTrainingJob(jobId));
        if (s.status === 'completed') ui.toast('Training completed!', 'success');
        if (s.status === 'failed') ui.toast('Training failed', 'error');
      },
      onComplete: (d) => {
        ui.toast('Training finished', 'success');
        renderCharts();
      },
      onError: (e) => {
        log('Training error: ' + (e.message || 'unknown'), 'error');
        ui.toast('Training error', 'error');
      },
    });
  }

  function updateMetrics(metric) {
    const panel = document.getElementById('t-logs');
    if (metric.loss !== undefined) {
      log('Step ' + (metric.step || '—') + ' — loss: ' + metric.loss.toFixed(4), 'info');
    }
    // Update charts
    if (charts.loss) {
      const labels = charts.loss.data.labels || [];
      labels.push(metric.step || labels.length + 1);
      if (labels.length > 50) labels.shift();
      charts.updateChart('training-loss-chart', labels, [
        { label: 'Loss', data: [...(charts.loss.data.datasets[0]?.data || []), metric.loss], borderColor: '#6750a4', fill: false, tension: 0.4 },
      ]);
    }
  }

  function renderCharts() {
    const container = document.getElementById('training-charts');
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
    charts.loss = charts.createLineChart('training-loss-chart', [], [
      { label: 'Loss', data: [], borderColor: '#6750a4', fill: false, tension: 0.4 },
    ]);
    charts.throughput = charts.createLineChart('training-throughput-chart', [], [
      { label: 'Tokens/sec', data: [], borderColor: '#10b981', fill: false, tension: 0.4 },
    ]);
  }

  return {
    render,
    onModelChange,
    startTraining,
    pauseTraining,
    resumeTraining,
    stopTraining,
    log,
    loadJobs,
    renderCharts,
  };
})();