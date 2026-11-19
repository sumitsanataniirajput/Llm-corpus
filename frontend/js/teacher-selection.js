/* ========================================
   CORPUS ULTIMATE — Teacher Selection Studio

   Builds a generation plan and saves it as a real draft distillation job on the
   backend (nothing is simulated locally). Modes:

     A single        one teacher answers every prompt
     B multi         two or more teachers answer independently
     C evaluator     a teacher answers, a *separate* evaluator scores it
     D competition   several teachers compete, the evaluator picks the winner
     E specialized   each subject routes to the teacher you assign

   The studio refuses locally the same things the API refuses server-side (mode B
   with one provider, modes C/D without an evaluator) so the owner sees the
   problem before a round trip — the server remains the authority.
   ======================================== */

window.teacherSelection = (function () {
  'use strict';

  const PROVIDER_TYPES = {
    single: { label: 'A — Single teacher', hint: 'One model answers every prompt.' },
    multi: { label: 'B — Multiple independent answers', hint: 'Every teacher answers the same prompt; all answers are kept for review.' },
    evaluator: { label: 'C — Teacher + evaluator', hint: 'A separate evaluator scores accuracy, relevance, completeness and instruction-following.' },
    competition: { label: 'D — Competition', hint: 'Teachers compete; the evaluator accepts the winner and rejects the rest.' },
    specialized: { label: 'E — Specialised by domain', hint: 'Route each subject to the teacher that is best at it.' },
  };

  const SUBJECTS = ['mathematics', 'coding', 'reasoning', 'language', 'science', 'general knowledge'];

  const STATE = {
    providers: [],
    options: null,
    mode: 'single',
    teachers: [],       // [{provider_id, model_id}]
    evaluators: [],
    subjectMap: {},     // subject -> provider_id
    loaded: false,
    error: null,
    lastJob: null,
  };

  function esc(value) { return ui.escapeHtml(value == null ? '' : String(value)); }
  function container() { return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null; }
  function currentRoute(hint) { return hint || (window.state && state.getRoute && state.getRoute()) || 'teacher-selection'; }

  function providerName(id) {
    const found = STATE.providers.find((item) => item.id === id);
    return found ? found.name : id;
  }

  function modelsOf(providerId) {
    const provider = STATE.providers.find((item) => item.id === providerId);
    return (provider && provider.models) || [];
  }

  async function load() {
    try {
      const token = await state.getAccessToken();
      const [providers, options] = await Promise.all([
        window.CORPUS_API.listProviders(token),
        window.CORPUS_API.getDistillationOptions(),
      ]);
      STATE.providers = (providers && providers.providers) || [];
      STATE.options = options || null;
      STATE.loaded = true;
      if (!STATE.providers.length) STATE.error = 'Connect an AI teacher first: Provider management → Add provider.';
    } catch (err) {
      STATE.error = (err && err.message) || 'Could not load providers.';
    }
  }

  /* ------------------------------------------------------------ selection */

  function setMode(mode) {
    if (!PROVIDER_TYPES[mode]) return;
    STATE.mode = mode;
    render();
  }

  function teacherEntry(providerId, modelId) {
    return { provider_id: providerId, model_id: modelId || null };
  }

  function parseEntry(value) {
    // value is "providerId::modelId"
    const [providerId, modelId] = String(value || '').split('::');
    return teacherEntry(providerId, modelId || null);
  }

  function addTeacher(value) {
    const entry = parseEntry(value);
    if (!entry.provider_id) return;
    if (STATE.teachers.some((item) => item.provider_id === entry.provider_id && item.model_id === entry.model_id)) return;
    STATE.teachers.push(entry);
    render();
  }

  function removeTeacher(index) {
    STATE.teachers.splice(index, 1);
    render();
  }

  function addEvaluator(value) {
    const entry = parseEntry(value);
    if (!entry.provider_id) return;
    if (STATE.evaluators.some((item) => item.provider_id === entry.provider_id && item.model_id === entry.model_id)) return;
    STATE.evaluators.push(entry);
    render();
  }

  function removeEvaluator(index) {
    STATE.evaluators.splice(index, 1);
    render();
  }

  function setSubjectTeacher(subject, providerId) {
    if (!providerId) delete STATE.subjectMap[subject];
    else STATE.subjectMap[subject] = providerId;
    render();
  }

  function validation() {
    const errors = [];
    if (!STATE.teachers.length) errors.push('Choose at least one teacher.');
    if (STATE.mode === 'multi') {
      const unique = new Set(STATE.teachers.map((item) => item.provider_id));
      if (unique.size < 2) errors.push('Mode B needs at least two different teacher providers.');
    }
    if (STATE.mode === 'evaluator' || STATE.mode === 'competition') {
      if (!STATE.evaluators.length) errors.push('This mode needs a separate evaluator model.');
      if (STATE.evaluators.length && STATE.evaluators.some((item) =>
        STATE.teachers.some((teacher) => teacher.provider_id === item.provider_id))) {
        errors.push('The evaluator should be a different provider from the teacher, otherwise it grades its own answer.');
      }
    }
    if (STATE.mode === 'specialized' && !Object.keys(STATE.subjectMap).length) {
      errors.push('Assign at least one subject to a teacher for mode E.');
    }
    return errors;
  }

  function buildPayload(extra) {
    const options = STATE.options || {};
    return Object.assign({
      mode: STATE.mode,
      teachers: STATE.teachers,
      evaluators: STATE.evaluators,
      subject_map: Object.entries(STATE.subjectMap).map(([subject, providerId]) => ({ subject, provider_id: providerId })),
      generation: {
        count: Number(($('#ts-count') || {}).value || 10),
        languages: [($('#ts-language') || {}).value || 'en'],
        subjects: [($('#ts-subject') || {}).value || 'general knowledge'],
        difficulties: [($('#ts-difficulty') || {}).value || 'beginner'],
        task_types: [($('#ts-task') || {}).value || 'instruction'],
        output_format: 'chat_jsonl',
      },
      quality: (options.quality_defaults || {}),
      budget: {
        max_requests: Number(($('#ts-max-requests') || {}).value || 200),
        max_tokens: Number(($('#ts-max-tokens') || {}).value || 400000),
        max_spend_usd: Number(($('#ts-max-spend') || {}).value || 5),
        max_concurrency: Number(($('#ts-concurrency') || {}).value || 4),
      },
      allow_external_send: true,
    }, extra || {});
  }

  function $(selector) { return document.querySelector(selector); }

  /* ------------------------------------------------------------ rendering */

  function providerOption(provider) {
    const models = (provider.models || []).filter((model) => model.enabled !== false);
    const defaultModel = provider.default_teacher_model
      || (models[0] && models[0].model_id)
      || '';
    return `<option value="${esc(provider.id)}::${esc(defaultModel)}">${esc(provider.name)} · ${esc(defaultModel || 'no model')}</option>`;
  }

  function chipRow(list, onRemove) {
    if (!list.length) return '<p class="muted">None selected yet.</p>';
    return `<div class="chip-row">${list.map((entry, index) => `
      <span class="chip chip-ok">${esc(providerName(entry.provider_id))} · ${esc(entry.model_id || 'default')}
        <button class="chip-remove" type="button" onclick="${onRemove}(${index})" aria-label="Remove">×</button>
      </span>`).join('')}</div>`;
  }

  function renderModeCards() {
    return `<div class="mode-grid">${Object.entries(PROVIDER_TYPES).map(([key, meta]) => `
      <button type="button" class="mode-card ${STATE.mode === key ? 'is-active' : ''}"
              onclick="teacherSelection.setMode('${key}')" aria-pressed="${STATE.mode === key}">
        <strong>${esc(meta.label)}</strong>
        <span>${esc(meta.hint)}</span>
      </button>`).join('')}</div>`;
  }

  function renderSpecialization() {
    if (STATE.mode !== 'specialized') return '';
    const subjects = (STATE.options && STATE.options.subjects) || SUBJECTS;
    return `<div class="card"><div class="card-header"><h3>Subject routing</h3></div>
      <div class="card-body form-grid">
        ${subjects.map((subject) => `
          <label>${esc(subject)}
            <select onchange="teacherSelection.setSubjectTeacher('${esc(subject)}', this.value)">
              <option value="">— no teacher —</option>
              ${STATE.providers.map((provider) => `<option value="${esc(provider.id)}"
                ${STATE.subjectMap[subject] === provider.id ? 'selected' : ''}>${esc(provider.name)}</option>`).join('')}
            </select>
          </label>`).join('')}
      </div></div>`;
  }

  async function render(routeHint) {
    const root = container();
    if (!root) return;
    if (!state.getUser()) {
      root.innerHTML = ui.emptyState({
        icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to design a teacher plan.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt',
      });
      return;
    }
    if (!STATE.loaded) {
      root.innerHTML = '<div class="page-header"><div class="page-header-copy"><h1 class="section-title">Teacher selection</h1></div></div>' + ui.skeletonCards(2);
      await load();
    }
    const errors = validation();
    const options = STATE.options || {};

    root.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-users-gear"></i> Teacher selection studio</span>
          <h1 class="section-title">Choose who teaches, and who checks</h1>
          <p class="section-subtitle">The plan is saved as a draft generation job. Nothing is sent to a provider until you start it.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="teacherSelection.reset()"><i class="fas fa-rotate-left"></i> Reset</button>
        </div>
      </div>
      ${STATE.error ? `<div class="alert alert-warning"><i class="fas fa-circle-info"></i><div>${esc(STATE.error)}</div></div>` : ''}
      ${renderModeCards()}
      <div class="card-grid two">
        <div class="card">
          <div class="card-header"><h3>Teachers</h3><span class="muted">${STATE.teachers.length} selected</span></div>
          <div class="card-body">
            <div class="inline-form">
              <select id="ts-teacher-pick" aria-label="Provider and model">
                ${STATE.providers.map(providerOption).join('') || '<option value="">No provider connected</option>'}
              </select>
              <button class="btn btn-sm btn-primary" type="button"
                onclick="teacherSelection.addTeacher(document.getElementById('ts-teacher-pick').value)">
                <i class="fas fa-plus"></i> Add teacher
              </button>
            </div>
            ${chipRow(STATE.teachers, 'teacherSelection.removeTeacher')}
            <h4 class="subheading">Evaluator (separate model)</h4>
            <div class="inline-form">
              <select id="ts-evaluator-pick" aria-label="Evaluator provider and model">
                ${STATE.providers.map(providerOption).join('') || '<option value="">No provider connected</option>'}
              </select>
              <button class="btn btn-sm btn-outline" type="button"
                onclick="teacherSelection.addEvaluator(document.getElementById('ts-evaluator-pick').value)">
                <i class="fas fa-scale-balanced"></i> Add evaluator
              </button>
            </div>
            ${chipRow(STATE.evaluators, 'teacherSelection.removeEvaluator')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>Generation settings</h3></div>
          <div class="card-body form-grid">
            <label>Examples per run
              <input id="ts-count" type="number" min="1" max="${Number(options.max_examples_per_run || 200)}" value="10" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
              <span class="field-help">Backend maximum: ${Number(options.max_examples_per_run || 200)} per run.</span>
            </label>
            <label>Task type
              <select id="ts-task">
                ${Object.entries(options.task_types || { instruction: { label: 'Instruction' } }).map(([key, meta]) =>
                  `<option value="${esc(key)}">${esc(meta.label || key)}</option>`).join('')}
              </select>
            </label>
            <label>Subject
              <select id="ts-subject">${(options.subjects || SUBJECTS).map((subject) =>
                `<option value="${esc(subject)}">${esc(subject)}</option>`).join('')}</select>
            </label>
            <label>Difficulty
              <select id="ts-difficulty">${(options.difficulties || ['beginner', 'intermediate', 'advanced']).map((d) =>
                `<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select>
            </label>
            <label>Language
              <select id="ts-language">${Object.entries(options.languages || { en: 'English' }).map(([code, name]) =>
                `<option value="${esc(code)}">${esc(name)}</option>`).join('')}</select>
            </label>
          </div>
        </div>
      </div>
      ${renderSpecialization()}
      <div class="card">
        <div class="card-header"><h3>Hard budget</h3></div>
        <div class="card-body form-grid">
          <label>Max requests <input id="ts-max-requests" type="number" min="1" value="200" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
          <label>Max tokens <input id="ts-max-tokens" type="number" min="1" value="400000" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
          <label>Max spend (USD) <input id="ts-max-spend" type="number" min="0" step="0.01" value="5" inputmode="decimal" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
          <label>Max concurrency <input id="ts-concurrency" type="number" min="1" max="8" value="4" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false"></label>
        </div>
        <div class="card-footer">
          <p class="field-help">The runner stops as soon as any limit is reached and records the reason on the job.</p>
        </div>
      </div>
      ${errors.length ? `<div class="alert alert-warning" role="alert"><i class="fas fa-triangle-exclamation"></i>
        <div><strong>The plan is not ready:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="actions-row">
        <button class="btn btn-primary" type="button" id="ts-save" onclick="teacherSelection.usePlan(this)"
          ${errors.length ? 'disabled' : ''}>
          <i class="fas fa-arrow-right"></i> Use this plan
        </button>
        <button class="btn btn-outline" type="button" onclick="teacherSelection.navigate('knowledge-distillation')">
          <i class="fas fa-droplet"></i> Go to distillation
        </button>
      </div>
      <div class="callout"><i class="fas fa-circle-info"></i>
        <p>Nothing is generated here. The plan is carried to the Knowledge Distillation page, where you pick the
        source dataset, confirm that its text may be sent externally, and create the job.</p></div>`;
  }

  function reset() {
    STATE.mode = 'single';
    STATE.teachers = [];
    STATE.evaluators = [];
    STATE.subjectMap = {};
    STATE.lastJob = null;
    render();
  }

  // A job needs source material, which is chosen on the distillation page. The
  // plan is therefore handed over in memory (never in localStorage) and the job
  // itself is created there, where the dataset and consent checkbox live.
  let pendingPlan = null;

  function usePlan(button) {
    const errors = validation();
    if (errors.length) {
      ui.toast(errors[0], 'error');
      return;
    }
    pendingPlan = buildPayload();
    if (button) ui.setButtonLoading(button, false);
    ui.toast('Plan ready — choose the dataset to create the job.', 'success');
    navigate('knowledge-distillation');
  }

  function takePlan() {
    const plan = pendingPlan;
    pendingPlan = null;
    return plan;
  }

  function hasPlan() {
    return !!pendingPlan;
  }

  function navigate(route) {
    if (window.router && window.router.navigate) window.router.navigate(route);
  }

  return {
    render,
    setMode,
    addTeacher,
    removeTeacher,
    addEvaluator,
    removeEvaluator,
    setSubjectTeacher,
    reset,
    usePlan,
    takePlan,
    hasPlan,
    navigate,
    // exposed for tests
    _state: () => ({ mode: STATE.mode, teachers: STATE.teachers, evaluators: STATE.evaluators,
                     subjectMap: STATE.subjectMap, providers: STATE.providers, lastJob: STATE.lastJob }),
    _validation: validation,
    _buildPayload: buildPayload,
  };
})();
