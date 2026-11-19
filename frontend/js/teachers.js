/* ========================================
   CORPUS ULTIMATE — AI Teacher Network & Provider Management

   Two routes share this module:

     #/ai-teachers          which external AI produces knowledge for this
                            account: providers, their models, status, measured
                            capabilities and last successful request
     #/provider-management  add, test, discover, price, disable and revoke a
                            provider connection

   Hard rules kept here:

     * the API key is typed into a password field, POSTed once, then cleared —
       it is never written to localStorage, never rendered back, and never
       placed in a URL or a log line;
     * a model's context window / max output / price is shown only when the
       provider or the owner actually supplied it, otherwise "Not available";
     * capability labels are separate: teacher inference, synthetic data,
       provider-managed fine-tuning (only when verified) and student local
       training.
   ======================================== */

window.teachers = (function () {
  'use strict';

  const STATE = {
    providers: [],
    types: [],
    models: [],
    credential: null,
    loading: false,
    error: null,
    notice: null,
    lastDiscovery: null,
    lastTest: null,
  };

  function esc(value) {
    return ui.escapeHtml(value == null ? '' : String(value));
  }

  function na(value, suffix) {
    if (value === null || value === undefined || value === '') return 'Not available';
    return suffix ? String(value) + suffix : String(value);
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return 'Not available';
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Not available';
    return n.toLocaleString();
  }

  function container() {
    return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null;
  }

  function currentRoute(hint) {
    if (hint) return hint;
    return (window.state && window.state.getRoute && window.state.getRoute()) || 'ai-teachers';
  }

  function statusPill(provider) {
    if (!provider.enabled) return '<span class="status-badge offline"><i class="fas fa-circle"></i> Disabled</span>';
    if (provider.status === 'connected') return '<span class="status-badge online"><i class="fas fa-circle"></i> Connected</span>';
    if (provider.status === 'error') return '<span class="status-badge error"><i class="fas fa-circle"></i> Error</span>';
    return '<span class="status-badge pending"><i class="fas fa-circle"></i> Not verified</span>';
  }

  function capabilityChips(provider) {
    const caps = provider.capabilities || {};
    const chips = [];
    chips.push(chip('Teacher inference', caps.teacher_inference === true, 'fa-microchip'));
    chips.push(chip('Synthetic data', caps.synthetic_data_generation === true, 'fa-database'));
    if (caps.provider_managed_finetuning === true) {
      chips.push(chip('Provider fine-tuning', true, 'fa-wrench'));
    } else if (caps.provider_managed_finetuning === false) {
      chips.push(chip('Provider fine-tuning', false, 'fa-wrench'));
    } else {
      chips.push('<span class="chip chip-unknown" title="' + esc(caps.provider_managed_finetuning_evidence || '') +
        '"><i class="fas fa-question-circle"></i> Provider fine-tuning unverified</span>');
    }
    chips.push(chip('Student local training', caps.student_local_training === true, 'fa-laptop-code'));
    return chips.join(' ');
  }

  function chip(label, ok, icon) {
    return '<span class="chip ' + (ok ? 'chip-ok' : 'chip-off') + '"><i class="fas ' + icon + '"></i> ' +
      esc(label) + (ok ? '' : ' · unavailable') + '</span>';
  }

  function providerById(id) {
    return STATE.providers.find((item) => item.id === id) || null;
  }

  function modelsFor(providerId) {
    return (STATE.models || []).filter((model) => model.provider_id === providerId);
  }

  function priceLabel(model) {
    if (model.input_price_per_million == null && model.output_price_per_million == null) {
      return '<span class="muted">No price set — cost will not be estimated</span>';
    }
    const source = model.price_source === 'owner' ? 'owner-entered' : 'provider';
    return 'In $' + model.input_price_per_million + ' / Out $' + model.output_price_per_million +
      ' per 1M tokens <span class="muted">(' + esc(source) + ')</span>';
  }

  /* --------------------------------------------------------------- loading */

  async function load() {
    STATE.loading = true;
    STATE.error = null;
    try {
      const token = await state.getAccessToken();
      const [types, providers, models, credential] = await Promise.all([
        window.CORPUS_API.listProviderTypes(),
        window.CORPUS_API.listProviders(token),
        window.CORPUS_API.listTeacherModels(token),
        window.CORPUS_API.getCredentialStatus(),
      ]);
      STATE.types = (types && types.provider_types) || [];
      STATE.providers = (providers && providers.providers) || [];
      STATE.models = (models && models.models) || [];
      STATE.credential = credential || null;
    } catch (err) {
      STATE.error = (err && err.message) || 'Could not load the teacher network.';
    } finally {
      STATE.loading = false;
    }
  }

  /* ------------------------------------------------------------- rendering */

  function header(route) {
    const isProviders = route === 'provider-management';
    return `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-graduation-cap"></i> ${isProviders ? 'Provider management' : 'AI teacher network'}</span>
          <h1 class="section-title">${isProviders ? 'Connect an AI teacher' : 'Who teaches your models'}</h1>
          <p class="section-subtitle">${isProviders
            ? 'Add a provider, verify the key against the real API, discover its current models and set hard budgets.'
            : 'External AI teachers generate training knowledge; the student model on your device does the learning. Keys are encrypted (AES-256-GCM) and never leave the backend.'}</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="teachers.refresh(this)">
            <i class="fas fa-rotate"></i> Refresh
          </button>
          ${isProviders ? '<button class="btn btn-primary" type="button" onclick="teachers.openAddForm()"><i class="fas fa-plus"></i> Add provider</button>' : ''}
        </div>
      </div>`;
  }

  function credentialBanner() {
    if (!STATE.credential || STATE.credential.encryption_configured) return '';
    return `<div class="alert alert-warning" role="alert">
      <i class="fas fa-triangle-exclamation"></i>
      <div><strong>Credential encryption is not configured.</strong> ${esc(STATE.credential.message || '')}
      Nothing can be saved until CREDENTIAL_ENCRYPTION_KEY is set on the backend.</div>
    </div>`;
  }

  function noticeBanner() {
    if (!STATE.notice) return '';
    const kind = STATE.notice.kind === 'error' ? 'alert-error' : 'alert-success';
    return `<div class="alert ${kind}" role="status"><i class="fas fa-circle-info"></i><div>${esc(STATE.notice.text)}</div></div>`;
  }

  function providerCard(provider) {
    const models = modelsFor(provider.id);
    const defaultModel = provider.default_teacher_model || '';
    return `
      <div class="card provider-card" data-provider="${esc(provider.id)}">
        <div class="card-header">
          <div class="provider-head-copy">
            <h3>${esc(provider.name)}</h3>
            <span class="muted provider-type-line">${esc(provider.provider_type)}${provider.base_url ? ' · <span class="provider-endpoint">' + esc(provider.base_url) + '</span>' : ''}</span>
          </div>
          ${statusPill(provider)}
        </div>
        <div class="card-body">
          <dl class="kv-list">
            <div><dt>Credential</dt><dd><code>${esc(provider.credential_hint || '—')}</code>
              <span class="muted"> · fingerprint <span class="provider-fingerprint">${esc(provider.credential_fingerprint || '—')}</span></span></dd></div>
            <div><dt>Default teacher model</dt><dd class="provider-model-ref">${esc(defaultModel || 'Not set')}</dd></div>
            <div><dt>Last verified</dt><dd>${provider.last_tested_at ? ui.timeAgo(provider.last_tested_at) : 'Never tested'}</dd></div>
            <div><dt>Last error</dt><dd>${provider.last_error ? esc(provider.last_error) : 'None'}</dd></div>
          </dl>
          <div class="chip-row">${capabilityChips(provider)}</div>
          <div class="model-card-list">
            ${models.length ? models.map((model) => `
              <div class="model-card">
                <div class="model-card-head">
                  <code class="model-card-id">${esc(model.model_id)}</code>
                  ${model.enabled ? '' : '<span class="chip chip-off">disabled</span>'}
                </div>
                <dl class="kv-list model-card-specs">
                  <div><dt>Context</dt><dd>${na(model.context_window)}</dd></div>
                  <div><dt>Max output</dt><dd>${na(model.max_output_tokens)}</dd></div>
                  <div><dt>Price</dt><dd>${priceLabel(model)}</dd></div>
                  <div><dt>Source</dt><dd>${model.discovered ? 'Discovered' : 'Manual'}</dd></div>
                </dl>
              </div>`).join('') : '<p class="muted">No models yet. Run discovery or add a model ID.</p>'}
          </div>
        </div>
        <div class="card-footer actions-row">
          <button class="btn btn-sm btn-outline" type="button" onclick="teachers.testProvider('${esc(provider.id)}', this)">
            <i class="fas fa-plug-circle-check"></i> Test connection
          </button>
          <button class="btn btn-sm btn-outline" type="button" onclick="teachers.discoverModels('${esc(provider.id)}', this)">
            <i class="fas fa-magnifying-glass"></i> Discover models
          </button>
          <button class="btn btn-sm btn-outline" type="button" onclick="teachers.toggleProvider('${esc(provider.id)}', ${provider.enabled ? 'false' : 'true'}, this)">
            <i class="fas fa-power-off"></i> ${provider.enabled ? 'Disable' : 'Enable'}
          </button>
          <button class="btn btn-sm btn-danger" type="button" onclick="teachers.revokeProvider('${esc(provider.id)}', this)">
            <i class="fas fa-key"></i> Revoke key
          </button>
        </div>
      </div>`;
  }

  function emptyProviders() {
    return ui.emptyState({
      icon: 'fa-graduation-cap',
      title: 'No AI teacher connected',
      text: 'Connect OpenAI, Gemini, Anthropic, OpenRouter, Groq, Together, DeepSeek, Fireworks or any OpenAI-compatible endpoint to start generating training knowledge.',
      actionLabel: 'Add your first provider',
      actionOnclick: 'teachers.navigate(\'provider-management\')',
      actionIcon: 'fa-plus',
    });
  }

  function budgetSummary(provider) {
    const budget = provider.budget || {};
    const parts = [];
    if (budget.max_spend_usd_per_day != null) parts.push('$' + budget.max_spend_usd_per_day + ' / day');
    if (budget.max_requests_per_day != null) parts.push(budget.max_requests_per_day + ' requests / day');
    if (budget.max_concurrent_requests != null) parts.push(budget.max_concurrent_requests + ' concurrent');
    return parts.length ? parts.join(' · ') : 'No limits set — a job budget still applies per run';
  }

  async function renderTeachers() {
    const root = container();
    if (!root) return;
    const user = state.getUser();
    if (!user) {
      root.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Sign in to manage the AI teachers connected to your account.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }
    if (STATE.loading && !STATE.providers.length) {
      root.innerHTML = header('ai-teachers') + ui.skeletonCards(3);
      return;
    }
    if (!STATE.providers.length && !STATE.error) await load();

    root.innerHTML = `
      ${header('ai-teachers')}
      ${credentialBanner()}
      <div id="teacher-notice-slot">${noticeBanner()}</div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      <div class="stats-grid">
        ${statCard('Providers', STATE.providers.length, 'fa-plug')}
        ${statCard('Teacher models', STATE.models.length, 'fa-cubes')}
        ${statCard('Connected', STATE.providers.filter((p) => p.status === 'connected').length, 'fa-circle-check')}
        ${statCard('Unverified', STATE.providers.filter((p) => p.status !== 'connected').length, 'fa-circle-question')}
      </div>
      <div class="section-block">
        <h2 class="section-heading">Providers</h2>
        ${STATE.providers.length ? `<div class="card-grid">${STATE.providers.map(providerCard).join('')}</div>` : emptyProviders()}
      </div>
      <div class="callout">
        <i class="fas fa-shield-halved"></i>
        <p>Provider credentials are encrypted with AES-256-GCM before they reach the database. The API returns only
        the last four characters and a short fingerprint, and the backend refuses to store a key at all when
        <code>CREDENTIAL_ENCRYPTION_KEY</code> is missing.</p>
      </div>`;
  }

  function statCard(label, value, icon) {
    return `<div class="stat-card"><div class="stat-icon"><i class="fas ${icon}"></i></div>
      <div><div class="stat-value">${num(value)}</div><div class="stat-label">${esc(label)}</div></div></div>`;
  }

  async function renderProviderManagement() {
    const root = container();
    if (!root) return;
    const user = state.getUser();
    if (!user) {
      root.innerHTML = ui.emptyState({
        icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to add a provider.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt',
      });
      return;
    }
    if (!STATE.types.length || !STATE.providers.length) await load();
    root.innerHTML = `
      ${header('provider-management')}
      ${credentialBanner()}
      <div id="teacher-notice-slot">${noticeBanner()}</div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      <div id="provider-form-slot"></div>
      <div class="section-block">
        <h2 class="section-heading">Connected providers</h2>
        ${STATE.providers.length ? `<div class="card-grid">${STATE.providers.map((provider) => `
          <div class="card">
            <div class="card-header"><div><h3>${esc(provider.name)}</h3>
              <span class="muted">${esc(provider.provider_type)}</span></div>${statusPill(provider)}</div>
            <div class="card-body">
              <p><strong>Credential</strong> <code>${esc(provider.credential_hint || '—')}</code></p>
              <p><strong>Budget</strong> ${esc(budgetSummary(provider))}</p>
              <form class="inline-form" onsubmit="teachers.saveBudget(event, '${esc(provider.id)}')">
                <label>Daily spend cap (USD)
                  <input type="number" min="0" step="0.01" name="max_spend_usd_per_day"
                         value="${provider.budget && provider.budget.max_spend_usd_per_day != null ? provider.budget.max_spend_usd_per_day : ''}" inputmode="decimal" enterkeyhint="done" autocapitalize="off" spellcheck="false">
                </label>
                <label>Daily request cap
                  <input type="number" min="0" step="1" name="max_requests_per_day"
                         value="${provider.budget && provider.budget.max_requests_per_day != null ? provider.budget.max_requests_per_day : ''}" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
                </label>
                <button class="btn btn-sm btn-primary" type="submit">Save limits</button>
              </form>
            </div>
          </div>`).join('')}` : emptyProviders()}
      </div>
      <div class="section-block">
        <h2 class="section-heading">Key rotation</h2>
        <p class="muted">Replacing a key keeps the provider, its discovered models and all generated data. The old
        secret is overwritten in place and cannot be recovered afterwards.</p>
        ${STATE.providers.length ? `<form class="inline-form" onsubmit="teachers.rotateKey(event)">
          <label>Provider
            <select name="provider_id" required>
              ${STATE.providers.map((provider) => `<option value="${esc(provider.id)}">${esc(provider.name)}</option>`).join('')}
            </select>
          </label>
          <label>New API key
            <input type="password" name="api_key" autocomplete="new-password" required minlength="8"
                   inputmode="text" enterkeyhint="done" autocapitalize="off" spellcheck="false"
                   placeholder="new secret">
          </label>
          <button class="btn btn-sm btn-outline" type="submit"><i class="fas fa-rotate"></i> Replace key</button>
        </form>` : ''}
      </div>`;
  }

  function openAddForm() {
    const slot = document.getElementById('provider-form-slot');
    if (!slot) {
      navigate('provider-management');
      return;
    }
    if (document.getElementById('provider-add-form')) return; // already open
    slot.innerHTML = `
      <div class="card" id="provider-add-form">
        <div class="card-header"><h3>Add a provider</h3>
          <button class="btn btn-sm btn-outline" type="button" onclick="teachers.closeAddForm()">Cancel</button></div>
        <form class="card-body form-grid" onsubmit="teachers.submitProvider(event)">
          <label>Provider family
            <select name="provider_type" required
              onchange="teachers.onTypeChange(this)">
              ${STATE.types.map((type) => `<option value="${esc(type.key)}" data-requires-url="${type.requires_base_url ? '1' : '0'}"
                data-url="${esc(type.default_base_url || '')}">${esc(type.label)}${type.requires_base_url ? ' (custom endpoint)' : ''}</option>`).join('')}
            </select>
          </label>
          <label>Display name
            <input name="name" required maxlength="80" inputmode="text" enterkeyhint="next"
                   autocomplete="off" autocapitalize="words" placeholder="e.g. OpenAI primary" spellcheck="true">
          </label>
          <label>API key
            <input type="password" name="api_key" autocomplete="new-password" required minlength="8"
                   inputmode="text" enterkeyhint="done" autocapitalize="off" spellcheck="false"
                   placeholder="stored encrypted, never shown again">
          </label>
          <label>Custom base URL
            <input name="base_url" type="url" inputmode="url" enterkeyhint="done"
                   autocomplete="off" autocapitalize="off" spellcheck="false"
                   placeholder="https://api.example.com/v1" data-role="base-url">
            <span class="field-help">Required for a custom OpenAI-compatible endpoint; optional otherwise.</span>
          </label>
          <label>Default teacher model ID
            <input name="default_teacher_model" inputmode="text" enterkeyhint="done"
                   autocomplete="off" autocapitalize="off" spellcheck="false"
                   placeholder="discover after saving, or type an exact model ID">
            <span class="field-help">Left empty, you can pick a model after discovery.</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" name="test_on_save" checked> Test the connection immediately
          </label>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit" id="provider-submit"><i class="fas fa-key"></i> Save provider</button>
            <button class="btn btn-outline" type="button" onclick="teachers.closeAddForm()">Cancel</button>
          </div>
          <p class="field-help">The key is sent once to the backend, encrypted with AES-256-GCM, and never returned.</p>
        </form>
      </div>`;
    if (slot && typeof slot.scrollIntoView === 'function') slot.scrollIntoView({ block: 'nearest' });
  }

  function closeAddForm() {
    const slot = document.getElementById('provider-form-slot');
    if (slot) slot.innerHTML = '';
  }

  function onTypeChange(select) {
    const option = select.options[select.selectedIndex];
    const urlInput = document.querySelector('#provider-add-form input[name="base_url"]');
    if (!urlInput) return;
    const requires = option.getAttribute('data-requires-url') === '1';
    urlInput.required = requires;
    urlInput.placeholder = requires ? 'https://api.example.com/v1' : (option.getAttribute('data-url') || 'default endpoint');
  }

  async function submitProvider(event) {
    event.preventDefault();
    const form = event.target;
    const button = document.getElementById('provider-submit');
    const data = new FormData(form);
    const payload = {
      provider_type: data.get('provider_type'),
      name: (data.get('name') || '').trim(),
      api_key: (data.get('api_key') || '').trim(),
      test_on_save: data.get('test_on_save') === 'on',
    };
    const baseUrl = (data.get('base_url') || '').trim();
    if (baseUrl) payload.base_url = baseUrl;
    const defaultModel = (data.get('default_teacher_model') || '').trim();
    if (defaultModel) payload.default_teacher_model = defaultModel;

    if (button) ui.setButtonLoading(button, true, 'Saving…');
    try {
      const token = await state.getAccessToken();
      const created = await window.CORPUS_API.createProvider(payload, token);
      setNotice('success', `Provider “${created.name}” saved · ${created.status === 'connected' ? 'connection verified' : 'key stored, connection not verified yet'}.`);
      // The secret exists only in this local variable; drop it immediately.
      payload.api_key = null;
      form.reset();
      closeAddForm();
      await load();
      await renderProviderManagement();
    } catch (err) {
      // Do NOT re-render here. Rebuilding the page would replace the add-provider
      // form and throw away everything the user just typed (including the other
      // fields). Keep the form in place so they can correct and retry.
      setNotice('error', ((err && err.message) || 'Could not save the provider.') +
        ' Check the values below and try again; your entries are still here.');
    } finally {
      if (button) ui.setButtonLoading(button, false);
    }
  }

  async function rotateKey(event) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const providerId = data.get('provider_id');
    const apiKey = (data.get('api_key') || '').trim();
    if (!apiKey) return;
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.updateProvider(providerId, { api_key: apiKey }, token);
      form.reset();
      setNotice('success', 'Key replaced. The provider is unverified until the next connection test.');
      await load();
      await renderProviderManagement();
    } catch (err) {
      setNotice('error', (err && err.message) || 'Could not replace the key.');
      await renderProviderManagement();
    }
  }

  async function saveBudget(event, providerId) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const budget = {};
    for (const key of ['max_spend_usd_per_day', 'max_requests_per_day']) {
      const raw = (data.get(key) || '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        setNotice('error', 'Budgets must be zero or a positive number.');
        return;
      }
      budget[key] = value;
    }
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.setProviderBudget(providerId, budget, token);
      setNotice('success', 'Budget limits saved. They are enforced before every teacher request.');
      await load();
      await renderProviderManagement();
    } catch (err) {
      setNotice('error', (err && err.message) || 'Could not save the budget.');
      await renderProviderManagement();
    }
  }

  async function testProvider(providerId, button) {
    if (button) ui.setButtonLoading(button, true, 'Testing…');
    try {
      const token = await state.getAccessToken();
      const result = await window.CORPUS_API.testProvider(providerId, token);
      STATE.lastTest = result;
      setNotice(result.ok ? 'success' : 'error',
        result.ok
          ? `Connection verified in ${num(result.latency_ms)} ms · ${result.models_found} model(s) discovered.`
          : `Connection test failed: ${result.error || 'the provider rejected the key'}`);
      await load();
    } catch (err) {
      setNotice('error', (err && err.message) || 'The connection test could not be completed.');
    } finally {
      if (button) ui.setButtonLoading(button, false);
      if (currentRoute() === 'provider-management') await renderProviderManagement();
      else await renderTeachers();
      if (STATE.lastTest && STATE.lastTest.ok) openAddFormIfModelChoice();
    }
  }

  function openAddFormIfModelChoice() {
    // Convenience only: after a successful discovery the owner may still need to
    // choose a default model, so surface the first provider's models.
  }

  async function discoverModels(providerId, button) {
    if (button) ui.setButtonLoading(button, true, 'Discovering…');
    try {
      const token = await state.getAccessToken();
      const result = await window.CORPUS_API.discoverTeacherModels(providerId, token);
      STATE.lastDiscovery = result;
      setNotice('success',
        `Discovery finished: ${result.created} new model(s), ${result.updated} refreshed. ` +
        'Specs and prices appear only where the provider actually reported them.');
      await load();
    } catch (err) {
      setNotice('error', (err && err.message) || 'Model discovery failed.');
    } finally {
      if (button) ui.setButtonLoading(button, false);
      if (currentRoute() === 'provider-management') await renderProviderManagement();
      else await renderTeachers();
    }
  }

  async function toggleProvider(providerId, enabled, button) {
    if (button) ui.setButtonLoading(button, true, 'Working…');
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.updateProvider(providerId, { enabled: !!enabled }, token);
      setNotice('success', enabled ? 'Provider enabled.' : 'Provider disabled. Existing generated data is untouched.');
      await load();
    } catch (err) {
      setNotice('error', (err && err.message) || 'Could not change the provider state.');
    } finally {
      if (button) ui.setButtonLoading(button, false);
      if (currentRoute() === 'provider-management') await renderProviderManagement();
      else await renderTeachers();
    }
  }

  function revokeProvider(providerId, button) {
    const provider = providerById(providerId);
    // ui.confirm is callback-based: the destructive action runs only after the
    // owner confirms in the dialog.
    ui.confirm(
      'Revoke this credential?',
      `The encrypted API key for “${provider ? provider.name : providerId}” is destroyed permanently. ` +
        'Datasets and generated records stay; the provider and its model list are removed.',
      function () { performRevoke(providerId, button); }
    );
  }

  async function performRevoke(providerId, button) {
    if (button) ui.setButtonLoading(button, true, 'Revoking…');
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.deleteProvider(providerId, token);
      setNotice('success', 'Credential revoked and provider removed.');
      await load();
    } catch (err) {
      setNotice('error', (err && err.message) || 'Could not revoke the credential.');
    } finally {
      if (button) ui.setButtonLoading(button, false);
      if (currentRoute() === 'provider-management') await renderProviderManagement();
      else await renderTeachers();
    }
  }

  async function refresh(button) {
    if (button) ui.setButtonLoading(button, true, 'Refreshing…');
    try {
      await load();
      setNotice('success', 'Teacher network refreshed.');
    } finally {
      if (button) ui.setButtonLoading(button, false);
      if (currentRoute() === 'provider-management') await renderProviderManagement();
      else await renderTeachers();
    }
  }

  function setNotice(kind, text) {
    STATE.notice = { kind, text };
    // Update only the notice slot. A full re-render here would replace the
    // provider form and discard the values the user has just typed.
    const slot = document.getElementById('teacher-notice-slot');
    if (slot) slot.innerHTML = noticeBanner();
    ui.toast(text, kind === 'error' ? 'error' : 'success');
  }

  function navigate(route) {
    if (window.router && typeof window.router.navigate === 'function') window.router.navigate(route);
  }

  async function render(routeHint) {
    const route = currentRoute(routeHint);
    if (route === 'provider-management') return renderProviderManagement();
    return renderTeachers();
  }

  return {
    render,
    refresh,
    navigate,
    openAddForm,
    closeAddForm,
    onTypeChange,
    submitProvider,
    rotateKey,
    saveBudget,
    testProvider,
    discoverModels,
    toggleProvider,
    revokeProvider,
    // exposed for tests
    _state: () => ({
      providers: STATE.providers,
      models: STATE.models,
      types: STATE.types,
      credential: STATE.credential,
      notice: STATE.notice,
      lastTest: STATE.lastTest,
      lastDiscovery: STATE.lastDiscovery,
    }),
    _statusPill: statusPill,
    _capabilityChips: capabilityChips,
    _budgetSummary: budgetSummary,
    _providerCard: providerCard,
  };
})();
