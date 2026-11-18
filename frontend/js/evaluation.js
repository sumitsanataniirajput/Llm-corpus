/* ========================================
   CORPUS ULTIMATE — Evaluation Center

   Only real capabilities are offered: a manual Q&A smoke test that calls the
   inference API, a real evaluation list from the backend, and a checkpoint
   inventory. Automated scoring is not implemented server-side, so it is
   described instead of being faked.
   ======================================== */

window.evaluation = (function () {
  'use strict';

  const SMOKE_PROMPTS = [
    'What is this corpus about?',
    'Write one sentence that continues: The most important idea is',
    'Summarise your training data in a short paragraph.',
  ];

  let evaluations = [];
  let checkpoints = [];
  let loadError = null;

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
        text: 'Please sign in to inspect evaluations.',
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
          <span class="eyebrow"><i class="fas fa-check-double"></i> Quality</span>
          <h1 class="section-title">Evaluation Center</h1>
          <p class="section-subtitle">Inspect recorded evaluations, run a manual Q&amp;A smoke test and review saved checkpoints.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="evaluation.reload()">
            <i class="fas fa-rotate"></i> Refresh
          </button>
        </div>
      </div>

      <div class="evaluation-grid">
        <article class="eval-card">
          <h4><i class="fas fa-comment-dots" style="color:var(--color-accent);"></i> Q&amp;A smoke test</h4>
          <p class="eval-result">
            Sends ${SMOKE_PROMPTS.length} fixed prompts to
            ${activeModel ? '“' + esc(activeModel.name || activeModel.id) + '”' : 'the selected model'} and shows the raw replies.
            Scoring is manual — the backend has no automated grader.
          </p>
          <button class="btn btn-primary" type="button" data-eval-smoke onclick="evaluation.runSmokeTest(this)" ${activeModel ? '' : 'disabled title="Select a model first"'}>
            <i class="fas fa-play"></i> Run smoke test
          </button>
          ${activeModel ? '' : '<p class="field-hint" style="margin-top:var(--space-2);">Select a model on the Models page to enable this.</p>'}
          <div id="eval-smoke-output"></div>
        </article>

        <article class="eval-card">
          <h4><i class="fas fa-list-check" style="color:var(--color-accent);"></i> Recorded evaluations</h4>
          <p class="eval-result">
            <span class="value" id="eval-count">—</span><br>
            Evaluation records returned by <code class="mono">/api/v1/evaluations</code>.
          </p>
          <a class="btn btn-outline" href="#/statistics" onclick="event.preventDefault();router.navigate('statistics')">
            <i class="fas fa-chart-line"></i> Training metrics
          </a>
        </article>

        <article class="eval-card">
          <h4><i class="fas fa-save" style="color:var(--color-accent);"></i> Checkpoint inventory</h4>
          <p class="eval-result">
            <span class="value" id="eval-checkpoint-count">—</span><br>
            Checkpoints saved by finished training jobs, with the loss recorded at save time.
          </p>
          <div id="eval-checkpoints" class="field-hint">Loading checkpoints…</div>
        </article>

        <article class="eval-card">
          <h4><i class="fas fa-triangle-exclamation" style="color:var(--color-warning);"></i> Automated scoring</h4>
          <p class="eval-result">
            Not available. This deployment exposes no scoring, benchmarking or hallucination-detection endpoint,
            so CORPUS does not display accuracy or hallucination figures. Published benchmarks would require a
            separate evaluation service.
          </p>
          <button class="btn btn-outline" type="button" disabled title="No scoring endpoint in this deployment">
            <i class="fas fa-lock"></i> Unavailable
          </button>
        </article>
      </div>

      <section class="card" style="padding:0; overflow:hidden;">
        <div class="card-head" style="padding:var(--space-4) var(--space-4) 0;">
          <div>
            <h2 class="card-title">Evaluation results</h2>
            <p class="card-subtitle">Rows returned by the backend; empty cells mean the record has no value.</p>
          </div>
        </div>
        <div class="table-wrapper" style="border:none; border-radius:0;">
          <table>
            <thead>
              <tr><th>Evaluation</th><th>Model</th><th>Score</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody id="eval-results-body">
              <tr><td colspan="5" class="table-empty">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    await reload();
  }

  async function reload() {
    const token = await state.getAccessToken();
    const results = await Promise.allSettled([
      window.CORPUS_API.listEvaluations(token),
      window.CORPUS_API.listAllCheckpoints(token),
    ]);

    evaluations = listOf(results[0], 'evaluations');
    checkpoints = listOf(results[1], 'checkpoints');
    loadError = results[0].status === 'rejected'
      ? (results[0].reason && results[0].reason.message) || 'Evaluations unavailable'
      : null;

    const count = document.getElementById('eval-count');
    if (count) count.textContent = loadError ? '—' : String(evaluations.length);

    const ckptCount = document.getElementById('eval-checkpoint-count');
    if (ckptCount) ckptCount.textContent = results[1].status === 'fulfilled' ? String(checkpoints.length) : '—';

    renderCheckpoints();
    renderTable();
  }

  function listOf(result, key) {
    if (result.status !== 'fulfilled') return [];
    const value = result.value;
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value[key])) return value[key];
    return [];
  }

  function renderCheckpoints() {
    const container = document.getElementById('eval-checkpoints');
    if (!container) return;
    if (!checkpoints.length) {
      container.innerHTML = 'No checkpoints saved yet.';
      return;
    }
    const sorted = checkpoints.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    container.innerHTML = sorted.slice(0, 3).map(ckpt => `
      <div style="display:flex; justify-content:space-between; gap:var(--space-2); padding:var(--space-1) 0; border-bottom:1px solid var(--color-border);">
        <span class="mono" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(ckpt.id)}</span>
        <span>${ckpt.loss != null ? 'loss ' + Number(ckpt.loss).toFixed(4) : 'loss —'}</span>
      </div>
    `).join('') + (sorted.length > 3
      ? '<p class="field-hint" style="margin-top:var(--space-1);">Showing 3 of ' + sorted.length + ' checkpoints.</p>'
      : '');
  }

  function renderTable() {
    const body = document.getElementById('eval-results-body');
    if (!body) return;
    if (loadError) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(loadError) + '</td></tr>';
      return;
    }
    if (!evaluations.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">No evaluation records yet. Run the Q&amp;A smoke test to inspect raw model output.</td></tr>';
      return;
    }
    body.innerHTML = evaluations.map(item => `
      <tr>
        <td>${esc(item.name || item.test || item.id || '—')}</td>
        <td>${esc(item.model_id || item.model || '—')}</td>
        <td>${item.score != null || item.metric != null ? esc(item.score != null ? item.score : item.metric) : '—'}</td>
        <td>${item.status ? ui.statusBadge(item.status) : '—'}</td>
        <td>${esc(CORPUS_UTILS.formatDate(item.created_at || item.updated_at))}</td>
      </tr>
    `).join('');
  }

  async function runSmokeTest(sourceButton) {
    const activeModel = state.getActiveModel();
    if (!activeModel) {
      ui.toast('Select a model before running the smoke test.', 'error');
      return;
    }
    const container = document.getElementById('eval-smoke-output');
    if (!container) return;
    container.innerHTML = '<p class="field-hint"><i class="fas fa-circle-notch fa-spin"></i> Sending prompts to the inference API…</p>';

    const button = sourceButton || document.querySelector('[data-eval-smoke]');
    const operation = window.CORPUS_ACTIONS.beginOperation({
      kind: 'evaluation',
      name: 'Evaluation smoke test — ' + (activeModel.name || activeModel.id),
      state: window.CORPUS_ACTIONS.STATES.RUNNING,
      progress: 0,
    });
    if (button) window.CORPUS_ACTIONS.beginButton(button, 'Evaluating…');

    const token = await state.getAccessToken();
    const results = [];
    let completed = 0;
    for (const prompt of SMOKE_PROMPTS) {
      try {
        const response = await window.CORPUS_API.infer(activeModel.id, {
          text: prompt,
          temperature: 0.8,
          top_k: 50,
          top_p: 0.9,
          max_tokens: 80,
        }, token);
        const text = response && (response.response || response.text);
        results.push({ prompt, reply: text ? String(text) : null, error: null });
      } catch (err) {
        results.push({ prompt, reply: null, error: err && err.message ? err.message : 'Request failed' });
      }
      completed += 1;
      // Real progress: prompts answered out of prompts sent.
      window.CORPUS_ACTIONS.updateOperation(operation.id, {
        progress: Math.round((completed / SMOKE_PROMPTS.length) * 100),
        result: completed + ' of ' + SMOKE_PROMPTS.length + ' prompts answered.',
      });
    }
    if (button) window.CORPUS_ACTIONS.endButton(button);

    const failures = results.filter(item => item.error).length;
    if (failures === results.length) {
      window.CORPUS_ACTIONS.finishOperation(operation.id, window.CORPUS_ACTIONS.STATES.FAILED, {
        error: (results[0] && results[0].error) || 'Every prompt failed.',
      });
    } else if (failures > 0) {
      window.CORPUS_ACTIONS.finishOperation(operation.id, window.CORPUS_ACTIONS.STATES.FAILED, {
        error: failures + ' of ' + results.length + ' prompts failed — see the output above.',
        notify: false,
      });
      ui.toast(failures + ' of ' + results.length + ' prompts failed — see the output above.', 'warning', 7000);
    } else {
      window.CORPUS_ACTIONS.finishOperation(operation.id, window.CORPUS_ACTIONS.STATES.COMPLETED, {
        result: 'Evaluation completed successfully! ' + results.length + ' prompts answered.',
      });
    }

    container.innerHTML = '<div class="eval-output">' + results.map(item => `
      <div style="margin-bottom:var(--space-3);">
        <div class="chip accent" style="margin-bottom:var(--space-1);">Prompt</div>
        <div style="color:var(--color-text);">${esc(item.prompt)}</div>
        <div class="chip" style="margin:var(--space-2) 0 var(--space-1);">Model reply</div>
        <div style="color:${item.error ? 'var(--color-error)' : 'var(--color-text)'}; white-space:pre-wrap;">${esc(item.reply || ('Error: ' + item.error))}</div>
      </div>
    `).join('') + '</div>' +
      '<p class="field-hint" style="margin-top:var(--space-2);">Replies are raw model output. Judge quality yourself; no score is computed.</p>';
  }

  return { render, reload, runSmokeTest };
})();
