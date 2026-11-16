/* ========================================
   CORPUS ULTIMATE — Neural Network Lab

   Architecture comes from the stored model config. The charts are derived
   parameter counts (deterministic math), not measured activations: this API
   does not expose attention weights or embedding projections, so the page
   says so instead of drawing invented values.
   ======================================== */

window.neuralLab = (function () {
  'use strict';

  function esc(value) {
    return ui.escapeHtml(value == null ? '' : String(value));
  }

  function parameterBreakdown(config) {
    const vocab = Number(config.vocab_size) || 0;
    const dModel = Number(config.d_model) || 0;
    const dFf = Number(config.d_ff) || 0;
    const layers = Number(config.n_layers) || 0;
    const embedding = vocab * dModel + dModel; // token embedding + bias-free positional table is input-dependent
    const attentionPerLayer = 4 * dModel * dModel + 4 * dModel;
    const ffnPerLayer = 2 * dModel * dFf + dFf + dModel;
    const output = dModel * vocab + vocab;
    return [
      { label: 'Token embedding', value: embedding },
      { label: 'Attention (' + layers + ' layers)', value: attentionPerLayer * layers },
      { label: 'Feed-forward (' + layers + ' layers)', value: ffnPerLayer * layers },
      { label: 'Output projection', value: output },
    ];
  }

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Please sign in to inspect model architectures.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    const activeModel = state.getActiveModel();
    const config = activeModel && activeModel.config ? activeModel.config : null;
    const hasArch = !!(config && (config.d_model || config.vocab_size || config.n_layers));

    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-microchip"></i> Architecture</span>
          <h1 class="section-title">Neural Network Lab</h1>
          <p class="section-subtitle">Layer stack and computed parameter distribution for the selected model.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="router.navigate('models')">
            <i class="fas fa-cube"></i> Choose model
          </button>
        </div>
      </div>

      ${!hasArch ? ui.emptyState({
        icon: 'fa-microchip',
        title: 'No architecture available',
        text: activeModel
          ? 'This model record has no architecture fields, so there is nothing to visualise.'
          : 'Select a model on the Models page to inspect its architecture.',
        actionLabel: 'Open models',
        actionOnclick: "router.navigate('models')",
        actionIcon: 'fa-arrow-right',
      }) : `
        <section class="architecture-view">
          <div class="card-head">
            <div>
              <h2 class="card-title">${esc(activeModel.name || activeModel.id)}</h2>
              <p class="card-subtitle">Values below are taken from the stored model configuration.</p>
            </div>
            ${ui.statusBadge(activeModel.status || 'idle')}
          </div>
          <div class="config-grid">
            <div class="config-item"><div class="config-label">Parameters (computed)</div><div class="config-value">${esc(CORPUS_UTILS.formatNumber(CORPUS_UTILS.calculateParameters(config)))}</div></div>
            <div class="config-item"><div class="config-label">Layers</div><div class="config-value">${esc(config.n_layers || '—')}</div></div>
            <div class="config-item"><div class="config-label">Heads</div><div class="config-value">${esc(config.n_heads || '—')}</div></div>
            <div class="config-item"><div class="config-label">Embedding dim</div><div class="config-value">${esc(config.d_model || '—')}</div></div>
            <div class="config-item"><div class="config-label">Feed-forward dim</div><div class="config-value">${esc(config.d_ff || '—')}</div></div>
            <div class="config-item"><div class="config-label">Vocabulary</div><div class="config-value">${esc(CORPUS_UTILS.formatNumber(config.vocab_size || 0))}</div></div>
            <div class="config-item"><div class="config-label">Context length</div><div class="config-value">${esc(CORPUS_UTILS.formatNumber(config.context_length || 0))}</div></div>
            <div class="config-item"><div class="config-label">Dropout</div><div class="config-value">${esc(config.dropout != null ? config.dropout : '—')}</div></div>
          </div>
        </section>

        <section class="architecture-view">
          <div class="card-head">
            <div>
              <h2 class="card-title">Layer stack</h2>
              <p class="card-subtitle">Decoder-only transformer as configured for training.</p>
            </div>
          </div>
          <div class="layer-diagram" id="neural-layers"></div>
        </section>

        <div class="grid-2">
          <section class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Parameter distribution</h2>
                <p class="card-subtitle">Computed from the architecture — not measured activations.</p>
              </div>
            </div>
            <div class="chart-container" style="height:240px;">
              <canvas id="neural-params-chart"></canvas>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <h2 class="card-title">Measured internals</h2>
                <p class="card-subtitle">Attention maps and embedding projections.</p>
              </div>
            </div>
            <div class="info-panel">
              <i class="fas fa-circle-info"></i>
              <div>
                <strong>Not available.</strong> The inference API returns tokens and probabilities only — it does not
                expose attention weights or embedding vectors, so no attention or PCA visualisation is drawn here.
                Use the Prediction Lab to inspect real next-token probabilities.
              </div>
            </div>
          </section>
        </div>
      `}
    `;

    if (hasArch) {
      renderLayers(config);
      renderParamChart(config);
    }
  }

  function renderLayers(config) {
    const container = document.getElementById('neural-layers');
    if (!container) return;
    const layers = Math.max(1, Math.min(Number(config.n_layers) || 1, 24));
    const dModel = Number(config.d_model) || 0;
    const vocab = Number(config.vocab_size) || 0;
    const context = Number(config.context_length) || 0;

    const node = (icon, name, shape) => `
      <div class="layer-node">
        <span class="layer-icon"><i class="fas ${icon}"></i></span>
        <div class="layer-info">
          <div class="layer-name">${esc(name)}</div>
          <div class="layer-shape">${esc(shape)}</div>
        </div>
      </div>
    `;
    const arrow = '<div class="arrow"><i class="fas fa-arrow-down"></i></div>';

    const parts = [];
    parts.push(node('fa-layer-group', 'Token embedding', '[' + vocab + ' × ' + dModel + ']'));
    parts.push(arrow);
    parts.push(node('fa-arrows-up-down', 'Positional encoding', '[' + context + ' × ' + dModel + ']'));
    for (let index = 0; index < layers; index += 1) {
      parts.push(arrow);
      parts.push(node('fa-diagram-project', 'Transformer block ' + (index + 1),
        'self-attention (' + (config.n_heads || '?') + ' heads) → feed-forward [' + dModel + ' → ' + (config.d_ff || '?') + ']'));
    }
    parts.push(arrow);
    parts.push(node('fa-terminal', 'Output projection', '[' + dModel + ' × ' + vocab + ']'));
    container.innerHTML = parts.join('');
  }

  function renderParamChart(config) {
    const canvas = document.getElementById('neural-params-chart');
    if (!canvas || !window.charts) return;
    const rows = parameterBreakdown(config).filter(row => row.value > 0);
    if (!rows.length) return;
    window.charts.createBarChart('neural-params-chart',
      rows.map(row => row.label.replace(/ \(\d+ layers\)/, '')),
      [{
        label: 'Parameters',
        data: rows.map(row => row.value),
        backgroundColor: ['rgba(124, 92, 255, 0.65)', 'rgba(125, 211, 252, 0.55)', 'rgba(74, 222, 128, 0.5)', 'rgba(251, 191, 36, 0.5)'],
        borderRadius: 4,
      }],
      {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        animation: { duration: 400 },
        scales: {
          x: { ticks: { color: '#a6a1b3' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
          y: { ticks: { color: '#a6a1b3' }, grid: { display: false } },
        },
      }
    );
  }

  return { render };
})();
