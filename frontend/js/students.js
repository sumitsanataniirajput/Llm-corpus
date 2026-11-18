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

  function architectureTable(architecture) {
    if (!architecture) return '';
    const rows = [
      ['Architecture', architecture.architecture],
      ['Architecture version', architecture.architecture_version],
      ['Engine', architecture.engine],
      ['Total parameters', num(architecture.total_parameters)],
      ['Trainable parameters', num(architecture.trainable_parameters)],
      ['Embedding / hidden dim', num(architecture.embedding_dim || architecture.hidden_dim)],
      ['Intermediate dim', num(architecture.intermediate_dim)],
      ['Layers', num(architecture.layers)],
      ['Attention heads', num(architecture.attention_heads)],
      ['KV heads', num(architecture.kv_heads)],
      ['Vocabulary', num(architecture.vocab_size)],
      ['Context window', num(architecture.context_window)],
      ['Precision', architecture.precision],
      ['Quantization', architecture.quantization || 'none'],
      ['Weight size', architecture.weight_size_bytes ? Math.round(architecture.weight_size_bytes / 1024) + ' KB' : 'Unavailable'],
      ['Tokenizer', architecture.tokenizer],
      ['Parameter source', architecture.source || architecture.parameter_source],
    ];
    return `<table class="table compact"><tbody>${rows.map(([label, value]) => `
      <tr><th>${esc(label)}</th><td>${value === null || value === undefined || value === ''
        ? 'Unavailable' : esc(value)}</td></tr>`).join('')}</tbody></table>`;
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
        <h2 class="section-heading">Inspected architecture</h2>
        ${architectureTable(inspection.architecture)}
        <div class="callout"><i class="fas fa-circle-info"></i>
          <p>${esc((inspection.compatibility && inspection.compatibility.reason) || '')}</p></div>
      </div>
      <div class="section-block">
        <h2 class="section-heading">Training methods</h2>
        <table class="table">
          <thead><tr><th>Method</th><th>Status</th><th>Why</th></tr></thead>
          <tbody>${Object.entries(system.methods || {}).map(([key, meta]) =>
            methodRow(key, meta, (inspection.methods || {})[key] || corpusAvailability[key])).join('')}</tbody>
        </table>
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
          <label>Learning rate <input id="st-lr" type="number" step="0.00001" min="0.000001" value="0.0005"></label>
          <label>Epochs <input id="st-epochs" type="number" min="1" max="50" value="1"></label>
          <label>Batch size <input id="st-batch" type="number" min="1" value="1"></label>
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
          <label>Repository ID <input id="st-hf-repo" placeholder="e.g. organization/model-id">
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
    _architectureTable: architectureTable,
    _methodRow: methodRow,
  };
})();
