/* ========================================
   CORPUS ULTIMATE — Student Model Studio

   Route: #/student-models

   What this page refuses to do:
     * claim a method is supported when the library or device is missing;
     * report a parameter count it did not measure (CORPUS models are built and
       counted; Hugging Face models report "not measured" until the weights are
       actually loaded);
     * pretend a custom CORPUS checkpoint can be loaded from HF weights (or the
       other way round).
   ======================================== */

window.students = (function () {
  'use strict';

  const STATE = {
    system: null,
    models: [],
    configs: [],
    inspection: null,
    error: null,
    notice: null,
    busy: false,
  };

  function esc(value) { return ui.escapeHtml(value == null ? '' : String(value)); }
  function num(value) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Unavailable';
    return n.toLocaleString();
  }
  function container() { return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null; }

  async function load() {
    try {
      const token = await state.getAccessToken();
      const [system, models, configs] = await Promise.all([
        window.CORPUS_API.getStudentSystem(token),
        window.CORPUS_API.listStudentModels(token),
        window.CORPUS_API.listStudentConfigs(token),
      ]);
      STATE.system = system || null;
      STATE.models = (models && models.models) || [];
      STATE.configs = (configs && configs.configs) || [];
      STATE.error = null;
    } catch (err) {
      STATE.error = (err && err.message) || 'Could not load the student studio.';
    }
  }

  function methodRow(key, meta, availability) {
    const status = availability && availability.available;
    const reasons = (availability && availability.reasons) || [];
    return `<tr>
      <td><strong>${esc(meta.label || key)}</strong><div class="muted">${esc(meta.description || '')}</div></td>
      <td>${status
        ? '<span class="status-badge online"><i class="fas fa-circle"></i> Available</span>'
        : '<span class="status-badge offline"><i class="fas fa-circle"></i> Unavailable</span>'}</td>
      <td>${reasons.length ? reasons.map((reason) => `<div class="muted">${esc(reason)}</div>`).join('') : '—'}</td>
    </tr>`;
  }

  function libraryList(libraries) {
    if (!libraries) return '';
    const rows = [
      ['torch', libraries.torch], ['transformers', libraries.transformers],
      ['peft', libraries.peft], ['accelerate', libraries.accelerate],
      ['bitsandbytes', libraries.bitsandbytes],
    ];
    return `<dl class="kv-list">${rows.map(([name, version]) => `
      <div><dt>${esc(name)}</dt><dd>${version ? esc(version) : 'not installed'}</dd></div>`).join('')}
      <div><dt>CUDA</dt><dd>${libraries.cuda_available
        ? esc((libraries.cuda_devices || []).join(', ') || 'available')
        : 'not available in this process'}</dd></div>
      <div><dt>CPU cores</dt><dd>${num(libraries.cpu_count)}</dd></div>
    </dl>`;
  }

  // ---- Inspection console ------------------------------------------------
  // Renders exactly what the backend measured. A missing field renders as
  // "Not reported" — never a guessed or hardcoded value.

  function reported(value) {
    return !(value === null || value === undefined || value === '');
  }

  function specValue(value, options = {}) {
    if (!reported(value)) return '<span class="spec-na">Not reported</span>';
    if (options.numeric) return `<span class="mono">${esc(num(value))}</span>`;
    if (options.mono) return `<span class="mono">${esc(value)}</span>`;
    return esc(value);
  }

  function specRow(label, value, options = {}) {
    return `<div class="spec-row"><dt>${esc(label)}</dt><dd>${specValue(value, options)}</dd></div>`;
  }

  function specGroup(title, icon, rows) {
    const body = rows.filter(Boolean).join('');
    if (!body) return '';
    return `<section class="spec-group" aria-label="${esc(title)}">
      <h3 class="spec-group-title"><i class="fas ${esc(icon)}"></i> ${esc(title)}</h3>
      <dl class="spec-list">${body}</dl>
    </section>`;
  }

  function overviewCard(label, value, options = {}) {
    return `<div class="stat-card spec-stat">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value spec-stat-value">${specValue(value, options)}</div>
    </div>`;
  }

  function formatPercent(value) {
    if (!reported(value)) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return (Math.round(n * 10) / 10) + '%';
  }

  function formatWeightSize(bytes) {
    if (!reported(bytes)) return null;
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return null;
    return window.CORPUS_UTILS && typeof CORPUS_UTILS.formatBytes === 'function'
      ? CORPUS_UTILS.formatBytes(n) : num(n) + ' B';
  }

  function parameterBreakdown(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return '';
    const entries = Object.entries(breakdown)
      .filter(([, count]) => Number.isFinite(Number(count)))
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (!entries.length) return '';
    return `<details class="spec-advanced">
      <summary>Parameter breakdown by tensor (${entries.length})</summary>
      <div class="param-table" role="table" aria-label="Parameter breakdown">
        ${entries.map(([name, count]) => `<div class="param-row" role="row">
          <span class="param-name mono" role="cell">${esc(name)}</span>
          <span class="param-count mono" role="cell">${esc(num(count))}</span>
        </div>`).join('')}
      </div>
    </details>`;
  }

  function inspectionConsole(inspection) {
    const arch = inspection && inspection.architecture ? inspection.architecture : {};
    const modelRow = (STATE.models || []).find((m) => m && m.id === inspection.model_id);
    const trainablePct = formatPercent(arch.trainable_percent);
    const overview = [
      overviewCard('Model', inspection.name),
      modelRow && reported(modelRow.status) ? overviewCard('Status', modelRow.status) : '',
      overviewCard('Architecture', arch.architecture, { mono: true }),
      overviewCard('Engine', arch.engine),
      overviewCard('Total parameters', arch.total_parameters, { numeric: true }),
      overviewCard('Trainable parameters', arch.trainable_parameters, { numeric: true }),
      // The backend reports a percentage only when it actually counted trainable
      // weights (CORPUS). A config-only HF inspection omits the card entirely.
      trainablePct !== null ? overviewCard('Trainable', trainablePct) : '',
      overviewCard('Layers', arch.layers, { numeric: true }),
      overviewCard('Embedding dim', arch.embedding_dim || arch.hidden_dim, { numeric: true }),
      overviewCard('Context window', arch.context_window, { numeric: true }),
    ].filter(Boolean).join('');

    const groups = [
      specGroup('Identity', 'fa-fingerprint', [
        specRow('Architecture', arch.architecture, { mono: true }),
        specRow('Architecture version', arch.architecture_version, { mono: true }),
        specRow('Engine', arch.engine),
        specRow('Base source', inspection.base_source),
        reported(inspection.base_ref) ? specRow('Base reference', inspection.base_ref, { mono: true }) : '',
        reported(inspection.model_id) ? specRow('Model ID', inspection.model_id, { mono: true }) : '',
      ]),
      specGroup('Dimensions', 'fa-ruler-combined', [
        specRow('Hidden / embedding dim', arch.embedding_dim || arch.hidden_dim, { numeric: true }),
        specRow('Intermediate dim', arch.intermediate_dim, { numeric: true }),
        specRow('Layers', arch.layers, { numeric: true }),
        specRow('Attention heads', arch.attention_heads, { numeric: true }),
        specRow('KV heads', arch.kv_heads, { numeric: true }),
        specRow('Vocabulary size', arch.vocab_size, { numeric: true }),
        specRow('Context window', arch.context_window, { numeric: true }),
        specRow('Dropout', arch.dropout),
      ]),
      specGroup('Parameters & weights', 'fa-weight-hanging', [
        specRow('Total parameters', arch.total_parameters, { numeric: true }),
        specRow('Trainable parameters', arch.trainable_parameters, { numeric: true }),
        specRow('Frozen parameters', arch.frozen_parameters, { numeric: true }),
        trainablePct !== null ? specRow('Trainable share', trainablePct) : '',
        specRow('Precision', arch.precision, { mono: true }),
        specRow('Quantization', reported(arch.quantization) ? arch.quantization : 'none'),
        specRow('Weight size', formatWeightSize(arch.weight_size_bytes), { mono: true }),
        specRow('Parameter source', arch.parameter_source || arch.source),
      ]),
      specGroup('Tokenizer', 'fa-font', [
        specRow('Tokenizer', arch.tokenizer, { mono: true }),
        specRow('Tokenizer reference', arch.tokenizer_version, { mono: true }),
        specRow('Vocabulary size', arch.vocab_size, { numeric: true }),
      ]),
    ].filter(Boolean).join('');

    return `
      <div class="stats-grid spec-overview">${overview}</div>
      ${reported(arch.load_error) ? `<div class="alert alert-warning"><i class="fas fa-triangle-exclamation"></i>
        <div>${esc(arch.load_error)}</div></div>` : ''}
      <div class="spec-groups">${groups}</div>
      ${parameterBreakdown(arch.parameter_breakdown)}`;
  }

  function configCard(config) {
    const method = (config.capability && config.capability.method_catalogue && config.capability.method_catalogue[config.method]) || {};
    return `<div class="card">
      <div class="card-header"><div><h3>${esc(method.label || config.method)}</h3>
        <span class="muted">${esc(config.base_source)}${config.base_ref ? ' · ' + esc(config.base_ref) : ''}</span></div>
        <button class="btn btn-sm btn-outline" type="button"
          onclick="students.removeConfig('${esc(config.id)}', this)"><i class="fas fa-trash"></i></button></div>
      <div class="card-body">
        <dl class="kv-list">
          <div><dt>Parameters</dt><dd>${num(config.architecture && config.architecture.total_parameters)}</dd></div>
          <div><dt>Learning rate</dt><dd>${esc(config.training_config && config.training_config.learning_rate)}</dd></div>
          <div><dt>Epochs</dt><dd>${esc(config.training_config && config.training_config.epochs)}</dd></div>
          <div><dt>Checked</dt><dd>${config.capability && config.capability.checked_at ? ui.timeAgo(config.capability.checked_at) : '—'}</dd></div>
        </dl>
      </div>
    </div>`;
  }

  async function render() {
    const root = container();
    if (!root) return;
    if (!state.getUser()) {
      root.innerHTML = ui.emptyState({ icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to configure a student model.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt' });
      return;
    }
    if (!STATE.system) {
      root.innerHTML = '<div class="page-header"><div class="page-header-copy"><h1 class="section-title">Student model studio</h1></div></div>' + ui.skeletonCards(2);
      await load();
    }
    const system = STATE.system || { libraries: {}, methods: {}, availability: {} };
    const corpusAvailability = (system.availability && system.availability.corpus) || {};
    const hfAvailability = (system.availability && system.availability.huggingface) || {};
    const inspection = STATE.inspection;

    root.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-graduation-cap"></i> Student model studio</span>
          <h1 class="section-title">Which model learns, and how</h1>
          <p class="section-subtitle">Architecture and method availability are read from the loaded model and the
          installed libraries — never assumed.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="students.refresh(this)"><i class="fas fa-rotate"></i> Refresh</button>
        </div>
      </div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      ${STATE.notice ? `<div class="alert alert-success"><i class="fas fa-circle-info"></i><div>${esc(STATE.notice)}</div></div>` : ''}
      <div class="card-grid two">
        <div class="card"><div class="card-header"><h3>Environment</h3></div>
          <div class="card-body">${libraryList(system.libraries)}
            <p class="field-help">QLoRA needs peft + bitsandbytes + a CUDA device. If any is missing it is reported as unavailable.</p>
          </div></div>
        <div class="card"><div class="card-header"><h3>CORPUS models</h3></div>
          <div class="card-body">
            ${STATE.models.length ? `<div class="inline-form">
              <select id="st-model">${STATE.models.map((model) => `<option value="${esc(model.id)}">${esc(model.name)}
                · ${esc(model.status)}${model.checkpoints ? ' · ' + model.checkpoints + ' checkpoint(s)' : ''}</option>`).join('')}</select>
              <button class="btn btn-sm btn-primary" type="button" onclick="students.inspect(this)">
                <i class="fas fa-microscope"></i> Inspect
              </button>
            </div>` : ui.emptyState({ icon: 'fa-cube', title: 'No CORPUS model yet',
              text: 'Create a model on the Models page first.', compact: true })}
            <p class="field-help">A CORPUS checkpoint is a custom transformer state dict; it cannot be loaded from, or exported to, arbitrary Hugging Face weights.</p>
          </div></div>
      </div>

      ${inspection ? `
      <div class="section-block">
        <h2 class="section-heading">Inspected model</h2>
        ${inspectionConsole(inspection)}
        ${(inspection.compatibility && inspection.compatibility.reason) ? `
        <div class="callout"><i class="fas fa-circle-info"></i>
          <p>${esc(inspection.compatibility.reason)}</p></div>` : ''}
      </div>
      <div class="section-block">
        <h2 class="section-heading">Training methods</h2>
        <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Method</th><th>Status</th><th>Why</th></tr></thead>
          <tbody>${Object.entries(system.methods || {}).map(([key, meta]) =>
            methodRow(key, meta, (inspection.methods || {})[key] || corpusAvailability[key])).join('')}</tbody>
        </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Create a training configuration</h3></div>
        <div class="card-body form-grid">
          <label>Method
            <select id="st-method">${Object.entries(system.methods || {}).map(([key, meta]) => {
              const availability = (inspection.methods || {})[key] || {};
              return `<option value="${esc(key)}" ${availability.available ? '' : 'disabled'}>${esc(meta.label)}
                ${availability.available ? '' : ' — unavailable'}</option>`;
            }).join('')}</select>
          </label>
          <label>Learning rate <input id="st-lr" type="number" step="0.00001" min="0.000001" value="0.0005" inputmode="decimal" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
          <label>Epochs <input id="st-epochs" type="number" min="1" max="50" value="1" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
          <label>Batch size <input id="st-batch" type="number" min="1" value="1" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
          <button class="btn btn-primary" type="button" onclick="students.saveConfig(this)">
            <i class="fas fa-floppy-disk"></i> Save configuration
          </button>
        </div>
        <div class="card-footer"><p class="field-help">Saving stores the inspected architecture, the method and the
        availability decision that was true at this moment, so the training run can explain itself later.</p></div>
      </div>` : ''}

      <div class="section-block">
        <h2 class="section-heading">Saved configurations</h2>
        ${STATE.configs.length ? `<div class="card-grid">${STATE.configs.map(configCard).join('')}</div>`
          : ui.emptyState({ icon: 'fa-sliders', title: 'No student configuration yet',
            text: 'Inspect a model and save a configuration to prepare a student training run.' })}
      </div>

      <div class="card">
        <div class="card-header"><h3>Hugging Face base model (optional)</h3></div>
        <div class="card-body form-grid">
          <label>Repository ID <input id="st-hf-repo" placeholder="e.g. organization/model-id" inputmode="text" enterkeyhint="done" autocapitalize="words" spellcheck="true">
            <span class="field-help">The backend reads the real config from the Hub. If it cannot, you get the error — not a guess.</span>
          </label>
          <label class="checkbox-row"><input type="checkbox" id="st-hf-load"> Load the weights to count parameters (slow, memory heavy)</label>
          <button class="btn btn-outline" type="button" onclick="students.inspectHf(this)">
            <i class="fas fa-cloud-arrow-down"></i> Inspect Hugging Face model
          </button>
        </div>
      </div>`;
  }

  async function inspect(button) {
    const modelId = (document.getElementById('st-model') || {}).value;
    if (!modelId) return;
    ui.setButtonLoading(button, true, 'Inspecting…');
    try {
      const token = await state.getAccessToken();
      STATE.inspection = await window.CORPUS_API.inspectStudentModel(
        { base_source: 'corpus', model_id: modelId }, token);
      STATE.notice = null;
      await render();
    } catch (err) {
      STATE.notice = null;
      STATE.error = (err && err.message) || 'The model could not be inspected.';
      await render();
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function inspectHf(button) {
    const repo = (document.getElementById('st-hf-repo') || {}).value || '';
    if (!repo.trim()) { ui.toast('Enter a Hugging Face repository ID.', 'error'); return; }
    const loadWeights = !!(document.getElementById('st-hf-load') || {}).checked;
    ui.setButtonLoading(button, true, 'Inspecting…');
    try {
      const token = await state.getAccessToken();
      STATE.inspection = await window.CORPUS_API.inspectStudentModel(
        { base_source: 'huggingface', base_ref: repo.trim(), load_weights: loadWeights }, token);
      STATE.error = null;
      await render();
    } catch (err) {
      STATE.error = (err && err.message) || 'The Hugging Face model could not be inspected.';
      await render();
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function saveConfig(button) {
    if (!STATE.inspection) return;
    const method = (document.getElementById('st-method') || {}).value;
    if (!method) return;
    const payload = {
      base_source: STATE.inspection.base_source,
      model_id: STATE.inspection.model_id || undefined,
      base_ref: STATE.inspection.base_ref || undefined,
      method,
      training_config: {
        learning_rate: Number((document.getElementById('st-lr') || {}).value || 0.0005),
        epochs: Number((document.getElementById('st-epochs') || {}).value || 1),
        batch_size: Number((document.getElementById('st-batch') || {}).value || 1),
        gradient_accumulation_steps: 1,
      },
    };
    if (method === 'lora' || method === 'qlora') {
      payload.method_config = { lora_r: 8, lora_alpha: 16, lora_dropout: 0.05,
                                target_modules: ['q_proj', 'v_proj'] };
    }
    ui.setButtonLoading(button, true, 'Saving…');
    try {
      const token = await state.getAccessToken();
      const config = await window.CORPUS_API.createStudentConfig(payload, token);
      STATE.notice = `Configuration saved (${config.method}).`;
      await load();
      await render();
      ui.toast('Student configuration saved.', 'success');
    } catch (err) {
      STATE.error = (err && err.message) || 'The configuration was refused.';
      await render();
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function removeConfig(configId, button) {
    ui.setButtonLoading(button, true);
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.deleteStudentConfig(configId, token);
      await load();
      await render();
    } catch (err) {
      ui.toast((err && err.message) || 'Could not delete the configuration.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function refresh(button) {
    if (button) ui.setButtonLoading(button, true, 'Refreshing…');
    try {
      await load();
      await render();
    } finally {
      if (button) ui.setButtonLoading(button, false);
    }
  }

  return {
    render,
    refresh,
    inspect,
    inspectHf,
    saveConfig,
    removeConfig,
    // exposed for tests
    _state: () => ({ system: STATE.system, models: STATE.models, configs: STATE.configs,
                     inspection: STATE.inspection, error: STATE.error }),
    _inspectionConsole: inspectionConsole,
    _methodRow: methodRow,
  };
})();
