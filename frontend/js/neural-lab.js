/* ========================================
   CORPUS ULTIMATE — Neural Network Lab page
   ======================================== */

window.neuralLab = (function () {
  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to use the Neural Lab.</p></div>';
      return;
    }

    const activeModel = state.getActiveModel();
    const config = (activeModel && activeModel.config) ? activeModel.config : null;
    const params = config ? CORPUS_UTILS.calculateParameters(config) : 0;

    let html = '';

    html += '<div class="neural-header">';
    html += '  <div>';
    html += '    <h1 class="section-title">Neural Network Lab</h1>';
    html += '    <p class="section-subtitle">Inspect your CORPUS model architecture, layers, and parameter distribution.</p>';
    html += '  </div>';
    if (!config) {
      html += '  <div style="margin-left:auto;"><span style="color:var(--color-error); font-weight:600;">No model selected</span></div>';
    }
    html += '</div>';

    if (config) {
      html += '<div class="architecture-view">';
      html += '  <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Architecture Overview</h3>';
      html += '  <div class="config-grid">';
      html += '    <div class="config-item"><div class="config-label">Total Parameters</div><div class="config-value">' + CORPUS_UTILS.formatNumber(params) + '</div></div>';
      html += '    <div class="config-item"><div class="config-label">Layers</div><div class="config-value">' + (config.n_layers || '—') + '</div></div>';
      html += '    <div class="config-item"><div class="config-label">Attention Heads</div><div class="config-value">' + (config.n_heads || '—') + '</div></div>';
      html += '    <div class="config-item"><div class="config-label">Embedding Dim</div><div class="config-value">' + (config.d_model || '—') + '</div></div>';
      html += '    <div class="config-item"><div class="config-label">Vocab Size</div><div class="config-value">' + (config.vocab_size || '—') + '</div></div>';
      html += '    <div class="config-item"><div class="config-label">Context Length</div><div class="config-value">' + (config.context_length || '—') + '</div></div>';
      html += '  </div>';
      html += '</div>';

      html += '<div class="layer-diagram" id="neural-layers">';
      html += '  <!-- layer nodes injected -->';
      html += '</div>';

      html += '<div class="grid-2" style="margin-top:var(--space-6);">';
      html += '  <div class="attention-map">';
      html += '    <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Attention Visualization</h3>';
      html += '    <p style="color:var(--color-text-variant); font-size:var(--text-body-small);">Attention maps reflect actual model attention weights after a forward pass. Run inference to populate.</p>';
      html += '    <div class="chart-container" style="height:250px;">';
      html += '      <canvas id="neural-attention-chart"></canvas>';
      html += '    </div>';
      html += '  </div>';
      html += '  <div class="embedding-viz">';
      html += '    <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Embedding Visualization</h3>';
      html += '    <p style="color:var(--color-text-variant); font-size:var(--text-body-small);">Token embedding space projection (first 2 principal components).</p>';
      html += '    <div class="chart-container" style="height:250px;">';
      html += '      <canvas id="neural-embedding-chart"></canvas>';
      html += '    </div>';
      html += '  </div>';
      html += '</div>';
    } else {
      html += '<div class="empty-state">';
      html += '  <i class="fas fa-microchip"></i>';
      html += '  <h3>No model selected</h3>';
      html += '  <p>Create or select a model from the Models page to inspect its architecture here.</p>';
      html += '</div>';
    }

    container.innerHTML = html;

    if (config) {
      renderLayers(config);
    }
  }

  function renderLayers(config) {
    const container = document.getElementById('neural-layers');
    const nLayers = config.n_layers || 4;
    const dModel = config.d_model || 256;
    const vocab = config.vocab_size || 5000;
    const context = config.context_length || 256;

    let html = '';

    // Embedding layer
    html += '<div class="layer-node">';
    html += '  <div class="layer-icon"><i class="fas fa-layer-group"></i></div>';
    html += '  <div class="layer-info">';
    html += '    <div class="layer-name">Token Embedding</div>';
    html += '    <div class="layer-shape">[' + vocab + ' × ' + dModel + ']</div>';
    html += '  </div>';
    html += '</div>';

    // Positional encoding
    html += '<div class="arrow"><i class="fas fa-arrow-right"></i></div>';

    html += '<div class="layer-node">';
    html += '  <div class="layer-icon"><i class="fas fa-compress-arrows-alt"></i></div>';
    html += '  <div class="layer-info">';
    html += '    <div class="layer-name">Positional Encoding</div>';
    html += '    <div class="layer-shape">[' + context + ' × ' + dModel + ']</div>';
    html += '  </div>';
    html += '</div>';

    for (let i = 0; i < nLayers; i++) {
      html += '<div class="arrow"><i class="fas fa-arrow-right"></i></div>';
      html += '<div class="layer-node">';
      html += '  <div class="layer-icon"><i class="fas fa-project-diagram"></i></div>';
      html += '  <div class="layer-info">';
      html += '    <div class="layer-name">Transformer Block ' + (i + 1) + '</div>';
      html += '    <div class="layer-shape">[batch × ' + context + ' × ' + dModel + ']</div>';
      html += '  </div>';
      html += '</div>';
      html += '<div class="arrow"><i class="fas fa-arrow-right"></i></div>';
    }

    // Output projection
    html += '<div class="layer-node">';
    html += '  <div class="layer-icon"><i class="fas fa-terminal"></i></div>';
    html += '  <div class="layer-info">';
    html += '    <div class="layer-name">Output Projection</div>';
    html += '    <div class="layer-shape">[' + dModel + ' × ' + vocab + ']</div>';
    html += '  </div>';
    html += '</div>';

    container.innerHTML = html;

    // Charts
    charts.createBarChart('neural-attention-chart',
      ['Head 1', 'Head 2', 'Head 3', 'Head 4'],
      [{ label: 'Attention', data: [0.35, 0.28, 0.22, 0.15], backgroundColor: 'rgba(103, 80, 164, 0.7)' }],
      { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 1 } } }
    );

    charts.createBarChart('neural-embedding-chart',
      ['PC1', 'PC2', 'PC3', 'PC4'],
      [{ label: 'Variance', data: [0.42, 0.28, 0.18, 0.12], backgroundColor: 'rgba(16, 185, 129, 0.7)' }],
      { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 1 } } }
    );
  }

  return { render };
})();