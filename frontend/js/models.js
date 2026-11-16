/* ========================================
   CORPUS ULTIMATE — Models page
   ======================================== */

window.models = (function () {
  let editingModelId = null;

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to manage models.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="models-header">
        <div>
          <h1 class="section-title">Models</h1>
          <p class="section-subtitle">Create, configure, and manage your CORPUS language models.</p>
        </div>
        <button class="btn btn-primary" onclick="models.openCreateModal()"><i class="fas fa-plus"></i> Create Model</button>
      </div>

      <div class="model-library" id="model-library">
        <!-- model cards injected -->
      </div>

      <!-- Create/Edit modal -->
      <div id="model-create-modal" class="modal hidden">
        <div class="modal-backdrop" onclick="models.closeCreateModal()"></div>
        <div class="modal-content auth-card" style="max-width:700px;">
          <div class="modal-header">
            <h3 id="modal-title">Create Model</h3>
            <button class="modal-close" onclick="models.closeCreateModal()">&times;</button>
          </div>
          <form id="model-form" onsubmit="return models.handleCreateSubmit(event)">
            <div class="form-section">
              <h3>Model Configuration</h3>
              <div class="form-grid">
                <div class="input-field">
                  <input type="text" id="m-name" placeholder="Model name" required>
                  <label for="m-name">Model name</label>
                </div>
                <div class="input-field">
                  <input type="number" id="m-vocab" placeholder="5000" value="5000" min="100" required>
                  <label for="m-vocab">Vocabulary size</label>
                </div>
                <div class="input-field">
                  <input type="number" id="m-context" placeholder="256" value="256" min="16" required>
                  <label for="m-context">Context length</label>
                </div>
                <div class="input-field">
                  <input type="number" id="m-dmodel" placeholder="256" value="256" min="16" required>
                  <label for="m-dmodel">Embedding dimension</label>
                </div>
                <div class="input-field">
                  <input type="number" id="m-layers" placeholder="4" value="4" min="1" required>
                  <label for="m-layers">Transformer layers</label>
                </div>
                <div class="input-field">
                  <input type="number" id="m-heads" placeholder="4" value="4" min="1" required>
                  <label for="m-heads">Attention heads</label>
                </div>
                <div class="input-field">
                  <input type="number" id="m-dff" placeholder="1024" value="1024" min="32" required>
                  <label for="m-dff">Feed-forward dimension</label>
                </div>
              </div>
              <div class="input-field" style="margin-top:var(--space-4);">
                <div id="m-param-display" style="font-family:'Courier New',monospace; color:var(--color-text-variant); margin-bottom:var(--space-2);">Estimated parameters: —</div>
                <div class="progress-container"><div class="progress-bar" id="m-param-bar"></div></div>
              </div>
            </div>
            <div class="confirm-actions" style="justify-content:flex-end; margin-top:var(--space-4);">
              <button class="btn btn-outline" type="button" onclick="models.closeCreateModal()">Cancel</button>
              <button class="btn btn-primary" type="submit">Create Model</button>
            </div>
          </form>
        </div>
      </div>
    `;

    await loadModels();
  }

  async function loadModels() {
    const container = document.getElementById('model-library');
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listModels(token);
      state.setModels(data.models || data || []);
      renderModelList();
    } catch (err) {
      // Show error state with retry button instead of silently showing empty
      state.setModels([]);
      if (container) {
        const isNetworkErr = err.networkError === true;
        const isTimeout = err.code === 'TIMEOUT';
        container.innerHTML = `
          <div class="empty-state" style="text-align:center;">
            <i class="fas fa-${isNetworkErr || isTimeout ? 'wifi' : 'exclamation-triangle'}"></i>
            <h3>${isNetworkErr ? 'Backend Unreachable' : isTimeout ? 'Request Timed Out' : 'Failed to Load Models'}</h3>
            <p style="color:var(--color-text-variant); font-size:var(--text-body-small); max-width:400px; margin:0 auto var(--space-4) auto;">
              ${isNetworkErr ? 'Cannot reach the backend at ' + (window.CORPUS_CONFIG.API_BASE_URL || 'unknown') + '. Check your API_BASE_URL in frontend/js/config.js and ensure the FastAPI server is running.' : isTimeout ? 'The backend took too long to respond. Please try again.' : err.message || 'An error occurred while loading models.'}
            </p>
            <button class="btn btn-primary" onclick="models.loadModels()" style="margin-right:var(--space-2);"><i class="fas fa-refresh"></i> Retry</button>
            <button class="btn btn-outline" onclick="router.navigate('dashboard')">Go to Dashboard</button>
          </div>
        `;
      } else {
        ui.toast(err.message || 'Failed to load models', 'error');
      }
    }
  }

  function renderModelList() {
    const container = document.getElementById('model-library');
    const modelList = state.getModels() || [];
    if (modelList.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-cube"></i><h3>No models yet</h3><p>Create your first CORPUS model to get started.</p></div>';
      return;
    }
    container.innerHTML = modelList.map(m => `
      <div class="model-card" data-aos="fade-up">
        <div class="model-header">
          <div class="model-info">
            <h3>${escapeHtml(m.name || 'Unnamed')}</h3>
            <div class="model-id">${escapeHtml(m.id)}</div>
          </div>
          ${window.models.statusBadge(m.status || 'idle')}
        </div>
        <div class="model-meta">
          <span class="model-meta-item"><i class="fas fa-layer-group"></i> ${m.config?.n_layers || '—'} layers</span>
          <span class="model-meta-item"><i class="fas fa-heading"></i> ${m.config?.n_heads || '—'} heads</span>
          <span class="model-meta-item"><i class="fas fa-memory"></i> ${m.config?.d_model || '—'} dim</span>
          <span class="model-meta-item"><i class="fas fa-hashtag"></i> ${CORPUS_UTILS.formatNumber(CORPUS_UTILS.calculateParameters(m.config || {}))} params</span>
        </div>
        <div class="model-config">
          <h4>Configuration</h4>
          ${ui.modelConfigSummary(m.config)}
        </div>
        <div class="model-actions">
          <button class="btn btn-outline" onclick="models.openModel('${escapeHtml(m.id)}')"><i class="fas fa-eye"></i> Inspect</button>
          <button class="btn btn-outline" onclick="models.trainModel('${escapeHtml(m.id)}')"><i class="fas fa-play"></i> Train</button>
          <button class="btn btn-outline" onclick="models.cloneModel('${escapeHtml(m.id)}')"><i class="fas fa-copy"></i> Clone</button>
          <button class="btn btn-danger btn-sm" onclick="models.deleteModel('${escapeHtml(m.id)}')"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    `).join('');
  }

  function openCreateModal() {
    editingModelId = null;
    document.getElementById('modal-title').textContent = 'Create Model';
    document.getElementById('model-form').reset();
    document.getElementById('m-name').value = '';
    updateParamDisplay();
    document.getElementById('model-create-modal').classList.remove('hidden');
  }

  function closeCreateModal() {
    document.getElementById('model-create-modal').classList.add('hidden');
    editingModelId = null;
  }

  function updateParamDisplay() {
    const config = {
      vocab_size: parseInt(document.getElementById('m-vocab').value) || 5000,
      context_length: parseInt(document.getElementById('m-context').value) || 256,
      d_model: parseInt(document.getElementById('m-dmodel').value) || 256,
      n_layers: parseInt(document.getElementById('m-layers').value) || 4,
      n_heads: parseInt(document.getElementById('m-heads').value) || 4,
      d_ff: parseInt(document.getElementById('m-dff').value) || 1024,
    };
    const params = CORPUS_UTILS.calculateParameters(config);
    document.getElementById('m-param-display').textContent = 'Estimated parameters: ' + CORPUS_UTILS.formatNumber(params);
    const bar = document.getElementById('m-param-bar');
    const pct = Math.min(100, (params / 10000000) * 100);
    bar.style.width = pct + '%';
    bar.style.background = params > 50000000 ? 'var(--color-error)' : 'var(--color-primary)';
  }

  async function handleCreateSubmit(e) {
    e.preventDefault();
    const config = {
      name: document.getElementById('m-name').value,
      vocab_size: parseInt(document.getElementById('m-vocab').value),
      context_length: parseInt(document.getElementById('m-context').value),
      d_model: parseInt(document.getElementById('m-dmodel').value),
      n_layers: parseInt(document.getElementById('m-layers').value),
      n_heads: parseInt(document.getElementById('m-heads').value),
      d_ff: parseInt(document.getElementById('m-dff').value),
    };
    const validation = CORPUS_UTILS.validateModelConfig(config);
    if (!validation.valid) {
      ui.toast(validation.errors.join(' '), 'error');
      return;
    }
    ui.setButtonLoading(document.querySelector('#model-form button[type="submit"]'), true);
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.createModel(config, token);
      state.addModel(data.model || data);
      ui.toast('Model created successfully', 'success');
      closeCreateModal();
      await loadModels();
    } catch (err) {
      ui.toast(err.message || 'Failed to create model', 'error');
    } finally {
      ui.setButtonLoading(document.querySelector('#model-form button[type="submit"]'), false);
    }
  }

  function openModel(id) {
    const m = state.getModel(id);
    if (!m) return;
    state.setActiveModel(m);
    router.navigate('ai-information');
  }

  function trainModel(id) {
    state.setActiveModel(state.getModel(id));
    router.navigate('training');
  }

  async function cloneModel(id) {
    ui.confirm('Clone model', 'Create a copy of this model?', async () => {
      try {
        const token = await state.getAccessToken();
        const data = await window.CORPUS_API.cloneModel(id, token);
        state.addModel(data.model || data);
        ui.toast('Model cloned', 'success');
        await loadModels();
      } catch (err) {
        ui.toast(err.message || 'Clone failed', 'error');
      }
    });
  }

  async function deleteModel(id) {
    ui.confirm('Delete model', 'This will permanently delete the model and its checkpoints. This cannot be undone.', async () => {
      try {
        const token = await state.getAccessToken();
        await window.CORPUS_API.deleteModel(id, token);
        state.removeModel(id);
        ui.toast('Model deleted', 'success');
        await loadModels();
      } catch (err) {
        ui.toast(err.message || 'Delete failed', 'error');
      }
    });
  }

  // Wire param inputs
  function initParamListeners() {
    ['m-vocab', 'm-context', 'm-dmodel', 'm-layers', 'm-heads', 'm-dff'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', updateParamDisplay);
    });
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

// Initialize param listeners when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  if (window.models) window.models.initParamListeners();
  // Also wire inputs on create modal show
  const form = document.getElementById('model-form');
  if (form) {
    form.addEventListener('input', (e) => {
      if (['m-vocab','m-context','m-dmodel','m-layers','m-heads','m-dff'].includes(e.target.id)) {
        const config = {
          vocab_size: parseInt(document.getElementById('m-vocab').value) || 5000,
          context_length: parseInt(document.getElementById('m-context').value) || 256,
          d_model: parseInt(document.getElementById('m-dmodel').value) || 256,
          n_layers: parseInt(document.getElementById('m-layers').value) || 4,
          n_heads: parseInt(document.getElementById('m-heads').value) || 4,
          d_ff: parseInt(document.getElementById('m-dff').value) || 1024,
        };
        const params = CORPUS_UTILS.calculateParameters(config);
        document.getElementById('m-param-display').textContent = 'Estimated parameters: ' + CORPUS_UTILS.formatNumber(params);
        const bar = document.getElementById('m-param-bar');
        bar.style.width = Math.min(100, (params / 10000000) * 100) + '%';
      }
    });
  }
});