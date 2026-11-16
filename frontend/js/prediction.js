/* ========================================
   CORPUS ULTIMATE — Prediction Lab

   Shows the real next-token distribution returned by the inference endpoint,
   including token ids, probabilities and logits when the backend provides them.
   ======================================== */

window.prediction = (function () {
  'use strict';

  let probabilityChart = null;

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
        text: 'Please sign in to inspect next-token probabilities.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    const activeModel = state.getActiveModel();
    container.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-microscope"></i> Interpretability</span>
          <h1 class="section-title">Prediction Lab</h1>
          <p class="section-subtitle">See how the model ranks the next token for a sentence you provide.</p>
        </div>
        <div class="page-header-actions">
          ${activeModel
            ? `<span class="chat-model-chip"><i class="fas fa-cube"></i><span>${esc(activeModel.name || activeModel.id)}</span></span>`
            : '<a class="btn btn-outline" href="#/models" onclick="event.preventDefault();router.navigate(\'models\')"><i class="fas fa-cube"></i> Select model</a>'}
        </div>
      </div>

      <div class="prediction-container">
        <section class="prediction-input">
          <div class="input-field">
            <label for="pred-text">Test sentence</label>
            <textarea id="pred-text" rows="3" placeholder="Enter a sentence to predict the next token…">${activeModel ? '' : ''}</textarea>
            <span class="field-hint">The model continues from this text; nothing is sent anywhere except your backend.</span>
          </div>
          <div class="input-field">
            <label for="pred-temp">Temperature <span class="mono" id="pred-temp-val">1.0</span></label>
            <input type="range" id="pred-temp" min="0" max="2" step="0.1" value="1.0">
            <span class="field-hint">Higher values flatten the distribution; 0 would be greedy.</span>
          </div>
          <div class="training-actions" style="margin-top:var(--space-2);">
            <button class="btn btn-primary" id="pred-run" type="button" onclick="prediction.runPrediction()" ${activeModel ? '' : 'disabled'}>
              <i class="fas fa-microscope"></i> Predict next token
            </button>
          </div>
          ${activeModel ? '' : '<p class="field-hint">Select a model to enable prediction.</p>'}
        </section>

        <div class="prediction-results" id="pred-results"></div>

        <section class="card" style="margin-bottom:var(--space-4);">
          <div class="card-head">
            <div>
              <h2 class="card-title">Tokenization</h2>
              <p class="card-subtitle">Token ids reported by the backend tokenizer.</p>
            </div>
          </div>
          <div id="pred-tokenization" class="chip-row">
            <span class="field-hint">Run a prediction to see how the sentence was tokenized.</span>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div>
              <h2 class="card-title">Probability distribution</h2>
              <p class="card-subtitle">Top candidates returned for this prompt.</p>
            </div>
          </div>
          <div class="chart-container" style="height:280px;">
            <canvas id="pred-prob-chart"></canvas>
            <div id="pred-prob-empty" class="chart-empty">
              <i class="fas fa-chart-simple"></i>
              <span>No distribution yet.</span>
            </div>
          </div>
        </section>
      </div>
    `;

    const temp = document.getElementById('pred-temp');
    if (temp) {
      temp.addEventListener('input', (event) => {
        const label = document.getElementById('pred-temp-val');
        if (label) label.textContent = Number(event.target.value).toFixed(1);
      });
    }
  }

  async function runPrediction() {
    const activeModel = state.getActiveModel();
    if (!activeModel) {
      ui.toast('Select a model first.', 'error');
      return;
    }
    const textEl = document.getElementById('pred-text');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) {
      ui.toast('Enter a sentence to predict from.', 'error');
      if (textEl) textEl.focus();
      return;
    }
    const tempEl = document.getElementById('pred-temp');
    const temperature = tempEl ? parseFloat(tempEl.value) : 1.0;
    const button = document.getElementById('pred-run');
    const resultsContainer = document.getElementById('pred-results');

    ui.setButtonLoading(button, true);
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="card"><p class="field-hint" style="margin:0;"><i class="fas fa-circle-notch fa-spin"></i> Asking the backend for the next-token distribution…</p></div>';
    }

    try {
      const token = await state.getAccessToken();
      const result = await window.CORPUS_API.nextToken(activeModel.id, {
        text: text,
        temperature: temperature,
        top_k: 10,
        top_p: 0.9,
        max_tokens: 1,
      }, token);
      displayPrediction(result || {});
    } catch (err) {
      if (resultsContainer) {
        resultsContainer.innerHTML = '<div class="card"><div class="form-alert error" style="margin:0;"><i class="fas fa-triangle-exclamation"></i><span>' +
          esc(err.message || 'Prediction failed') + '</span></div></div>';
      }
      ui.toast(err.message || 'Prediction failed', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  function displayPrediction(result) {
    const container = document.getElementById('pred-results');
    const predictions = result.predictions || result.top_tokens || [];
    const tokens = result.tokenization || result.tokens || [];

    const tokenContainer = document.getElementById('pred-tokenization');
    if (tokenContainer) {
      if (tokens.length) {
        tokenContainer.innerHTML = tokens.map((item, index) => `
          <span class="chip">
            <span class="mono">${esc(String(item && item.token != null ? item.token : item))}</span>
            <span style="color:var(--color-text-muted);">#${esc(item && item.id !== undefined ? item.id : index)}</span>
          </span>
        `).join('');
      } else {
        tokenContainer.innerHTML = '<span class="field-hint">The backend did not return token ids for this request.</span>';
      }
    }

    const probEmpty = document.getElementById('pred-prob-empty');
    const probCanvas = document.getElementById('pred-prob-chart');

    if (!predictions.length) {
      if (container) {
        container.innerHTML = ui.emptyState({
          icon: 'fa-circle-question',
          title: 'No predictions returned',
          text: 'The backend responded without a next-token distribution. The model may not be trained yet.',
          compact: true,
        });
      }
      if (probCanvas) probCanvas.style.display = 'none';
      if (probEmpty) probEmpty.classList.remove('hidden');
      return;
    }

    if (container) {
      container.innerHTML = predictions.map((item, index) => {
        const probability = Number(item.probability);
        const pct = Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) * 100 : 0;
        return `
          <article class="prediction-card">
            <div class="token-row">
              <span class="token-id">#${index + 1}</span>
              <span class="token-string" title="${esc(String(item.token != null ? item.token : (item.text || '')))}">${esc(String(item.token != null ? item.token : (item.text || '—')))}</span>
              <span class="token-probability">${Number.isFinite(probability) ? pct.toFixed(2) + '%' : '—'}</span>
            </div>
            <div class="probability-bar"><div class="probability-fill" style="width:${pct}%"></div></div>
            <div class="row-tight" style="justify-content:space-between; margin-top:var(--space-2); font-size:var(--text-label-small); color:var(--color-text-muted);">
              <span>Rank ${esc(item.rank || index + 1)}</span>
              <span>Logit ${item.logit !== undefined && item.logit !== null ? Number(item.logit).toFixed(4) : '—'}</span>
              <span>ID ${esc(item.id !== undefined && item.id !== null ? item.id : '—')}</span>
            </div>
          </article>
        `;
      }).join('');
    }

    const labels = predictions.map(item => String(item.token != null ? item.token : (item.text || '?')).slice(0, 12) || '·');
    const values = predictions.map(item => (Number.isFinite(Number(item.probability)) ? Number(item.probability) : 0));
    if (probCanvas) probCanvas.style.display = 'block';
    if (probEmpty) probEmpty.classList.add('hidden');
    if (window.charts) {
      probabilityChart = window.charts.createProbabilityChart('pred-prob-chart', labels, values);
    }
  }

  return { render, runPrediction };
})();
