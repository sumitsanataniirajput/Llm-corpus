/* ========================================
   CORPUS ULTIMATE — Prediction Lab page
   ======================================== */

window.prediction = (function () {
  let probabilityChart = null;

  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to use the Prediction Lab.</p></div>';
      return;
    }

    const activeModel = state.getActiveModel();
    container.innerHTML = `
      <div class="prediction-header">
        <div>
          <h1 class="section-title">Prediction Lab</h1>
          <p class="section-subtitle">Explore real next-token probabilities from your CORPUS model logits.</p>
        </div>
        ${activeModel ? '' : '<div style="margin-left:auto;"><span style="color:var(--color-error); font-weight:600;">No model selected</span></div>'}
      </div>

      <div class="prediction-input">
        <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Test Sentence</h3>
        <textarea id="pred-text" rows="3" placeholder="Enter a sentence to predict the next token...">${activeModel ? '' : ''}</textarea>
        <div style="display:flex; gap:var(--space-2); margin-top:var(--space-3);">
          <label style="font-size:var(--text-label-medium); color:var(--color-text); display:flex; align-items:center; gap:var(--space-2);">
            Temperature
            <input type="range" id="pred-temp" min="0" max="2" step="0.1" value="1.0" style="width:120px;">
            <span id="pred-temp-val" style="font-family:'Courier New',monospace; font-size:var(--text-label-small);">1.0</span>
          </label>
        </div>
        <div class="training-actions" style="margin-top:var(--space-3);">
          <button class="btn btn-primary" onclick="prediction.runPrediction()" ${!activeModel ? 'disabled' : ''}><i class="fas fa-microscope"></i> Predict Next Token</button>
        </div>
      </div>

      <div class="prediction-results" id="pred-results">
        <!-- results injected -->
      </div>

      <div class="card" style="margin-top:var(--space-6);">
        <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Tokenization Visualization</h3>
        <div id="pred-tokenization" style="font-family:'Courier New',monospace; font-size:var(--text-body-small); color:var(--color-text-variant);">
          Enter a sentence and run prediction to see tokenization.
        </div>
      </div>

      <div class="card" style="margin-top:var(--space-6);">
        <h3 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">Probability Distribution</h3>
        <div class="chart-container">
          <canvas id="pred-prob-chart"></canvas>
        </div>
      </div>
    `;

    document.getElementById('pred-temp')?.addEventListener('input', (e) => {
      document.getElementById('pred-temp-val').textContent = e.target.value;
    });
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function runPrediction() {
    const activeModel = state.getActiveModel();
    if (!activeModel) {
      ui.toast('Please select a model first', 'error');
      return;
    }
    const text = document.getElementById('pred-text').value.trim();
    if (!text) {
      ui.toast('Please enter a sentence', 'error');
      return;
    }
    const temp = parseFloat(document.getElementById('pred-temp').value) || 1.0;

    const resultsContainer = document.getElementById('pred-results');
    resultsContainer.innerHTML = '<div style="text-align:center; padding:var(--space-6); color:var(--color-text-variant);"><i class="fas fa-circle-notch fa-spin" style="font-size:2rem; margin-bottom:var(--space-2);"></i> Computing predictions...</div>';

    try {
      const payload = { text, temperature: temp, top_k: 10, top_p: 0.9, max_tokens: 1 };
      const token = await state.getAccessToken();
      const result = await window.CORPUS_API.nextToken(activeModel.id, payload, token);
      displayPrediction(result);
    } catch (err) {
      resultsContainer.innerHTML = '<div style="color:var(--color-error); padding:var(--space-4);">Error: ' + escapeHtml(err.message || 'Prediction failed') + '</div>';
      ui.toast(err.message || 'Prediction failed', 'error');
    }
  }

  function displayPrediction(result) {
    const container = document.getElementById('pred-results');
    const predictions = result.predictions || result.top_tokens || [];
    const tokenization = result.tokenization || result.tokens || [];

    // Tokenization display
    const tokContainer = document.getElementById('pred-tokenization');
    if (tokenization.length) {
      tokContainer.innerHTML = tokenization.map((t, i) => `
        <span style="display:inline-flex; align-items:center; gap:var(--space-1); background:var(--color-surface-elevated); border:1px solid var(--color-outline-variant); border-radius:var(--radius-md); padding:var(--space-1) var(--space-2); margin:var(--space-1);">
          <span style="font-family:'Courier New',monospace;">${escapeHtml(String(t.token || t))}</span>
          <span style="font-size:var(--text-label-small); color:var(--color-text-variant);">#${t.id !== undefined ? t.id : i}</span>
        </span>
      `).join('');
    }

    // Predictions list
    if (predictions.length === 0) {
      container.innerHTML = '<div style="color:var(--color-text-variant); padding:var(--space-4);">No predictions returned.</div>';
      return;
    }

    container.innerHTML = predictions.map((p, i) => `
      <div class="prediction-card" data-aos="fade-up">
        <div class="token-row">
          <span class="token-id">#${i + 1}</span>
          <span class="token-string">${escapeHtml(String(p.token || p.text || '?'))}</span>
          <span class="token-probability">${(p.probability * 100).toFixed(2)}%</span>
        </div>
        <div class="probability-bar">
          <div class="probability-fill" style="width: ${p.probability * 100}%;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:var(--text-label-small); color:var(--color-text-variant); margin-top:var(--space-2); font-family:'Courier New',monospace;">
          <span>Rank: ${p.rank || i + 1}</span>
          <span>Logit: ${p.logit !== undefined ? p.logit.toFixed(4) : '—'}</span>
          <span>ID: ${p.id !== undefined ? p.id : '—'}</span>
        </div>
      </div>
    `).join('');

    // Probability chart
    const tokens = predictions.map(p => String(p.token || p.text || '?').substring(0, 10));
    const probs = predictions.map(p => p.probability || 0);
    if (probabilityChart) probabilityChart.destroy();
    probabilityChart = charts.createProbabilityChart('pred-prob-chart', tokens, probs);
  }

  return { render, runPrediction };
})();