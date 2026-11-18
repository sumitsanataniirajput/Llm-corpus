/* ========================================
   CORPUS ULTIMATE — Training Intelligence

   Route: #/training-intelligence (optionally #/training-intelligence/<job_id>)

   A. architecture    ← the inspected model (real parameter count)
   B. configuration   ← the job's stored config + derived global batch
   C. dataset         ← what the tokenizer/loader measured
   D. hardware        ← samples captured on the machine that trained
   E. live metrics    ← the engine's own step counter
   F. charts          ← the persisted metric series

   Any value the backend could not measure arrives as null and is printed as
   "Unavailable". GPU figures are never invented, and a cloud teacher is never
   described as local compute.
   ======================================== */

window.intelligence = (function () {
  'use strict';

  const STATE = {
    jobs: [],
    jobId: '',
    data: null,
    error: null,
    timer: null,
    loading: false,
  };

  function esc(value) { return ui.escapeHtml(value == null ? '' : String(value)); }
  function num(value) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : 'Unavailable';
  }
  function unavailable(value, suffix) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    return suffix ? String(value) + suffix : String(value);
  }
  function container() { return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null; }
  function jobIdFromRoute() {
    const hash = (window.location && window.location.hash) || '';
    const match = hash.match(/training-intelligence\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : '';
  }

  function stopTimer() {
    if (STATE.timer) clearInterval(STATE.timer);
    STATE.timer = null;
  }

  async function load() {
    try {
      const token = await state.getAccessToken();
      if (!STATE.jobs.length) {
        const payload = await window.CORPUS_API.listTrainingJobs(token);
        STATE.jobs = Array.isArray(payload) ? payload : (payload && payload.jobs) || [];
      }
      const jobId = STATE.jobId || jobIdFromRoute() || (STATE.jobs[0] && STATE.jobs[0].id) || '';
      STATE.jobId = jobId;
      if (!jobId) {
        STATE.data = null;
        STATE.error = null;
        return;
      }
      STATE.data = await window.CORPUS_API.getTrainingIntelligence(jobId, token);
      STATE.error = null;
    } catch (err) {
      STATE.error = (err && err.message) || 'Could not load training intelligence.';
    }
  }

  function kvRows(rows) {
    return `<dl class="kv-list">${rows.map(([label, value]) => `
      <div><dt>${esc(label)}</dt><dd>${value === null || value === undefined || value === ''
        ? 'Unavailable' : esc(value)}</dd></div>`).join('')}</dl>`;
  }

  function architectureCard(data) {
    const a = data.architecture || {};
    if (a.total_parameters === undefined && a.limitations && a.limitations.length && !a.layers) {
      return card('A · Architecture', a.limitations.map((line) => `<p class="muted">${esc(line)}</p>`).join(''));
    }
    const rows = [
      ['Architecture', a.architecture],
      ['Engine', a.engine],
      ['Method', a.method],
      ['Total parameters', num(a.total_parameters)],
      ['Trainable', num(a.trainable_parameters)],
      ['Trainable %', a.trainable_percent == null ? null : a.trainable_percent + '%'],
      ['Layers', num(a.layers)],
      ['Embedding dim', num(a.embedding_dim || a.hidden_dim)],
      ['Intermediate dim', a.intermediate_dim == null ? null : num(a.intermediate_dim)],
      ['Attention / KV heads', (a.attention_heads || a.kv_heads)
        ? unavailable(a.attention_heads) + ' / ' + unavailable(a.kv_heads) : null],
      ['Vocabulary', num(a.vocab_size)],
      ['Context window', num(a.context_window)],
      ['Precision', a.precision],
      ['Quantization', a.quantization || 'none'],
      ['Weight size', a.weight_size_bytes ? Math.round(a.weight_size_bytes / 1024) + ' KB' : null],
      ['Parameter source', a.source || a.parameter_source],
    ];
    if (a.adapter) {
      rows.push(['LoRA rank', a.adapter.lora_r || a.adapter.rank]);
      rows.push(['LoRA alpha', a.adapter.lora_alpha || a.adapter.alpha]);
      rows.push(['LoRA dropout', a.adapter.lora_dropout || a.adapter.dropout]);
      rows.push(['LoRA target modules', (a.adapter.target_modules || []).join(', ') || null]);
      rows.push(['Adapter parameters (estimate)', num(a.adapter.estimated_adapter_parameters)]);
    }
    return card('A · Architecture', kvRows(rows));
  }

  function trainingCard(data) {
    const t = data.training || {};
    const rows = [
      ['Algorithm', t.algorithm],
      ['Optimizer', t.optimizer || 'engine default'],
      ['Learning rate', t.learning_rate],
      ['Scheduler', t.scheduler || 'engine default'],
      ['Weight decay', t.weight_decay],
      ['Batch size', num(t.batch_size)],
      ['Gradient accumulation', num(t.gradient_accumulation_steps)],
      ['Effective global batch', num(t.effective_global_batch)],
      ['Global batch formula', t.effective_global_batch_formula],
      ['Gradient clipping', t.gradient_clip],
      ['Warmup steps / ratio', t.warmup_steps != null ? t.warmup_steps : t.warmup_ratio],
      ['Total / completed steps', num(t.total_steps) + ' / ' + num(t.completed_steps)],
      ['Epochs', num(t.current_epoch) + ' of ' + num(t.total_epochs)],
      ['Precision', t.precision],
      ['Max sequence length', t.max_seq_length],
      ['Seed', t.seed],
      ['Checkpoint interval', t.checkpoint_interval],
    ];
    return card('B · Training configuration', kvRows(rows));
  }

  function datasetCard(data) {
    const d = data.dataset || {};
    if (!d.available) {
      return card('C · Dataset analytics',
        `<p class="muted">${esc((d.limitations || ['Not available yet.'])[0])}</p>` +
        (d.dataset ? kvRows([['Dataset', d.dataset.name], ['Tokens recorded', num(d.dataset.token_count)]]) : ''));
    }
    const rows = [
      ['Dataset', d.name || d.dataset_id],
      ['File size', d.original_size_bytes ? Math.round(d.original_size_bytes / 1024) + ' KB' : null],
      ['Checksum', d.checksum ? String(d.checksum).slice(0, 16) + '…' : null],
      ['Records (sequences)', num(d.records)],
      ['Tokens', num(d.tokens)],
      ['Train / val / test tokens', [num(d.train_tokens), unavailable(d.validation_tokens), unavailable(d.test_tokens)].join(' / ')],
      ['Average tokens per sample', num(d.avg_tokens_per_sample)],
      ['Min / max sample length', num(d.min_sample_length) + ' / ' + num(d.max_sample_length)],
      ['Tokenization', d.tokenization_status],
      ['Cleaning', d.cleaning_status],
      ['Split', JSON.stringify(d.split || {})],
      ['Languages', Object.keys(d.language_distribution || {}).join(', ')],
    ];
    const notes = (d.limitations || []).map((line) => `<p class="field-help">${esc(line)}</p>`).join('');
    return card('C · Dataset analytics', kvRows(rows) + notes);
  }

  function hardwareCard(data) {
    const h = data.hardware || {};
    if (!h.latest) {
      return card('D · Hardware telemetry',
        `<p class="muted">${esc((h.unavailable || ['No sample captured yet.'])[0])}</p>` +
        kvRows([['API host device', (h.this_api_host || {}).device],
                ['CPU cores', num((h.this_api_host || {}).cpu_count)]]));
    }
    const l = h.latest;
    const rows = [
      ['Device', l.device],
      ['Acceleration', l.acceleration],
      ['GPU', unavailable(l.gpu_name)],
      ['GPU memory used / total', l.gpu_memory_total_mb == null ? null
        : num(l.gpu_memory_used_mb) + ' / ' + num(l.gpu_memory_total_mb) + ' MB'],
      ['GPU utilization', l.gpu_utilization == null ? null : l.gpu_utilization + '%'],
      ['CPU', unavailable(l.cpu_model)],
      ['CPU cores', num(l.cpu_count)],
      ['CPU utilization', l.cpu_utilization == null ? null : l.cpu_utilization.toFixed(1) + '%'],
      ['RAM used / total', l.ram_total_mb == null ? null
        : num(l.ram_used_mb) + ' / ' + num(l.ram_total_mb) + ' MB'],
      ['CPU temperature', l.cpu_temperature_c == null ? null : l.cpu_temperature_c + ' °C'],
      ['Battery', l.battery_percent == null ? null : l.battery_percent + '%'],
      ['Workers', num(l.worker_count)],
      ['Captured', l.captured_at ? ui.timeAgo(l.captured_at) : null],
    ];
    const notes = (h.unavailable || []).slice(0, 6).map((line) => `<p class="field-help">${esc(line)}</p>`).join('');
    return card('D · Hardware telemetry', kvRows(rows) + notes);
  }

  function metricsCard(data) {
    const m = data.metrics || {};
    const rows = [
      ['Status', m.status],
      ['Stage', m.stage],
      ['Progress', m.progress_percent == null ? null : m.progress_percent + '%'],
      ['Steps', num(m.completed_steps) + ' / ' + num(m.total_steps)],
      ['Epoch', unavailable(m.current_epoch) + ' of ' + unavailable(m.total_epochs)],
      ['Processed tokens', num(m.processed_tokens)],
      ['Throughput', m.tokens_per_second == null ? null : m.tokens_per_second.toFixed(1) + ' tokens/s'],
      ['Samples per second', m.samples_per_second == null ? null : m.samples_per_second],
      ['Train loss', m.train_loss == null ? null : Number(m.train_loss).toFixed(4)],
      ['Learning rate', m.learning_rate],
      ['Gradient norm', m.gradient_norm],
      ['ETA', m.eta_seconds == null ? null : ui.formatDuration ? ui.formatDuration(m.eta_seconds) : m.eta_seconds + ' s'],
      ['Elapsed', m.elapsed_seconds == null ? null : Math.round(m.elapsed_seconds) + ' s'],
      ['Last metric', m.last_metric_at ? ui.timeAgo(m.last_metric_at) : null],
    ];
    const notes = [m.eta_note, m.samples_per_second_note].filter(Boolean)
      .map((line) => `<p class="field-help">${esc(line)}</p>`).join('');
    const failure = m.failure_reason ? `<p class="text-error">${esc(m.failure_reason)}</p>` : '';
    return card('E · Live metrics', kvRows(rows) + notes + failure);
  }

  function card(title, body) {
    return `<div class="card"><div class="card-header"><h3>${esc(title)}</h3></div>
      <div class="card-body">${body}</div></div>`;
  }

  function chartsMarkup(data) {
    const series = (data.metrics && data.metrics.series) || [];
    if (!series.length) {
      return card('F · Charts', '<p class="muted">No optimizer step has been recorded yet, so there is nothing to plot.</p>');
    }
    return `<div class="card-grid two">
      ${chartCard('intel-loss-chart', 'Loss')}
      ${chartCard('intel-lr-chart', 'Learning rate')}
    </div>
    <div class="card-grid two">
      ${chartCard('intel-throughput-chart', 'Throughput (tokens/s)')}
      ${card('Throughput note', '<p class="muted">Charts are drawn from the metric rows the worker persisted; a gap means no step was recorded, not zero.</p>')}
    </div>`;
  }

  function chartCard(id, title) {
    return `<div class="card"><div class="card-header"><h3>${esc(title)}</h3></div>
      <div class="card-body"><canvas id="${id}" height="180"></canvas></div></div>`;
  }

  function drawCharts(data) {
    const series = (data.metrics && data.metrics.series) || [];
    if (!series.length || !window.charts || typeof window.charts.createLineChart !== 'function') return;
    const labels = series.map((point) => point.step);
    try {
      window.charts.createLineChart('intel-loss-chart', labels, [{
        label: 'loss', data: series.map((point) => point.loss),
        borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.15)', tension: 0.3,
      }]);
      window.charts.createLineChart('intel-lr-chart', labels, [{
        label: 'learning rate', data: series.map((point) => point.learning_rate),
        borderColor: '#22d3ee', backgroundColor: 'rgba(34,211,238,0.15)', tension: 0.3,
      }]);
      window.charts.createLineChart('intel-throughput-chart', labels, [{
        label: 'tokens/s', data: series.map((point) => point.tokens_per_second),
        borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.15)', tension: 0.3,
      }]);
    } catch (err) {
      // A chart library problem must not break the page's numbers.
      if (window.CORPUS_APP) window.CORPUS_APP.recordError('intelligence.charts', err.message, err);
    }
  }

  async function render() {
    const root = container();
    if (!root) return;
    if (!state.getUser()) {
      root.innerHTML = ui.emptyState({ icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to see training telemetry.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt' });
      return;
    }
    if (!STATE.jobs.length && !STATE.data) {
      root.innerHTML = '<div class="page-header"><div class="page-header-copy"><h1 class="section-title">Training intelligence</h1></div></div>' + ui.skeletonCards(3);
      await load();
    }
    const data = STATE.data;
    root.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-chart-line"></i> Training intelligence</span>
          <h1 class="section-title">What the training run is really doing</h1>
          <p class="section-subtitle">Architecture, configuration, dataset, hardware and step metrics — all persisted by the
          engine. Values it could not measure are shown as Unavailable.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="intelligence.refresh(this)"><i class="fas fa-rotate"></i> Refresh</button>
        </div>
      </div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      <div class="inline-form">
        <label>Training job
          <select onchange="intelligence.selectJob(this.value)">
            ${STATE.jobs.map((job) => `<option value="${esc(job.id)}" ${job.id === STATE.jobId ? 'selected' : ''}>
              ${esc(job.id)} · ${esc(job.status || 'unknown')} · ${esc(job.engine || 'pytorch')}</option>`).join('')
              || '<option value="">No training jobs yet</option>'}
          </select>
        </label>
      </div>
      ${data ? `
        <div class="callout"><i class="fas fa-circle-info"></i>
          <p>${esc(data.independent_status_note || '')}</p></div>
        <div class="card-grid two">
          ${architectureCard(data)}
          ${trainingCard(data)}
        </div>
        <div class="card-grid two">
          ${datasetCard(data)}
          ${hardwareCard(data)}
        </div>
        ${metricsCard(data)}
        ${chartsMarkup(data)}
      ` : ui.emptyState({ icon: 'fa-flask', title: 'No training run selected',
        text: 'Start a training job to see its architecture, hardware and live metrics.' })}`;
    if (data) drawCharts(data);
    manageTimer();
  }

  function manageTimer() {
    stopTimer();
    const status = STATE.data && STATE.data.metrics && STATE.data.metrics.status;
    if (['running', 'queued', 'preparing', 'loading_model', 'paused'].includes(status)) {
      STATE.timer = setInterval(async () => {
        if (!document.getElementById('intel-loss-chart') && !document.querySelector('#page-container h1')) {
          stopTimer();
          return;
        }
        await load();
        if (document.getElementById('page-container')) await render();
      }, 7000);
    }
  }

  function selectJob(jobId) {
    STATE.jobId = jobId;
    STATE.data = null;
    render();
  }

  async function refresh(button) {
    if (button) ui.setButtonLoading(button, true, 'Refreshing…');
    try {
      STATE.jobs = [];
      await load();
      await render();
    } finally {
      if (button) ui.setButtonLoading(button, false);
    }
  }

  function dispose() { stopTimer(); }

  return {
    render,
    dispose,
    refresh,
    selectJob,
    // exposed for tests
    _state: () => ({ jobs: STATE.jobs, jobId: STATE.jobId, data: STATE.data, error: STATE.error }),
  };
})();
