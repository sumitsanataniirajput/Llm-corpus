/* ========================================
   CORPUS ULTIMATE — Knowledge Distillation & Dataset Quality Review

   Two routes:

     #/knowledge-distillation  create a run (dataset + source material + plan +
                               consent + budget), start it, watch it, cancel it
     #/dataset-review          what the run actually produced: totals by
                               language/subject/teacher, validation outcomes,
                               per-record review, export and conversion

   Rules:
     * generation status and validation status are independent — a finished
       generation is not a finished dataset;
     * records are only exported or converted after a human (or the evaluator)
       accepted them; rejected and pending rows are never written into a dataset;
     * the export is downloaded with the bearer token, not linked publicly.
   ======================================== */

window.distillation = (function () {
  'use strict';

  const STATE = {
    options: null,
    datasets: [],
    jobs: [],
    job: null,
    summary: null,
    records: [],
    recordTotal: 0,
    filters: { status: '', language: '', subject: '', task_type: '', search: '' },
    selected: new Set(),
    error: null,
    notice: null,
    loading: false,
    timer: null,
    plan: null,
    planWarnings: [],
    providersCache: null,
    providerOptions: [],
  };

  function esc(value) { return ui.escapeHtml(value == null ? '' : String(value)); }
  function num(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : '—';
  }
  function na(value) { return value === null || value === undefined || value === '' ? 'Unavailable' : String(value); }
  function container() { return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null; }
  function currentRoute(hint) { return hint || (window.state && state.getRoute && state.getRoute()) || 'knowledge-distillation'; }
  function $(selector) { return document.querySelector(selector); }

  function deepCopy(value) {
    if (Array.isArray(value)) return value.map(deepCopy);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach((key) => { out[key] = deepCopy(value[key]); });
      return out;
    }
    return value;
  }

  function uniqueEntries(list) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((entry) => {
      if (!entry || !entry.provider_id) return;
      const key = String(entry.provider_id) + '::' + String(entry.model_id || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ provider_id: String(entry.provider_id), model_id: entry.model_id || null });
    });
    return out;
  }

  function listText(values) {
    return (Array.isArray(values) ? values : []).filter(Boolean).map(String).join(', ') || 'Unavailable';
  }

  function optionLabel(option) {
    return option ? String(option.textContent || '').trim() : 'Unavailable';
  }

  function providerModelIds(provider) {
    const models = Array.isArray(provider && provider.models)
      ? provider.models.filter((model) => model && model.enabled !== false)
      : [];
    const ids = models.map((model) => model.model_id || model.id || model.name).filter(Boolean).map(String);
    if (provider && provider.default_teacher_model) ids.unshift(String(provider.default_teacher_model));
    return Array.from(new Set(ids));
  }

  function entryValue(entry) {
    return String(entry.provider_id) + '::' + String(entry.model_id || '');
  }

  function stopTimer() {
    if (STATE.timer) clearInterval(STATE.timer);
    STATE.timer = null;
  }

  function jobIdFromRoute() {
    // Supported hashes: #/dataset-review and #/dataset-review/<job_id>
    const hash = (window.location && window.location.hash) || '';
    const match = hash.match(/dataset-review\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : (STATE.job ? STATE.job.id : '');
  }

  /* --------------------------------------------------------------- loading */

  async function loadOverview() {
    const token = await state.getAccessToken();
    const [options, datasets, jobs] = await Promise.all([
      window.CORPUS_API.getDistillationOptions(),
      window.CORPUS_API.listDatasets(token),
      window.CORPUS_API.listDistillationJobs(token),
    ]);
    STATE.options = options || null;
    STATE.datasets = window.CORPUS_API.asDatasetList(datasets);
    STATE.jobs = Array.isArray(jobs && jobs.jobs) ? jobs.jobs : [];
  }

  async function loadJob(jobId) {
    const token = await state.getAccessToken();
    const [job, summary] = await Promise.all([
      window.CORPUS_API.getDistillationJob(jobId, token),
      window.CORPUS_API.getDistillationSummary(jobId, token).catch(() => null),
    ]);
    STATE.job = job;
    STATE.summary = summary;
    return job;
  }

  async function loadRecords(jobId) {
    const token = await state.getAccessToken();
    const filters = Object.assign({ limit: 25, offset: 0 }, STATE.filters);
    Object.keys(filters).forEach((key) => {
      if (filters[key] === '' || filters[key] === null) delete filters[key];
    });
    const payload = await window.CORPUS_API.listDistillationRecords(jobId, filters, token);
    STATE.records = Array.isArray(payload && payload.records) ? payload.records : [];
    STATE.recordTotal = (payload && payload.total) || 0;
    // Keep a selection that is still visible after filtering; drop the rest.
    const present = new Set(STATE.records.map((record) => record.id));
    STATE.selected = new Set(Array.from(STATE.selected).filter((id) => present.has(id)));
  }

  /* ------------------------------------------------------ create-a-run view */

  function datasetOptions() {
    return STATE.datasets.map((dataset) => `<option value="${esc(dataset.id)}">${esc(dataset.name)}
      (${esc(dataset.status || 'unknown')}${dataset.token_count ? ' · ' + num(dataset.token_count) + ' tokens' : ''})</option>`).join('');
  }

  function planBanner() {
    const hasPending = window.teacherSelection && window.teacherSelection.hasPlan && window.teacherSelection.hasPlan();
    if (!hasPending && !STATE.plan) return '';
    const warning = STATE.planWarnings.length
      ? ' Review the provider warnings in section 2 before creating a job.'
      : '';
    return `<div class="alert alert-info"><i class="fas fa-arrow-right-arrow-left"></i>
      <div>A teacher plan is available. Check the exact teacher and evaluator selections, choose a dataset, and confirm external-send consent below.${esc(warning)}</div></div>`;
  }

  function renderCreate() {
    const options = STATE.options || {};
    return `
      <div class="card-grid two">
        <section class="card" aria-labelledby="kd-source-heading">
          <div class="card-header"><h3 id="kd-source-heading">1 · Source material</h3></div>
          <div class="card-body form-grid">
            <label>Dataset
              <select id="kd-dataset">${datasetOptions() || '<option value="">No dataset uploaded yet</option>'}</select>
            </label>
            <label>Extra source text (optional)
              <textarea id="kd-extra" rows="4" inputmode="text" enterkeyhint="enter"
                        autocapitalize="sentences" spellcheck="true"
                        placeholder="Paste notes or a specification to distill from"></textarea>
            </label>
            <button class="btn btn-sm btn-outline" type="button" onclick="distillation.previewSource(this)">
              <i class="fas fa-eye"></i> Show exactly what will be sent
            </button>
            <div id="kd-preview" class="preview-slot"></div>
            <div id="kd-source-errors" class="form-section-errors" role="alert" aria-live="polite"></div>
          </div>
        </section>
        <section class="card" aria-labelledby="kd-plan-heading">
          <div class="card-header"><h3 id="kd-plan-heading">2 · Generation plan</h3></div>
          <div class="card-body form-grid">
            <label>Mode
              <select id="kd-mode">
                ${Object.entries(options.modes || { single: { label: 'A — Single teacher' } }).map(([key, meta]) =>
                  `<option value="${esc(key)}">${esc(meta.label)}</option>`).join('')}
              </select>
            </label>
            <label>Teachers
              <select id="kd-teachers" multiple size="4" aria-label="Teachers"></select>
              <span class="field-help">Every selected teacher is sent with its real provider ID and model ID. Mode B needs two or more different providers.</span>
            </label>
            <label>Evaluators (separate providers for modes C/D)
              <select id="kd-evaluator" multiple size="3" aria-label="Evaluators"><option value="">— none —</option></select>
            </label>
            <label>Examples <input id="kd-count" type="number" min="1" inputmode="numeric"
              enterkeyhint="done" max="${Number(options.max_examples_per_run || 200)}" value="10" autocapitalize="off" spellcheck="false"></label>
            <label>Task
              <select id="kd-task">${Object.entries(options.task_types || { instruction: { label: 'Instruction' } }).map(([key, meta]) =>
                `<option value="${esc(key)}">${esc(meta.label || key)}</option>`).join('')}</select>
            </label>
            <label>Output format
              <select id="kd-format">${(options.output_formats || []).map((format) =>
                `<option value="${esc(format.key)}">${esc(format.label)}</option>`).join('')}</select>
            </label>
            <label>Max spend this run (USD) <input id="kd-spend" type="number" min="0" step="0.01"
              inputmode="decimal" enterkeyhint="done" value="5" autocapitalize="off" spellcheck="false"></label>
            <label>Max requests <input id="kd-requests" type="number" min="1" inputmode="numeric"
              enterkeyhint="done" value="200" autocapitalize="off" spellcheck="false"></label>
            <div id="kd-plan-summary" class="kd-plan-summary" aria-live="polite"></div>
            <div id="kd-plan-errors" class="form-section-errors" role="alert" aria-live="polite"></div>
          </div>
        </section>
      </div>
      <section class="card" aria-labelledby="kd-permission-heading">
        <div class="card-header"><h3 id="kd-permission-heading">3 · External-send permission</h3></div>
        <div class="card-body">
          <div class="alert alert-warning permission-explanation" role="note">
            <i class="fas fa-shield-halved"></i>
            <div>Creating this job sends only the selected dataset excerpt (shown by “Show exactly what will be sent”)
              to the external teacher/evaluator providers listed in section 2. Requests, token usage and cost are
              recorded. Create Job stays disabled until you explicitly allow this below.</div>
          </div>
          <label class="checkbox-row">
            <input type="checkbox" id="kd-consent">
            I allow the selected dataset excerpt (at most 4000 characters per request) to be sent to the
            teacher and evaluator providers chosen above.
          </label>
          <p class="field-help">This consent is mandatory and is sent as <code>allow_external_send</code>. It is not implied by a saved teacher plan.</p>
          <div id="kd-consent-errors" class="form-section-errors" role="alert" aria-live="polite"></div>
        </div>
        <div class="card-footer actions-row">
          <span id="kd-create-status" class="field-help" aria-live="polite"></span>
          <button class="btn btn-primary" type="button" id="kd-create" disabled aria-disabled="true"
                  onclick="distillation.createJob(this)">
            <i class="fas fa-play"></i> Create job
          </button>
        </div>
      </section>`;
  }

  function renderJobsTable() {
    if (!STATE.jobs.length) {
      return ui.emptyState({ icon: 'fa-droplet', title: 'No distillation runs yet',
        text: 'Create a run above: choose a dataset, a teacher plan and a budget.' });
    }
    return `<div class="table-scroll"><table class="table">
      <thead><tr><th>Job</th><th>Mode</th><th>Status</th><th>Records</th><th>Accepted</th><th>Created</th><th></th></tr></thead>
      <tbody>${STATE.jobs.map((job) => `
        <tr>
          <td><code>${esc(job.id)}</code><div class="muted">${esc(job.source_dataset_name || 'no dataset name')}</div></td>
          <td>${esc(job.mode)}</td>
          <td>${statusBadge(job.status)}</td>
          <td>${num(job.counts && job.counts.total)}</td>
          <td>${num(job.counts && job.counts.accepted)}</td>
          <td>${job.created_at ? ui.timeAgo(job.created_at) : '—'}</td>
          <td class="actions-row">
            ${['draft', 'failed', 'cancelled'].includes(job.status)
              ? `<button class="btn btn-sm btn-primary" type="button" onclick="distillation.start('${esc(job.id)}', this)"><i class="fas fa-play"></i> Start</button>`
              : ''}
            ${['queued', 'generating', 'validating'].includes(job.status)
              ? `<button class="btn btn-sm btn-outline" type="button" onclick="distillation.cancel('${esc(job.id)}', this)"><i class="fas fa-stop"></i> Cancel</button>`
              : ''}
            <button class="btn btn-sm btn-outline" type="button" onclick="distillation.review('${esc(job.id)}')"><i class="fas fa-list-check"></i> Review</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function statusBadge(status) {
    const map = {
      draft: 'pending', queued: 'pending', generating: 'busy', validating: 'busy',
      review: 'online', completed: 'online', failed: 'error', cancelled: 'offline',
    };
    return `<span class="status-badge ${map[status] || 'pending'}"><i class="fas fa-circle"></i> ${esc(status)}</span>`;
  }

  // Record status is a different vocabulary from job status: accepted records are
  // "done", rejected are "error", duplicates are "skipped".
  function recordBadge(status) {
    const map = {
      accepted: 'online', rejected: 'error', duplicate: 'offline',
      pending: 'pending', edited: 'busy',
    };
    return `<span class="status-badge ${map[status] || 'pending'}"><i class="fas fa-circle"></i> ${esc(status || 'pending')}</span>`;
  }

  function progressBlock(job) {
    if (!job) return '';
    const progress = job.progress || {};
    const total = job.generation_config && job.generation_config.count;
    const generated = progress.generated || 0;
    const pct = total ? Math.min(100, Math.round((generated / total) * 100)) : null;
    return `<div class="card">
      <div class="card-header"><h3>Current run · <code>${esc(job.id)}</code></h3>${statusBadge(job.status)}</div>
      <div class="card-body">
        <div class="progress"><div class="progress-bar" style="width:${pct == null ? 0 : pct}%"></div></div>
        <p class="muted">${pct == null ? 'Progress needs a planned example count.' : pct + '% of the planned examples'}</p>
        <dl class="kv-list">
          <div><dt>Generated</dt><dd>${num(generated)} / ${num(total)}</dd></div>
          <div><dt>Accepted</dt><dd>${num(progress.accepted)}</dd></div>
          <div><dt>Rejected</dt><dd>${num(progress.rejected)}</dd></div>
          <div><dt>Duplicates</dt><dd>${num(progress.duplicates)}</dd></div>
          <div><dt>Failed calls</dt><dd>${num(progress.failed_calls)}</dd></div>
          <div><dt>Budget stop</dt><dd>${progress.budget && progress.budget.stop_reason ? esc(progress.budget.stop_reason) : 'None'}</dd></div>
        </dl>
        ${job.error ? `<p class="text-error">${esc(job.error)}</p>` : ''}
      </div>
    </div>`;
  }

  async function renderDistillation(routeHint) {
    const root = container();
    if (!root) return;
    if (!state.getUser()) {
      root.innerHTML = ui.emptyState({ icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to generate training data.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt' });
      return;
    }
    if (!STATE.options) {
      try { await loadOverview(); } catch (err) { STATE.error = (err && err.message) || 'Could not load distillation data.'; }
    }
    root.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-droplet"></i> Knowledge distillation</span>
          <h1 class="section-title">Turn a dataset into teacher-generated training data</h1>
          <p class="section-subtitle">The teacher produces knowledge; the student model learns from what you approve.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="distillation.refresh(this)"><i class="fas fa-rotate"></i> Refresh</button>
        </div>
      </div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      ${planBanner()}
      ${renderCreate()}
      <div id="kd-progress">${progressBlock(STATE.job)}</div>
      <div class="section-block">
        <h2 class="section-heading">Runs</h2>
        <div id="kd-jobs">${renderJobsTable()}</div>
      </div>`;
    await fillTeacherSelects();
    await prefillFromPlan();
    bindValidationEvents();
  }

  function pushWarning(message) {
    if (message && STATE.planWarnings.indexOf(message) === -1) STATE.planWarnings.push(message);
  }

  function optionMarkup(option) {
    return `<option value="${esc(option.value)}" data-available="1" data-provider-id="${esc(option.providerId)}" data-model-id="${esc(option.modelId)}">${esc(option.label)}</option>`;
  }

  async function fillTeacherSelects() {
    let providers = STATE.providersCache;
    if (!providers) {
      try {
        const token = await state.getAccessToken();
        const payload = await window.CORPUS_API.listProviders(token);
        providers = payload && Array.isArray(payload.providers) ? payload.providers : [];
      } catch (err) {
        providers = [];
        STATE.error = (err && err.message) || 'Could not load teacher providers.';
      }
      STATE.providersCache = providers;
    }
    const options = [];
    (Array.isArray(providers) ? providers : []).forEach((provider) => {
      if (!provider || provider.enabled === false) return;
      providerModelIds(provider).forEach((modelId) => {
        options.push({
          value: String(provider.id) + '::' + modelId,
          providerId: String(provider.id),
          modelId,
          label: String(provider.name || provider.id) + ' · ' + modelId,
        });
      });
    });
    const seen = new Set();
    STATE.providerOptions = options.filter((option) => {
      if (seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
    const teacherSelect = $('#kd-teachers');
    const evaluatorSelect = $('#kd-evaluator');
    if (!teacherSelect || !evaluatorSelect) return;
    const optionHtml = STATE.providerOptions.map(optionMarkup).join('');
    teacherSelect.innerHTML = optionHtml || '<option value="">No provider connected</option>';
    evaluatorSelect.innerHTML = '<option value="">— none —</option>' + optionHtml;
  }

  function resolvePlanEntry(entry, role) {
    const providerId = String(entry.provider_id || '');
    const requestedModel = String(entry.model_id || '');
    const originalValue = entryValue({ provider_id: providerId, model_id: requestedModel || null });
    const providers = Array.isArray(STATE.providersCache) ? STATE.providersCache : [];
    const provider = providers.find((item) => item && item.id === providerId && item.enabled !== false);
    if (!provider) {
      const warning = `${role} provider '${providerId}' is not available for this account. Connect or enable it in Provider Management; the original selection is preserved below but cannot be submitted.`;
      return { unavailable: true, value: originalValue, warning,
        label: `Unavailable · ${providerId} · ${requestedModel || 'default'}` };
    }
    const models = providerModelIds(provider);
    const fallback = String(provider.default_teacher_model || models[0] || '');
    const selectedModel = requestedModel && models.indexOf(requestedModel) !== -1
      ? requestedModel : fallback;
    if (!selectedModel) {
      const warning = `${role} provider '${provider.name || providerId}' has no available model. Discover models in Provider Management before submitting.`;
      return { unavailable: true, value: originalValue, warning,
        label: `Unavailable · ${provider.name || providerId} · no model` };
    }
    const value = String(provider.id) + '::' + selectedModel;
    const warning = requestedModel && models.indexOf(requestedModel) === -1
      ? `${role} model '${requestedModel}' is not registered for '${provider.name || providerId}'; using available model '${selectedModel}' instead.`
      : null;
    return { unavailable: false, value, warning, label: `${provider.name || providerId} · ${selectedModel}` };
  }

  function addUnavailableOption(select, resolved) {
    if (!select || !resolved || !resolved.unavailable) return;
    let option = Array.from(select.options || []).find((item) => item.value === resolved.value);
    if (!option) {
      option = document.createElement('option');
      option.value = resolved.value;
      option.textContent = resolved.label;
      option.disabled = true;
      select.appendChild(option);
    }
    option.setAttribute('data-available', '0');
    option.setAttribute('data-warning', resolved.warning);
    option.selected = true;
  }

  function setSelectedValues(select, values) {
    if (!select) return;
    const wanted = new Set(values.filter(Boolean));
    Array.from(select.options || []).forEach((option) => {
      option.selected = wanted.has(option.value);
    });
  }

  function setFieldValue(selector, value) {
    const el = $(selector);
    if (!el || value === null || value === undefined || value === '') return;
    if (el.tagName === 'SELECT') {
      const match = Array.from(el.options || []).some((option) => option.value === String(value));
      if (match) el.value = String(value);
      return;
    }
    el.value = String(value);
  }

  function applyPlanToForm(plan) {
    const generation = plan.generation || {};
    const budget = plan.budget || {};
    setFieldValue('#kd-mode', plan.mode);
    setFieldValue('#kd-count', generation.count);
    setFieldValue('#kd-task', Array.isArray(generation.task_types) ? generation.task_types[0] : null);
    setFieldValue('#kd-format', generation.output_format);
    setFieldValue('#kd-spend', budget.max_spend_usd);
    setFieldValue('#kd-requests', budget.max_requests);
  }

  function applyPlanSelections(plan) {
    STATE.planWarnings = [];
    const teacherSelect = $('#kd-teachers');
    const evaluatorSelect = $('#kd-evaluator');
    const teacherValues = [];
    const evaluatorValues = [];
    uniqueEntries(plan.teachers).forEach((entry) => {
      const resolved = resolvePlanEntry(entry, 'Teacher');
      if (resolved.warning) pushWarning(resolved.warning);
      addUnavailableOption(teacherSelect, resolved);
      teacherValues.push(resolved.value);
    });
    uniqueEntries(plan.evaluators).forEach((entry) => {
      const resolved = resolvePlanEntry(entry, 'Evaluator');
      if (resolved.warning) pushWarning(resolved.warning);
      addUnavailableOption(evaluatorSelect, resolved);
      evaluatorValues.push(resolved.value);
    });
    setSelectedValues(teacherSelect, teacherValues);
    setSelectedValues(evaluatorSelect, evaluatorValues);
  }

  async function prefillFromPlan() {
    const pending = window.teacherSelection && typeof window.teacherSelection.takePlan === 'function'
      && window.teacherSelection.hasPlan && window.teacherSelection.hasPlan()
      ? window.teacherSelection.takePlan() : null;
    if (pending) {
      STATE.plan = deepCopy(pending);
      if (window.teacherSelection && typeof window.teacherSelection.clearPlan === 'function') {
        window.teacherSelection.clearPlan();
      }
    }
    const plan = STATE.plan;
    if (!plan) {
      updateValidationUI();
      return;
    }
    if (!STATE.providerOptions.length && !STATE.providersCache) await fillTeacherSelects();
    applyPlanToForm(plan);
    applyPlanSelections(plan);
    syncPlanFromForm();
    updateValidationUI();
  }

  function syncPlanFromForm() {
    if (!STATE.plan) return null;
    const base = deepCopy(STATE.plan);
    const generation = deepCopy(base.generation || {});
    const budget = deepCopy(base.budget || {});
    generation.count = Number(($('#kd-count') || {}).value || 10);
    generation.task_types = [($('#kd-task') || {}).value || 'instruction'];
    generation.output_format = ($('#kd-format') || {}).value || 'chat_jsonl';
    budget.max_spend_usd = Number(($('#kd-spend') || {}).value || 5);
    budget.max_requests = Number(($('#kd-requests') || {}).value || 200);
    STATE.plan = Object.assign(base, {
      mode: ($('#kd-mode') || {}).value || base.mode || 'single',
      teachers: uniqueEntries(selectedValues($('#kd-teachers')).map(parseEntry)),
      evaluators: uniqueEntries(selectedValues($('#kd-evaluator')).map(parseEntry)),
      generation,
      budget,
    });
    return STATE.plan;
  }

  function selectedValues(select) {
    if (!select) return [];
    return Array.from(select.selectedOptions || []).map((option) => option.value).filter(Boolean);
  }

  function parseEntry(value) {
    const [provider_id, model_id] = String(value || '').split('::');
    return { provider_id, model_id: model_id || null };
  }

  function selectedOptionRows(select) {
    return Array.from(select && select.selectedOptions ? select.selectedOptions : [])
      .filter((option) => option && option.value);
  }

  function unavailableRows(select) {
    return selectedOptionRows(select).filter((option) => option.getAttribute('data-available') === '0');
  }

  function renderPlanSummary(check) {
    const slot = $('#kd-plan-summary');
    if (!slot) return;
    const plan = STATE.plan || {};
    const generation = plan.generation || {};
    const budget = plan.budget || {};
    const chipRow = (rows, empty) => rows.length
      ? rows.map((option) => `<span class="chip ${option.getAttribute('data-available') === '0' ? 'chip-warning' : 'chip-ok'}">${esc(optionLabel(option))}</span>`).join('')
      : `<span class="muted">${esc(empty)}</span>`;
    const warnings = STATE.planWarnings.length
      ? `<div class="plan-warning-list">${STATE.planWarnings.map((warning) => `<div class="alert alert-warning"><i class="fas fa-triangle-exclamation"></i><div>${esc(warning)}</div></div>`).join('')}</div>`
      : '';
    slot.innerHTML = `
      <div class="kd-summary-grid">
        <div><span class="kd-summary-label">Mode</span><strong>${esc(check.mode)}</strong></div>
        <div><span class="kd-summary-label">Examples</span><strong>${esc(($('#kd-count') || {}).value || generation.count || '—')}</strong></div>
        <div><span class="kd-summary-label">Languages</span><span>${esc(listText(generation.languages))}</span></div>
        <div><span class="kd-summary-label">Subjects</span><span>${esc(listText(generation.subjects))}</span></div>
        <div><span class="kd-summary-label">Difficulties</span><span>${esc(listText(generation.difficulties))}</span></div>
        <div><span class="kd-summary-label">Budget</span><span>${esc(num(budget.max_spend_usd))} USD · ${esc(num(budget.max_requests))} requests · ${esc(num(budget.max_tokens))} tokens</span></div>
        <div class="kd-summary-wide"><span class="kd-summary-label">Teachers</span><div class="chip-row">${chipRow(selectedOptionRows($('#kd-teachers')), 'No teacher selected')}</div></div>
        <div class="kd-summary-wide"><span class="kd-summary-label">Evaluators</span><div class="chip-row">${chipRow(selectedOptionRows($('#kd-evaluator')), 'None (single/multi mode)')}</div></div>
      </div>${warnings}`;
  }

  function validationState() {
    const errors = { source: [], plan: [], permission: [] };
    const datasetId = ($('#kd-dataset') || {}).value || '';
    const mode = ($('#kd-mode') || {}).value || 'single';
    const teachers = uniqueEntries(selectedValues($('#kd-teachers')).map(parseEntry));
    const evaluators = uniqueEntries(selectedValues($('#kd-evaluator')).map(parseEntry));
    const consent = $('#kd-consent');
    const sourceErrors = errors.source;
    const planErrors = errors.plan;
    if (!datasetId) sourceErrors.push('Section 1 · Choose a source dataset.');
    if (!teachers.length) planErrors.push('Section 2 · Select at least one available teacher.');
    unavailableRows($('#kd-teachers')).forEach((option) => {
      planErrors.push('Section 2 · Teacher is unavailable: ' + optionLabel(option) + '. Connect/enable that provider or remove this selection.');
    });
    unavailableRows($('#kd-evaluator')).forEach((option) => {
      planErrors.push('Section 2 · Evaluator is unavailable: ' + optionLabel(option) + '. Connect/enable that provider or remove this selection.');
    });
    if ((mode === 'evaluator' || mode === 'competition') && !evaluators.length) {
      planErrors.push('Section 2 · This mode requires at least one separate evaluator.');
    }
    if (evaluators.length && evaluators.some((evaluator) => teachers.some((teacher) => teacher.provider_id === evaluator.provider_id))) {
      planErrors.push('Section 2 · Choose an evaluator from a different provider than every teacher.');
    }
    if (mode === 'multi' && new Set(teachers.map((teacher) => teacher.provider_id)).size < 2) {
      planErrors.push('Section 2 · Mode B requires at least two different teacher providers.');
    }
    if (mode === 'specialized' && !(STATE.plan && Array.isArray(STATE.plan.subject_map) && STATE.plan.subject_map.length)) {
      planErrors.push('Section 2 · Mode E needs subject routing from the Teacher Selection Studio.');
    }
    const count = Number(($('#kd-count') || {}).value || 0);
    if (!Number.isFinite(count) || count < 1) planErrors.push('Section 2 · Examples must be a positive number.');
    const spend = Number(($('#kd-spend') || {}).value || 0);
    const requests = Number(($('#kd-requests') || {}).value || 0);
    if (!Number.isFinite(spend) || spend < 0) planErrors.push('Section 2 · Max spend cannot be negative.');
    if (!Number.isFinite(requests) || requests < 1) planErrors.push('Section 2 · Max requests must be at least one.');
    if (!consent || !consent.checked) {
      errors.permission.push('Section 3 · Check external-send consent after reviewing the exact excerpt and providers.');
    }
    const allErrors = sourceErrors.concat(planErrors, errors.permission);
    return { errors, warnings: STATE.planWarnings.slice(), allErrors, valid: allErrors.length === 0,
      datasetId, mode, teachers, evaluators, consentChecked: !!(consent && consent.checked) };
  }

  function renderErrors(element, messages) {
    if (!element) return;
    element.innerHTML = messages.length
      ? `<strong>Before you can create a job:</strong><ul>${messages.map((message) => `<li>${esc(message)}</li>`).join('')}</ul>`
      : '';
    element.classList.toggle('hidden', messages.length === 0);
  }

  function updateValidationUI() {
    const check = validationState();
    renderErrors($('#kd-source-errors'), check.errors.source);
    renderErrors($('#kd-plan-errors'), check.errors.plan);
    renderErrors($('#kd-consent-errors'), check.errors.permission);
    const button = $('#kd-create');
    if (button) {
      button.disabled = !check.valid;
      button.setAttribute('aria-disabled', String(!check.valid));
    }
    const status = $('#kd-create-status');
    if (status) {
      status.textContent = check.valid
        ? 'All required fields are ready. The draft job will not contact providers.'
        : 'Missing: ' + check.allErrors[0];
    }
    renderPlanSummary(check);
    return check;
  }

  function bindValidationEvents() {
    const ids = ['kd-dataset', 'kd-extra', 'kd-mode', 'kd-teachers', 'kd-evaluator', 'kd-count',
      'kd-task', 'kd-format', 'kd-spend', 'kd-requests', 'kd-consent'];
    const handler = () => { syncPlanFromForm(); updateValidationUI(); };
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.dataset.kdValidationBound === '1') return;
      el.dataset.kdValidationBound = '1';
      el.addEventListener('change', handler);
      el.addEventListener('input', handler);
    });
    updateValidationUI();
  }

  async function createJob(button) {
    syncPlanFromForm();
    const check = updateValidationUI();
    if (!check.valid) return;
    const plan = STATE.plan || {};
    const generation = Object.assign({}, deepCopy(plan.generation || {}), {
      count: Number(($('#kd-count') || {}).value || 10),
      task_types: [($('#kd-task') || {}).value || 'instruction'],
      output_format: ($('#kd-format') || {}).value || 'chat_jsonl',
    });
    if (!Array.isArray(generation.languages) || !generation.languages.length) generation.languages = ['en'];
    if (!Array.isArray(generation.subjects) || !generation.subjects.length) generation.subjects = ['general knowledge'];
    if (!Array.isArray(generation.difficulties) || !generation.difficulties.length) generation.difficulties = ['beginner'];
    const budget = Object.assign({}, deepCopy(plan.budget || {}), {
      max_spend_usd: Number(($('#kd-spend') || {}).value || 5),
      max_requests: Number(($('#kd-requests') || {}).value || 200),
    });
    const payload = {
      dataset_id: check.datasetId,
      mode: check.mode,
      teachers: check.teachers,
      evaluators: check.evaluators,
      generation,
      quality: deepCopy(plan.quality || {}),
      budget,
      allow_external_send: check.consentChecked === true,
    };
    if (Array.isArray(plan.subject_map) && plan.subject_map.length) payload.subject_map = deepCopy(plan.subject_map);
    const extra = (($('#kd-extra') || {}).value || '').trim();
    if (extra) payload.extra_source_text = extra;

    ui.setButtonLoading(button, true, 'Creating…');
    try {
      const token = await state.getAccessToken();
      const job = await window.CORPUS_API.createDistillationJob(payload, token);
      STATE.job = job;
      STATE.plan = null;
      STATE.planWarnings = [];
      if (window.teacherSelection && typeof window.teacherSelection.clearPlan === 'function') {
        window.teacherSelection.clearPlan();
      }
      ui.toast('Draft job created. Start it when you are ready.', 'success');
      await loadOverview();
      await renderDistillation();
    } catch (err) {
      ui.toast((err && err.message) || 'Could not create the job.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function previewSource(button) {
    const datasetId = ($('#kd-dataset') || {}).value;
    const taskType = ($('#kd-task') || {}).value || 'instruction';
    if (!datasetId) { ui.toast('Choose a dataset first.', 'error'); return; }
    ui.setButtonLoading(button, true, 'Loading…');
    try {
      const preview = await window.CORPUS_API.previewDistillationSource({
        dataset_id: datasetId, task_type: taskType,
      });
      const slot = $('#kd-preview');
      if (slot) {
        slot.innerHTML = `<div class="preview-box">
          <p class="muted">${esc(preview.source && preview.source.file_name ? preview.source.file_name : 'dataset')} ·
            ${num(preview.source && preview.source.characters_available_to_teachers)} characters are available ·
            ${esc(preview.source && preview.source.truncated ? 'truncated' : 'complete')}</p>
          <pre class="code-block">${esc(preview.prompt)}</pre>
          <p class="field-help">${esc(preview.note)}</p>
        </div>`;
      }
    } catch (err) {
      ui.toast((err && err.message) || 'Could not build the preview.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function start(jobId, button) {
    ui.setButtonLoading(button, true, 'Starting…');
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.startDistillationJob(jobId, token);
      ui.toast('Generation queued. Progress is written by the backend runner.', 'success');
      await loadOverview();
      await loadJob(jobId);
      await renderDistillation();
      watch(jobId);
    } catch (err) {
      ui.toast((err && err.message) || 'Could not start the job.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function cancel(jobId, button) {
    ui.setButtonLoading(button, true, 'Cancelling…');
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.cancelDistillationJob(jobId, token);
      ui.toast('Job cancelled. Records already generated are kept.', 'success');
      await loadOverview();
      await loadJob(jobId);
      await renderDistillation();
    } catch (err) {
      ui.toast((err && err.message) || 'Could not cancel the job.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  // Only the two live sections are repainted. Rebuilding the whole page here
  // used to replace the form — and the focused input / soft keyboard — every
  // five seconds while a run was active, which is the reported "I can't type
  // into the fields" behaviour. The shared form-state guard in components.js
  // is a second line of defence for the user-initiated full renders.
  function updateLiveSections() {
    const progress = document.getElementById('kd-progress');
    if (progress) progress.innerHTML = progressBlock(STATE.job);
    const jobs = document.getElementById('kd-jobs');
    if (jobs) jobs.innerHTML = renderJobsTable();
  }

  function watch(jobId) {
    stopTimer();
    STATE.timer = setInterval(async () => {
      if (!document.querySelector('#kd-dataset')) { stopTimer(); return; }
      try {
        const job = await loadJob(jobId);
        if (!['queued', 'generating', 'validating'].includes(job.status)) {
          stopTimer();
          await loadOverview();
        }
        // Counters, status pill and progress bar are repainted from the freshly
        // read job so they can never disagree with each other.
        if (currentRoute() === 'knowledge-distillation') updateLiveSections();
      } catch (err) { stopTimer(); }
    }, 5000);
  }

  async function refresh(button) {
    if (button) ui.setButtonLoading(button, true, 'Refreshing…');
    try {
      await loadOverview();
      if (STATE.job) await loadJob(STATE.job.id);
      if (currentRoute() === 'dataset-review') await renderReview();
      else await renderDistillation();
    } finally {
      if (button) ui.setButtonLoading(button, false);
    }
  }

  function review(jobId) {
    STATE.job = { id: jobId };
    if (window.router && window.router.navigate) window.router.navigate('dataset-review');
  }

  /* ------------------------------------------------------------- review view */

  function summaryCards(summary) {
    const counts = (summary && summary.counts) || {};
    const usage = (summary && summary.usage) || {};
    const quality = (summary && summary.quality) || {};
    return `<div class="stats-grid">
      ${stat('Generated', counts.total)}
      ${stat('Accepted', counts.accepted)}
      ${stat('Rejected', counts.rejected)}
      ${stat('Duplicates', counts.duplicates)}
      ${stat('Pending review', counts.pending)}
      ${stat('Validation failures', summary && summary.validation_failures)}
      ${stat('Avg quality', quality.avg_score == null ? '—' : Number(quality.avg_score).toFixed(3))}
      ${stat('Total tokens', usage.total_tokens)}
      ${stat('Estimated cost', usage.estimated_cost == null ? '—' : '$' + Number(usage.estimated_cost).toFixed(4))}
    </div>`;
  }

  function stat(label, value) {
    return `<div class="stat-card"><div><div class="stat-value">${value === null || value === undefined ? '—' : num(value)}</div>
      <div class="stat-label">${esc(label)}</div></div></div>`;
  }

  function breakdown(summary) {
    if (!summary) return '';
    const teachers = summary.teacher_contribution || [];
    const languages = summary.by_language || [];
    return `<div class="card-grid two">
      <div class="card"><div class="card-header"><h3>Teacher contribution</h3></div>
        <div class="card-body">${teachers.length ? `<div class="table-scroll"><table class="table compact">
          <thead><tr><th>Teacher</th><th>Model</th><th>Records</th><th>Accepted</th><th>Share</th></tr></thead>
          <tbody>${teachers.map((row) => `<tr><td>${esc(row.provider_name)}</td><td><code>${esc(row.model_id)}</code></td>
            <td>${num(row.total)}</td><td>${num(row.accepted)}</td><td>${row.share_percent}%</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">No generated records yet.</p>'}</div></div>
      <div class="card"><div class="card-header"><h3>By language</h3></div>
        <div class="card-body">${languages.length ? `<div class="table-scroll"><table class="table compact">
          <thead><tr><th>Language</th><th>Records</th><th>Accepted</th></tr></thead>
          <tbody>${languages.map((row) => `<tr><td>${esc(row.language)}</td><td>${num(row.total)}</td>
            <td>${num(row.accepted)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing generated yet.</p>'}
        </div></div>
    </div>`;
  }

  function recordRow(record) {
    const provenance = record.provenance || {};
    const validation = record.validation || {};
    const reasons = (validation.reasons || []).join(' ');
    return `<tr data-record="${esc(record.id)}">
      <td><input type="checkbox" class="kd-select" value="${esc(record.id)}" ${STATE.selected.has(record.id) ? 'checked' : ''} onchange="distillation.toggleSelect(this)"></td>
      <td><div class="record-instruction">${esc(record.instruction || '(no instruction)')}</div>
          <div class="muted">${esc(record.task_type)} · ${esc(record.subject || '—')} · ${esc(record.language)} · ${esc(record.difficulty)}</div></td>
      <td><div class="record-answer">${esc((record.target || record.chosen || '').slice(0, 280))}</div>
          ${reasons ? `<div class="muted">${esc(reasons)}</div>` : ''}</td>
      <td><code>${esc(provenance.provider_name || '—')}</code>
          <div class="muted">${esc(provenance.model_id || '')}</div>
          <div class="muted provenance-id">req ${esc(provenance.request_id || '—')}</div></td>
      <td>${record.quality_score == null ? '—' : Number(record.quality_score).toFixed(3)}</td>
      <td>${recordBadge(record.status)}${record.reviewed_by_human ? '<div class="muted">human</div>' : ''}</td>
      <td class="actions-row">
        <button class="btn btn-xs btn-primary" type="button" onclick="distillation.setStatus('${esc(record.id)}', 'accepted', this)">Accept</button>
        <button class="btn btn-xs btn-outline" type="button" onclick="distillation.setStatus('${esc(record.id)}', 'rejected', this)">Reject</button>
        <button class="btn btn-xs btn-outline" type="button" onclick="distillation.editRecord('${esc(record.id)}', this)">Edit</button>
      </td>
    </tr>`;
  }

  async function renderReview(routeHint) {
    const root = container();
    if (!root) return;
    if (!state.getUser()) {
      root.innerHTML = ui.emptyState({ icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to review generated data.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt' });
      return;
    }
    if (!STATE.jobs.length && !STATE.options) {
      try { await loadOverview(); } catch (err) { STATE.error = (err && err.message) || 'Could not load runs.'; }
    }
    const jobId = jobIdFromRoute() || (STATE.jobs[0] && STATE.jobs[0].id) || '';
    if (jobId) {
      try {
        if (!STATE.job || STATE.job.id !== jobId) await loadJob(jobId);
        await loadRecords(jobId);
      } catch (err) {
        STATE.error = (err && err.message) || 'Could not load this run.';
      }
    }
    const summary = STATE.summary;
    root.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-list-check"></i> Dataset quality review</span>
          <h1 class="section-title">What the teachers produced</h1>
          <p class="section-subtitle">Every record carries its provider, model, request ID, tokens and the validation result.
          Nothing is exported until it is accepted.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="distillation.refresh(this)"><i class="fas fa-rotate"></i> Refresh</button>
        </div>
      </div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      <div class="inline-form">
        <label>Run
          <select onchange="distillation.selectJob(this.value)">
            ${STATE.jobs.map((job) => `<option value="${esc(job.id)}" ${job.id === jobId ? 'selected' : ''}>
              ${esc(job.id)} · ${esc(job.mode)} · ${esc(job.status)}</option>`).join('') || '<option value="">No runs yet</option>'}
          </select>
        </label>
        ${summary ? `<span class="muted">Generation status: <strong>${esc(summary.status)}</strong></span>` : ''}
      </div>
      ${summary ? summaryCards(summary) : ''}
      ${breakdown(summary)}
      <div class="card">
        <div class="card-header"><h3>Records</h3>
          <span class="muted">${num(STATE.recordTotal)} match the current filters</span></div>
        <div class="card-body">
          <div class="filter-row">
            <select id="kd-filter-status" onchange="distillation.applyFilters()">
              ${['', 'pending', 'accepted', 'rejected', 'duplicate'].map((value) =>
                `<option value="${value}" ${STATE.filters.status === value ? 'selected' : ''}>${value || 'any status'}</option>`).join('')}
            </select>
            <input id="kd-filter-language" placeholder="language" inputmode="text" enterkeyhint="search"
                   autocomplete="off" autocapitalize="off" value="${esc(STATE.filters.language)}" spellcheck="true">
            <input id="kd-filter-subject" placeholder="subject" inputmode="text" enterkeyhint="search"
                   autocomplete="off" autocapitalize="off" value="${esc(STATE.filters.subject)}" spellcheck="true">
            <input id="kd-filter-search" placeholder="search text" inputmode="search" enterkeyhint="search"
                   autocomplete="off" autocapitalize="off" value="${esc(STATE.filters.search)}" spellcheck="true">
            <button class="btn btn-sm btn-outline" type="button" onclick="distillation.applyFilters()">Filter</button>
          </div>
          <div class="bulk-row">
            <button class="btn btn-sm btn-primary" type="button" onclick="distillation.bulk('accept', this)">Accept selected</button>
            <button class="btn btn-sm btn-outline" type="button" onclick="distillation.bulk('reject', this)">Reject selected</button>
            <button class="btn btn-sm btn-outline" type="button" onclick="distillation.bulk('pending', this)">Mark pending</button>
            <button class="btn btn-sm btn-danger" type="button" onclick="distillation.bulk('delete', this)">Delete selected</button>
          </div>
          <div class="table-scroll">
          <table class="table records-table">
            <thead><tr><th></th><th>Instruction</th><th>Answer</th><th>Provenance</th><th>Score</th><th>Status</th><th></th></tr></thead>
            <tbody>${STATE.records.length ? STATE.records.map(recordRow).join('')
              : `<tr><td colspan="7" class="muted">No records match these filters.</td></tr>`}</tbody>
          </table>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Export & convert</h3></div>
        <div class="card-body form-grid">
          <label>Format
            <select id="kd-export-format">
              ${(STATE.options && STATE.options.output_formats || []).map((format) =>
                `<option value="${esc(format.key)}">${esc(format.label)}</option>`).join('')}
            </select>
          </label>
          <label>Split <select id="kd-export-split">
            <option value="all">all splits</option><option value="train">train</option>
            <option value="validation">validation</option><option value="test">test</option>
          </select></label>
          <button class="btn btn-outline" type="button" onclick="distillation.download(this)">
            <i class="fas fa-download"></i> Download JSONL
          </button>
          <button class="btn btn-primary" type="button" onclick="distillation.convert(this)">
            <i class="fas fa-database"></i> Convert to training datasets
          </button>
        </div>
        <div class="card-footer"><p class="field-help">
          Only accepted records are converted. Conversion uploads one dataset per split (train / validation / test)
          so the training engine can select them like any other dataset.
        </p></div>
      </div>`;
  }

  function selectJob(jobId) {
    STATE.job = { id: jobId };
    STATE.filters = { status: '', language: '', subject: '', task_type: '', search: '' };
    renderReview();
  }

  async function applyFilters() {
    STATE.filters = {
      status: ($('#kd-filter-status') || {}).value || '',
      language: ($('#kd-filter-language') || {}).value || '',
      subject: ($('#kd-filter-subject') || {}).value || '',
      task_type: STATE.filters.task_type || '',
      search: ($('#kd-filter-search') || {}).value || '',
    };
    if (!STATE.job) return;
    await loadRecords(STATE.job.id);
    await renderReview();
  }

  function toggleSelect(input) {
    if (input.checked) STATE.selected.add(input.value);
    else STATE.selected.delete(input.value);
  }

  function selectedIds() {
    // The rendered checkboxes and the in-memory set are kept in sync on every
    // render, so a selection survives a filter change or a refresh that drops
    // the rows from the DOM.
    const ids = new Set(STATE.selected);
    document.querySelectorAll('.kd-select').forEach((box) => {
      if (box.checked) ids.add(box.value);
      else ids.delete(box.value);
    });
    return Array.from(ids);
  }

  async function bulk(action, button) {
    const ids = selectedIds();
    if (!ids.length) { ui.toast('Select at least one record.', 'error'); return; }
    if (!STATE.job) return;
    ui.setButtonLoading(button, true, 'Applying…');
    try {
      const token = await state.getAccessToken();
      const result = await window.CORPUS_API.bulkReviewDistillationRecords(
        STATE.job.id, { record_ids: ids, action }, token);
      ui.toast(`${result.affected} record(s) ${action === 'accept' ? 'accepted' : action}.`, 'success');
      await loadJob(STATE.job.id);
      await loadRecords(STATE.job.id);
      await renderReview();
    } catch (err) {
      ui.toast((err && err.message) || 'Could not update the records.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function setStatus(recordId, status, button) {
    ui.setButtonLoading(button, true);
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.updateDistillationRecord(recordId, { status }, token);
      if (STATE.job) {
        await loadJob(STATE.job.id);
        await loadRecords(STATE.job.id);
        await renderReview();
      }
    } catch (err) {
      ui.toast((err && err.message) || 'Could not update the record.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function editRecord(recordId, button) {
    const record = STATE.records.find((item) => item.id === recordId);
    if (!record) return;
    const field = record.target ? 'target' : 'chosen';
    const next = window.prompt('Edit the answer that will be trained on:', record[field] || '');
    if (next == null) return;
    ui.setButtonLoading(button, true);
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.updateDistillationRecord(recordId, { [field]: next }, token);
      ui.toast('Record updated. Human edits are marked on the record.', 'success');
      await loadRecords(STATE.job.id);
      await renderReview();
    } catch (err) {
      ui.toast((err && err.message) || 'Could not save the edit.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function download(button) {
    if (!STATE.job) { ui.toast('Select a run first.', 'error'); return; }
    ui.setButtonLoading(button, true, 'Preparing…');
    try {
      const token = await state.getAccessToken();
      const format = ($('#kd-export-format') || {}).value || 'chat_jsonl';
      const split = ($('#kd-export-split') || {}).value || 'all';
      const result = await window.CORPUS_API.downloadDistillationExport(STATE.job.id, format, split, token);
      const blob = new Blob([result.text], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      ui.toast(`${result.recordCount} record(s) exported; ${result.skippedCount} skipped as unusable.`, 'success');
    } catch (err) {
      ui.toast((err && err.message) || 'Export failed.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function convert(button) {
    if (!STATE.job) { ui.toast('Select a run first.', 'error'); return; }
    ui.setButtonLoading(button, true, 'Converting…');
    try {
      const token = await state.getAccessToken();
      const format = ($('#kd-export-format') || {}).value || 'chat_jsonl';
      const result = await window.CORPUS_API.convertDistillationJob(STATE.job.id, {
        output_format: format, train: 0.8, validation: 0.1, test: 0.1,
      }, token);
      const created = (result && result.created) || [];
      ui.toast(`Created ${created.length} dataset(s) from approved records.`, 'success');
      STATE.datasets = null;
      await loadOverview();
      await renderReview();
    } catch (err) {
      ui.toast((err && err.message) || 'Conversion failed.', 'error');
    } finally {
      ui.setButtonLoading(button, false);
    }
  }

  async function render(routeHint) {
    const route = currentRoute(routeHint);
    if (route === 'dataset-review') return renderReview(route);
    return renderDistillation(route);
  }

  function dispose() { stopTimer(); }

  return {
    render,
    dispose,
    refresh,
    review,
    start,
    cancel,
    createJob,
    previewSource,
    prefillFromPlan,
    updateValidationUI,
    selectJob,
    applyFilters,
    toggleSelect,
    bulk,
    setStatus,
    editRecord,
    download,
    convert,
    // exposed for tests
    _state: () => ({ job: STATE.job, summary: STATE.summary, records: STATE.records,
                     jobs: STATE.jobs, filters: STATE.filters, selected: selectedIds(),
                     plan: STATE.plan, planWarnings: STATE.planWarnings,
                     providerOptions: STATE.providerOptions }),
    _summaryCards: summaryCards,
    _recordRow: recordRow,
    _statusBadge: statusBadge,
  };
})();
