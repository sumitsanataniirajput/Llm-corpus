/* ========================================
   CORPUS ULTIMATE — AI Information Page
   ========================================

   Displays complete technical model card information from actual model records.
   ======================================== */

window.aiInfo = (function () {
  'use strict';

  function escapeHtml(text) {
    if (text == null) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }

  function formatNumber(num) {
    if (num == null) return '—';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString(); } catch (e) { return '—'; }
  }

  async function render() {
    const user = window.state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to view model information.</p></div>';
      return;
    }

    const activeModel = window.state.getActiveModel();

    if (!activeModel) {
      container.innerHTML = `
        <div class="ai-info-header">
          <div>
            <h1 class="section-title">AI Information</h1>
            <p class="section-subtitle">Complete technical model card for your CORPUS models.</p>
          </div>
        </div>
        <div class="empty-state">
          <i class="fas fa-info-circle"></i>
          <h3>No model selected</h3>
          <p>Select a model from the Models page to view its complete technical information here.</p>
        </div>
      `;
      return;
    }

    const config = activeModel.config || {};
    const params = CORPUS_UTILS.calculateParameters(config);

    container.innerHTML = `
      <div class="ai-info-header">
        <div>
          <h1 class="section-title">AI Information</h1>
          <p class="section-subtitle">Model card for <strong>${escapeHtml(activeModel.name || 'Unnamed')}</strong></p>
        </div>
        <div class="ai-info-actions">
          <button class="btn btn-outline" onclick="window.router.navigate('models')"><i class="fas fa-arrow-left"></i> Back to Models</button>
        </div>
      </div>

      <div class="ai-info-grid">
        <!-- Identity -->
        <div class="ai-info-card">
          <h3><i class="fas fa-id-card"></i> Model Identity</h3>
          <div class="info-row"><span class="info-label">Name</span><span class="info-value">${escapeHtml(activeModel.name || 'Unnamed')}</span></div>
          <div class="info-row"><span class="info-label">Model ID</span><span class="info-value" style="font-family:monospace; font-size:var(--text-label-small);">${escapeHtml(activeModel.id || '—')}</span></div>
          <div class="info-row"><span class="info-label">Version</span><span class="info-value">${escapeHtml(activeModel.version || '1.0.0')}</span></div>
          <div class="info-row"><span class="info-label">Status</span><span class="info-value">${window.ui ? window.ui.statusBadge(activeModel.status || 'idle') : escapeHtml(activeModel.status || 'idle')}</span></div>
          <div class="info-row"><span class="info-label">Created</span><span class="info-value">${formatDate(activeModel.created_at)}</span></div>
          <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${escapeHtml(user.email || '—')}</span></div>
        </div>

        <!-- Architecture -->
        <div class="ai-info-card">
          <h3><i class="fas fa-layer-group"></i> Architecture</h3>
          <div class="info-row"><span class="info-label">Type</span><span class="info-value">Decoder-only Transformer</span></div>
          <div class="info-row"><span class="info-label">Layers</span><span class="info-value">${config.n_layers || '—'}</span></div>
          <div class="info-row"><span class="info-label">Attention Heads</span><span class="info-value">${config.n_heads || '—'}</span></div>
          <div class="info-row"><span class="info-label">Embedding Dimension</span><span class="info-value">${config.d_model || '—'}</span></div>
          <div class="info-row"><span class="info-label">Feed-Forward Dimension</span><span class="info-value">${config.d_ff || '—'}</span></div>
          <div class="info-row"><span class="info-label">Vocabulary Size</span><span class="info-value">${formatNumber(config.vocab_size || 0)}</span></div>
          <div class="info-row"><span class="info-label">Context Length</span><span class="info-value">${formatNumber(config.context_length || 0)}</span></div>
          <div class="info-row"><span class="info-label">Dropout</span><span class="info-value">${config.dropout !== undefined ? config.dropout : '—'}</span></div>
        </div>

        <!-- Parameters -->
        <div class="ai-info-card">
          <h3><i class="fas fa-hashtag"></i> Parameters</h3>
          <div class="info-row"><span class="info-label">Total parameters</span><span class="info-value">${params > 0 ? formatNumber(params) + ' (computed)' : '—'}</span></div>
          <div class="info-row"><span class="info-label">Estimated size (FP32)</span><span class="info-value">${params > 0 ? ((params * 4) / 1024 / 1024).toFixed(2) + ' MB' : '—'}</span></div>
          <div class="info-row"><span class="info-label">Trainable breakdown</span><span class="info-value">Not reported by the API</span></div>
          <p class="field-hint" style="margin-top:var(--space-2);">Parameter counts are computed from the stored architecture; the runtime may clamp values for CPU safety.</p>
        </div>

        <!-- Training -->
        <div class="ai-info-card">
          <h3><i class="fas fa-flask"></i> Training information</h3>
          <div class="info-row"><span class="info-label">Linked datasets</span><span class="info-value">${Array.isArray(activeModel.dataset_ids) ? activeModel.dataset_ids.length : 'not recorded'}</span></div>
          <div class="info-row"><span class="info-label">Record updated</span><span class="info-value">${formatDate(activeModel.updated_at || activeModel.created_at)}</span></div>
          <div class="info-row"><span class="info-label">Engine</span><span class="info-value">Selected per training job</span></div>
          <p class="field-hint" style="margin-top:var(--space-2);">Job history, loss and throughput live on the Statistics and Training pages.</p>
        </div>

        <!-- Capabilities -->
        <div class="ai-info-card">
          <h3><i class="fas fa-star"></i> Capabilities in this deployment</h3>
          <ul class="capability-list">
            <li>Next-token prediction through the inference API</li>
            <li>Temperature, top-K and top-P sampling controls</li>
            <li>Autoregressive generation in AI Chat</li>
            <li>Checkpoints written by finished training jobs</li>
            <li>Private dataset uploads with text extraction</li>
          </ul>
        </div>

        <!-- Limitations -->
        <div class="ai-info-card limitations">
          <h3><i class="fas fa-triangle-exclamation"></i> Known Limitations</h3>
          <ul class="capability-list">
            <li>Small default configuration — not production-scale</li>
            <li>Training runs on the backend CPU worker unless a GPU worker is registered</li>
            <li>Inference happens inside this deployment; no external API routing</li>
            <li>Custom tokenizer — vocabulary differs from Hugging Face models</li>
            <li>No attention or embedding introspection endpoint</li>
          </ul>
        </div>

        <!-- Configuration -->
        <div class="ai-info-card">
          <h3><i class="fas fa-cogs"></i> Full Configuration</h3>
          <pre style="background:var(--color-surface-elevated); padding:var(--space-4); border-radius:var(--radius-md); font-size:var(--text-label-small); overflow:auto; color:var(--color-text);">${escapeHtml(JSON.stringify(config, null, 2))}</pre>
        </div>
      </div>
    `;
  }

  return { render };
})();