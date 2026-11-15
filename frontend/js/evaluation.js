/* ========================================
   CORPUS ULTIMATE — Evaluation Center page
   ======================================== */

window.evaluation = (function () {
  async function render() {
    const user = state.getUser();
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    if (!user) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-user-circle"></i><h3>Sign in required</h3><p>Please sign in to run evaluations.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="eval-header">
        <div>
          <h1 class="section-title">Evaluation Center</h1>
          <p class="section-subtitle">Run automated evaluations, benchmarks, and quality checks on your CORPUS models.</p>
        </div>
      </div>

      <div class="evaluation-grid">
        <div class="eval-card">
          <h4>Model Knowledge Test</h4>
          <p class="eval-result">Run a suite of knowledge questions against your trained model.</p>
          <button class="btn btn-primary" onclick="evaluation.runKnowledgeTest()">Run Test</button>
        </div>
        <div class="eval-card">
          <h4>Custom Questions</h4>
          <p class="eval-result">Provide your own questions and score model responses.</p>
          <button class="btn btn-outline" onclick="evaluation.customQuestions()">Configure</button>
        </div>
        <div class="eval-card">
          <h4>Hallucination Assessment</h4>
          <p class="eval-result">Heuristic check for factual consistency in generated responses.</p>
          <button class="btn btn-outline" onclick="evaluation.hallucinationCheck()">Run Assessment</button>
        </div>
        <div class="eval-card">
          <h4>Checkpoint Comparison</h4>
          <p class="eval-result">Compare two model checkpoints side by side.</p>
          <button class="btn btn-outline" onclick="evaluation.compareCheckpoints()">Compare</button>
        </div>
      </div>

      <div class="card" style="margin-top:var(--space-6); padding:var(--space-5);">
        <h3 style="margin-bottom:var(--space-4); font-size:var(--text-title-medium); color:var(--color-text);">Evaluation Results</h3>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Test</th><th>Model</th><th>Score</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody id="eval-results-body">
              <tr><td colspan="5" style="text-align:center; color:var(--color-text-variant);">No evaluations yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  async function runKnowledgeTest() {
    const activeModel = state.getActiveModel();
    if (!activeModel) {
      ui.toast('Please select a model first', 'error');
      return;
    }
    ui.toast('Knowledge test requires a trained model. Generate responses and score manually.', 'info');
  }

  function customQuestions() {
    ui.toast('Custom questions — enter questions in AI Chat and score responses manually.', 'info');
  }

  function hallucinationCheck() {
    ui.toast('Hallucination assessment is heuristic — does not prove factual correctness.', 'warning');
  }

  function compareCheckpoints() {
    ui.toast('Select two models in Models page to compare.', 'info');
  }

  return { render, runKnowledgeTest, customQuestions, hallucinationCheck, compareCheckpoints };
})();