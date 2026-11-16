/* ========================================
   CORPUS ULTIMATE — Models page

   Model cards only display values that exist on the model record. The
   parameter count is computed deterministically from the stored architecture
   (and is labelled as computed); nothing is invented.
   ======================================== */

window.models = (function () {
  'use strict';

  let editingModelId = null;
  let paramListenersReady = false;
  const deletingIds = new Set();

  const ARCH_FIELDS = ['m-vocab', 'm-context', 'm-dmodel', 'm-layers', 'm-heads', 'm-dff', 'm-dropout'];

  function esc(value) {
    return ui.escapeHtml(value == null ? '' : String(value));
  }

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Please sign in to create and manage models.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-cube"></i> Model library</span>
          <h1 class="section-title">Models</h1>
          <p class="section-subtitle">Create, inspect and train CORPUS language models. Architecture values come from each saved model record.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="models.loadModels()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
          <button class="btn btn-primary" type="button" onclick="models.openCreateModal()">
            <i class="fas fa-plus"></i> Create model
          </button>
        </div>
      </div>

      <div class="model-library" id="model-library">
        ${ui.skeletonCards(2)}
      </div>

      <div id="model-create-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-backdrop" onclick="models.closeCreateModal()"></div>
        <div class="modal-content" style="max-width:720px;">
          <button class="modal-close" type="button" aria-label="Close" onclick="models.closeCreateModal()">&times;</button>
          <div class="modal-header">
            <div>
              <h3 id="modal-title">Create model</h3>
              <p class="card-subtitle">A decoder-only transformer. Defaults are CPU-friendly.</p>
            </div>
          </div>
          <form id="model-form" onsubmit="return models.handleCreateSubmit(event)">
            <section class="form-section">
              <h3>Identity</h3>
              <p>Name the model so you can recognise it in the training center.</p>
              <div class="input-field" id="m-name-field">
                <label for="m-name">Model name <span aria-hidden="true">*</span></label>
                <input type="text" id="m-name" placeholder="e.g. Wiki small — run 3" maxlength="80" required autocomplete="off">
                <span class="field-hint">Shown in the model list and training history.</span>
              </div>
            </section>

            <section class="form-section">
              <h3>Architecture</h3>
              <p>These values define the transformer that the backend builds and trains.</p>
              <div class="form-grid">
                <div class="input-field">
                  <label for="m-vocab">Vocabulary size</label>
                  <input type="number" id="m-vocab" value="5000" min="100" step="1" required inputmode="numeric">
                  <span class="field-hint">Tokens the tokenizer can learn.</span>
                </div>
                <div class="input-field">
                  <label for="m-context">Context length</label>
                  <input type="number" id="m-context" value="256" min="16" step="1" required inputmode="numeric">
                  <span class="field-hint">Tokens per training sequence.</span>
                </div>
                <div class="input-field">
                  <label for="m-dmodel">Embedding dimension</label>
                  <input type="number" id="m-dmodel" value="256" min="16" step="1" required inputmode="numeric">
                  <span class="field-hint">Model width (d_model).</span>
                </div>
                <div class="input-field">
                  <label for="m-layers">Transformer layers</label>
                  <input type="number" id="m-layers" value="4" min="1" step="1" required inputmode="numeric">
                  <span class="field-hint">Number of decoder blocks.</span>
                </div>
                <div class="input-field">
                  <label for="m-heads">Attention heads</label>
                  <input type="number" id="m-heads" value="4" min="1" step="1" required inputmode="numeric">
                  <span class="field-hint">Embedding dimension must divide evenly.</span>
                </div>
                <div class="input-field">
                  <label for="m-dff">Feed-forward dimension</label>
                  <input type="number" id="m-dff" value="1024" min="32" step="1" required inputmode="numeric">
                  <span class="field-hint">Hidden width of each block.</span>
                </div>
              </div>

              <details class="accordion" style="margin-top:var(--space-3);">
                <summary>Advanced</summary>
                <div class="accordion-body">
                  <div class="input-field">
                    <label for="m-dropout">Dropout</label>
                    <input type="number" id="m-dropout" value="0.1" min="0" max="0.9" step="0.05" inputmode="decimal">
                    <span class="field-hint">Regularisation applied during training (0–0.9).</span>
                  </div>
                </div>
              </details>

              <div class="param-readout">
                <span class="param-label">Computed parameters</span>
                <span class="param-value" id="m-param-display">—</span>
              </div>
              <div class="progress-container" aria-hidden="true">
                <div class="progress-bar" id="m-param-bar"></div>
              </div>
              <p class="field-hint">Computed from the architecture above; the backend may clamp values for CPU safety at training time.</p>
            </section>

            <div class="form-alert error hidden" id="m-form-error" role="alert"></div>

            <div class="form-actions">
              <button class="btn btn-outline" type="button" onclick="models.closeCreateModal()">Cancel</button>
              <button class="btn btn-primary" type="submit"><i class="fas fa-plus"></i> Create model</button>
            </div>
          </form>
        </div>
      </div>
    `;

    bindParamListeners();
    updateParamDisplay();
    await loadModels();
  }

  async function loadModels() {
    const container = document.getElementById('model-library');
    if (container) container.innerHTML = ui.skeletonCards(2);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listModels(token);
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.models) ? data.models : []);
      state.setModels(list);
      renderModelList();
    } catch (err) {
      state.setModels([]);
      if (!container) {
        ui.toast(err.message || 'Failed to load models', 'error');
        return;
      }
      const isNetworkErr = err.networkError === true;
      const isTimeout = err.code === 'TIMEOUT';
      container.innerHTML = ui.emptyState({
        icon: isNetworkErr || isTimeout ? 'fa-wifi' : 'fa-triangle-exclamation',
        title: isNetworkErr ? 'Backend unreachable' : isTimeout ? 'Request timed out' : 'Failed to load models',
        text: isNetworkErr
          ? 'Cannot reach ' + ((window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_BASE_URL) || 'the backend') + '. Check the API URL in frontend/js/config.js and that the server is running.'
          : isTimeout
            ? 'The backend took too long to respond. Try again.'
            : (err.message || 'An error occurred while loading models.'),
        actionLabel: 'Retry',
        actionOnclick: 'models.loadModels()',
        actionIcon: 'fa-rotate',
      });
    }
  }

  function renderModelList() {
    const container = document.getElementById('model-library');
    if (!container) return;
    const modelList = state.getModels() || [];

    if (!modelList.length) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-cube',
        title: 'No models yet',
        text: 'Create your first model configuration, then train it on one of your datasets.',
        actionLabel: 'Create model',
        actionOnclick: 'models.openCreateModal()',
        actionIcon: 'fa-plus',
      });
      return;
    }

    container.innerHTML = modelList.map(model => {
      const config = model.config || {};
      const hasArch = ['n_layers', 'n_heads', 'd_model', 'vocab_size', 'context_length'].some(key => config[key] != null);
      const params = hasArch ? CORPUS_UTILS.calculateParameters(config) : null;
      const meta = [];
      if (config.n_layers) meta.push({ icon: 'fa-layer-group', text: config.n_layers + ' layers' });
      if (config.n_heads) meta.push({ icon: 'fa-heading', text: config.n_heads + ' heads' });
      if (config.d_model) meta.push({ icon: 'fa-memory', text: config.d_model + ' dim' });
      if (config.vocab_size) meta.push({ icon: 'fa-font', text: CORPUS_UTILS.formatNumber(config.vocab_size) + ' vocab' });
      if (config.context_length) meta.push({ icon: 'fa-text-width', text: CORPUS_UTILS.formatNumber(config.context_length) + ' ctx' });
      if (params) meta.push({ icon: 'fa-hashtag', text: CORPUS_UTILS.formatNumber(params) });
      return `
        <article class="model-card" data-aos="fade-up">
          <div class="model-header">
            <div class="model-info">
              <h3 title="${esc(model.name || 'Unnamed')}">${esc(model.name || 'Unnamed model')}</h3>
              <div class="model-id" title="${esc(model.id)}">${esc(model.id)}</div>
            </div>
            ${ui.statusBadge(model.status || 'idle')}
          </div>

          <div class="model-meta">
            ${meta.length
              ? meta.map(item => `<span class="model-meta-item"><i class="fas ${item.icon}"></i> ${esc(item.text)}</span>`).join('')
              : '<span class="model-meta-item"><i class="fas fa-circle-info"></i> No architecture recorded</span>'}
          </div>

          <div class="model-config">
            <h4>Configuration</h4>
            ${hasArch ? ui.modelConfigSummary(config) : '<p class="field-hint" style="margin:0;">This record has no architecture details.</p>'}
          </div>

          <dl class="kv-grid" style="margin-bottom:var(--space-3);">
            <div><dt>Training</dt><dd>${esc(model.status ? 'Model status: ' + model.status : 'No training recorded')}</dd></div>
            <div><dt>Updated</dt><dd>${esc(CORPUS_UTILS.formatDate(model.updated_at || model.created_at))}</dd></div>
            <div><dt>Version</dt><dd>${esc(model.version || '—')}</dd></div>
          </dl>

          <div class="model-actions">
            <button class="btn btn-outline btn-sm" type="button" onclick="models.openModel('${esc(model.id)}')">
              <i class="fas fa-eye"></i> Inspect
            </button>
            <button class="btn btn-outline btn-sm" type="button" onclick="models.trainModel('${esc(model.id)}')" title="Open the Training Center with this model">
              <i class="fas fa-play"></i> Train
            </button>
            <button class="btn btn-outline btn-sm" type="button" onclick="models.cloneModel('${esc(model.id)}')">
              <i class="fas fa-copy"></i> Clone
            </button>
            <button class="btn btn-danger btn-sm" type="button" data-delete-model="${esc(model.id)}" aria-label="Delete ${esc(model.name || model.id)}" title="Delete model">
              <i class="fas fa-trash"></i> <span>Delete</span>
            </button>
          </div>
        </article>
      `;
    }).join('');

    container.querySelectorAll('[data-delete-model]').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteModel(btn.getAttribute('data-delete-model'));
      });
    });
  }

  function openCreateModal() {
    const modal = document.getElementById('model-create-modal');
    if (!modal) return;
    editingModelId = null;
    const form = document.getElementById('model-form');
    if (form) form.reset();
    const name = document.getElementById('m-name');
    if (name) name.value = '';
    // restore documented defaults after reset()
    const defaults = (window.CORPUS_CONFIG && window.CORPUS_CONFIG.DEFAULT_MODEL_CONFIG) || {};
    const map = {
      'm-vocab': defaults.vocab_size || 5000,
      'm-context': defaults.context_length || 256,
      'm-dmodel': defaults.d_model || 256,
      'm-layers': defaults.n_layers || 4,
      'm-heads': defaults.n_heads || 4,
      'm-dff': defaults.d_ff || 1024,
      'm-dropout': defaults.dropout != null ? defaults.dropout : 0.1,
    };
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = map[id];
    });
    clearFormError();
    updateParamDisplay();
    modal.classList.remove('hidden');
    setTimeout(() => { if (name) name.focus(); }, 50);
  }

  function closeCreateModal() {
    const modal = document.getElementById('model-create-modal');
    if (modal) modal.classList.add('hidden');
    editingModelId = null;
  }

  function readConfig() {
    const num = (id, fallback) => {
      const el = document.getElementById(id);
      const value = el ? parseFloat(el.value) : NaN;
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      vocab_size: num('m-vocab', 5000),
      context_length: num('m-context', 256),
      d_model: num('m-dmodel', 256),
      n_layers: num('m-layers', 4),
      n_heads: num('m-heads', 4),
      d_ff: num('m-dff', 1024),
      dropout: num('m-dropout', 0.1),
    };
  }

  function updateParamDisplay() {
    const display = document.getElementById('m-param-display');
    const bar = document.getElementById('m-param-bar');
    if (!display) return;
    const config = readConfig();
    const params = CORPUS_UTILS.calculateParameters(config);
    display.textContent = params > 0 ? CORPUS_UTILS.formatNumber(params) + ' parameters' : '—';
    if (bar) {
      const pct = Math.min(100, (params / 10000000) * 100);
      bar.style.width = pct + '%';
      bar.classList.toggle('is-error', params > 50000000);
    }
  }

  function bindParamListeners() {
    const form = document.getElementById('model-form');
    if (!form || paramListenersReady) {
      if (form && !paramListenersReady) {
        form.addEventListener('input', (event) => {
          if (ARCH_FIELDS.indexOf(event.target.id) !== -1) updateParamDisplay();
        });
        paramListenersReady = true;
      }
      return;
    }
    form.addEventListener('input', (event) => {
      if (ARCH_FIELDS.indexOf(event.target.id) !== -1) updateParamDisplay();
    });
    paramListenersReady = true;
  }

  function showFormError(message) {
    const box = document.getElementById('m-form-error');
    if (!box) return;
    box.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span>' + esc(message) + '</span>';
    box.classList.remove('hidden');
  }

  function clearFormError() {
    const box = document.getElementById('m-form-error');
    if (!box) return;
    box.textContent = '';
    box.classList.add('hidden');
    const nameField = document.getElementById('m-name-field');
    if (nameField) nameField.classList.remove('is-invalid');
  }

  async function handleCreateSubmit(e) {
    if (e) e.preventDefault();
    clearFormError();

    const nameEl = document.getElementById('m-name');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) {
      const field = document.getElementById('m-name-field');
      if (field) field.classList.add('is-invalid');
      showFormError('Enter a model name before creating it.');
      if (nameEl) nameEl.focus();
      return false;
    }

    const config = Object.assign({ name: name }, readConfig());
    const validation = CORPUS_UTILS.validateModelConfig(config);
    if (!validation.valid) {
      showFormError(validation.errors.join(' '));
      return false;
    }

    const submitBtn = document.querySelector('#model-form button[type="submit"]');
    ui.setButtonLoading(submitBtn, true);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createModel(config, token);
      const created = data && data.model ? data.model : data;
      if (created && created.id) state.addModel(created);
      ui.toast('Model created', 'success');
      closeCreateModal();
      await loadModels();
    } catch (err) {
      const detail = err && err.data && err.data.detail;
      const message = Array.isArray(detail)
        ? detail.join(' ')
        : (typeof detail === 'string' ? detail : (err.message || 'Failed to create model'));
      showFormError(message);
      ui.toast(message, 'error');
    } finally {
      ui.setButtonLoading(submitBtn, false);
    }
    return false;
  }

  function openModel(id) {
    const model = state.getModel(id);
    if (!model) {
      ui.toast('That model is no longer in the list. Refresh and try again.', 'error');
      return;
    }
    state.setActiveModel(model);
    router.navigate('ai-information');
  }

  function trainModel(id) {
    const model = state.getModel(id);
    if (!model) {
      ui.toast('That model is no longer in the list. Refresh and try again.', 'error');
      return;
    }
    state.setActiveModel(model);
    router.navigate('training');
  }

  async function cloneModel(id) {
    ui.confirm('Clone model', 'Create a copy of this model configuration?', async () => {
      try {
        const token = await state.getAccessToken();
        const data = await window.CORPUS_API.cloneModel(id, token);
        const created = data && data.model ? data.model : data;
        if (created && created.id) state.addModel(created);
        ui.toast('Model cloned', 'success');
        await loadModels();
      } catch (err) {
        ui.toast(err.message || 'Clone failed', 'error');
      }
    });
  }

  async function performDeleteModel(id, options = {}) {
    if (!id || deletingIds.has(id)) return;
    deletingIds.add(id);
    const btn = document.querySelector('[data-delete-model="' + id.replace(/"/g, '\\"') + '"]');
    if (btn) ui.setButtonLoading(btn, true);
    try {
      const token = await state.getAccessToken();
      if (!token) {
        throw new Error('Authentication required. Please sign in again.');
      }
      const result = await window.CORPUS_API.deleteModel(id, token, options);
      state.removeModel(id);
      const active = state.getActiveModel ? state.getActiveModel() : null;
      if (active && active.id === id && state.setActiveModel) {
        state.setActiveModel(null);
      }
      ui.toast('Model deleted', 'success');
      if (result && result.storage_cleanup_warning) {
        ui.toast(result.storage_cleanup_warning, 'warning', 7000);
      }
      await loadModels();
    } catch (err) {
      if (err && err.status === 409 && !options.stopActive) {
        const msg = err.message || 'This model has an active training job.';
        ui.toast(msg, 'warning', 6000);
        ui.confirm(
          'Active training job',
          msg + ' Stop active training and delete this model now?',
          () => performDeleteModel(id, { stopActive: true })
        );
      } else {
        ui.toast((err && err.message) || 'Delete failed', 'error', 6000);
      }
    } finally {
      deletingIds.delete(id);
      if (btn && btn.isConnected) ui.setButtonLoading(btn, false);
    }
  }

  async function deleteModel(id) {
    if (!id || deletingIds.has(id)) return;
    const model = state.getModel(id);
    const label = model ? ('"' + (model.name || model.id) + '"') : 'this model';
    ui.confirm(
      'Delete model',
      'Permanently delete ' + label + ', its checkpoints, and its tokenizer files? Datasets are preserved. This cannot be undone.',
      () => performDeleteModel(id, { stopActive: false })
    );
  }

  function initParamListeners() {
    bindParamListeners();
  }

  return {
    render,
    loadModels,
    openCreateModal,
    closeCreateModal,
    handleCreateSubmit,
    openModel,
    trainModel,
    cloneModel,
    deleteModel,
    initParamListeners,
    statusBadge: ui.statusBadge,
  };
})();
