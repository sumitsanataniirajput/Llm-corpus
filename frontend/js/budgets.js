/* ========================================
   CORPUS ULTIMATE — API Usage & Budgets

   Route: #/api-usage

   Per-provider requests, successes, failures, rate-limit errors, input/output
   tokens, estimated spend, average latency and the last request. Spend is only
   ever computed from prices the owner (or the provider) supplied — requests
   without a price are counted as "unpriced" instead of being estimated.
   ======================================== */

window.budgets = (function () {
  'use strict';

  const STATE = { usage: null, providers: [], error: null, loading: false };

  function esc(value) { return ui.escapeHtml(value == null ? '' : String(value)); }
  function num(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : '—';
  }
  function money(value) {
    if (value === null || value === undefined) return '—';
    const n = Number(value);
    return Number.isFinite(n) ? '$' + n.toFixed(4) : '—';
  }
  function container() { return window.CORPUS_APP ? window.CORPUS_APP.getPageContainer() : null; }

  async function load() {
    STATE.loading = true;
    try {
      const token = await state.getAccessToken();
      const [usage, providers] = await Promise.all([
        window.CORPUS_API.getTeacherUsage(token),
        window.CORPUS_API.listProviders(token),
      ]);
      STATE.usage = usage || null;
      STATE.providers = (providers && providers.providers) || [];
      STATE.error = null;
    } catch (err) {
      STATE.error = (err && err.message) || 'Could not load usage.';
    } finally {
      STATE.loading = false;
    }
  }

  function totals() {
    const t = (STATE.usage && STATE.usage.totals) || {};
    return `<div class="stats-grid">
      ${stat('Requests', num(t.requests))}
      ${stat('Input tokens', num(t.input_tokens))}
      ${stat('Output tokens', num(t.output_tokens))}
      ${stat('Total tokens', num(t.total_tokens))}
      ${stat('Estimated spend', money(t.estimated_cost))}
    </div>`;
  }

  function stat(label, value) {
    return `<div class="stat-card"><div><div class="stat-value">${value}</div>
      <div class="stat-label">${esc(label)}</div></div></div>`;
  }

  function providerRow(row) {
    const budget = row.budget || {};
    const limits = [];
    if (budget.max_spend_usd_per_day != null) limits.push('$' + budget.max_spend_usd_per_day + '/day');
    if (budget.max_requests_per_day != null) limits.push(budget.max_requests_per_day + ' req/day');
    if (budget.max_concurrent_requests != null) limits.push(budget.max_concurrent_requests + ' concurrent');
    return `<tr>
      <td><strong>${esc(row.name)}</strong><div class="muted">${esc(row.provider_type)}</div></td>
      <td>${num(row.requests)}</td>
      <td>${num(row.successes)}</td>
      <td>${num(row.failures)}</td>
      <td>${num(row.rate_limit_errors)}</td>
      <td>${num(row.input_tokens)}</td>
      <td>${num(row.output_tokens)}</td>
      <td>${num(row.cached_tokens)}</td>
      <td>${money(row.estimated_cost)}${row.unpriced_requests ? `<div class="muted">${row.unpriced_requests} unpriced</div>` : ''}</td>
      <td>${row.avg_latency_ms == null ? '—' : Math.round(row.avg_latency_ms) + ' ms'}</td>
      <td>${row.last_request_at ? ui.timeAgo(row.last_request_at) : 'Never'}</td>
      <td>${limits.length ? esc(limits.join(' · ')) : '<span class="muted">none</span>'}</td>
    </tr>`;
  }

  async function render() {
    const root = container();
    if (!root) return;
    if (!state.getUser()) {
      root.innerHTML = ui.emptyState({ icon: 'fa-user-circle', title: 'Sign in required',
        text: 'Sign in to see provider usage and budgets.', actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')", actionIcon: 'fa-sign-in-alt' });
      return;
    }
    if (!STATE.usage) {
      root.innerHTML = '<div class="page-header"><div class="page-header-copy"><h1 class="section-title">Usage and budgets</h1></div></div>' + ui.skeletonCards(2);
      await load();
    }
    const providers = (STATE.usage && STATE.usage.providers) || [];
    root.innerHTML = `
      <div class="page-header">
        <div class="page-header-copy">
          <span class="eyebrow"><i class="fas fa-wallet"></i> API usage &amp; budgets</span>
          <h1 class="section-title">What the teachers cost</h1>
          <p class="section-subtitle">Every outbound teacher request is logged with its tokens, latency and outcome.</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-outline" type="button" onclick="budgets.refresh(this)"><i class="fas fa-rotate"></i> Refresh</button>
        </div>
      </div>
      ${STATE.error ? `<div class="alert alert-error"><i class="fas fa-circle-exclamation"></i><div>${esc(STATE.error)}</div></div>` : ''}
      ${totals()}
      <div class="card">
        <div class="card-header"><h3>Per provider</h3></div>
        <div class="card-body">
          ${providers.length ? `<div class="table-scroll"><table class="table compact">
            <thead><tr><th>Provider</th><th>Requests</th><th>OK</th><th>Failed</th><th>429</th>
              <th>In</th><th>Out</th><th>Cached</th><th>Spend</th><th>Avg latency</th><th>Last request</th><th>Limits</th></tr></thead>
            <tbody>${providers.map(providerRow).join('')}</tbody></table></div>`
            : ui.emptyState({ icon: 'fa-plug', title: 'No provider connected',
                text: 'Connect a provider to start generating and metering usage.' })}
        </div>
        <div class="card-footer"><p class="field-help">${esc((STATE.usage && STATE.usage.pricing_note) || '')}</p></div>
      </div>
      <div class="section-block">
        <h2 class="section-heading">Set hard limits</h2>
        ${STATE.providers.length ? `<div class="card-grid two">${STATE.providers.map((provider) => `
          <div class="card"><div class="card-header"><h3>${esc(provider.name)}</h3></div>
            <form class="card-body form-grid" onsubmit="budgets.save(event, '${esc(provider.id)}')">
              <label>Daily spend cap (USD)
                <input name="max_spend_usd_per_day" type="number" min="0" step="0.01"
                  value="${provider.budget && provider.budget.max_spend_usd_per_day != null ? provider.budget.max_spend_usd_per_day : ''}" inputmode="decimal" enterkeyhint="done" autocapitalize="off" spellcheck="false">
              </label>
              <label>Daily request cap
                <input name="max_requests_per_day" type="number" min="0" step="1"
                  value="${provider.budget && provider.budget.max_requests_per_day != null ? provider.budget.max_requests_per_day : ''}" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
              </label>
              <label>Max concurrent requests
                <input name="max_concurrent_requests" type="number" min="1" max="8"
                  value="${provider.budget && provider.budget.max_concurrent_requests != null ? provider.budget.max_concurrent_requests : ''}" inputmode="numeric" enterkeyhint="done" autocapitalize="off" spellcheck="false">
              </label>
              <button class="btn btn-sm btn-primary" type="submit"><i class="fas fa-shield-halved"></i> Save limits</button>
            </form></div>`).join('')}</div>` : '<p class="muted">Connect a provider first.</p>'}
      </div>`;
  }

  async function save(event, providerId) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const budget = {};
    for (const key of ['max_spend_usd_per_day', 'max_requests_per_day', 'max_concurrent_requests']) {
      const raw = (data.get(key) || '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        ui.toast('Limits must be zero or a positive number.', 'error');
        return;
      }
      budget[key] = value;
    }
    try {
      const token = await state.getAccessToken();
      await window.CORPUS_API.setProviderBudget(providerId, budget, token);
      ui.toast('Limits saved. Requests are blocked before they exceed them.', 'success');
      await load();
      await render();
    } catch (err) {
      ui.toast((err && err.message) || 'Could not save the limits.', 'error');
    }
  }

  async function refresh(button) {
    if (button) ui.setButtonLoading(button, true, 'Refreshing…');
    try {
      await load();
      await render();
    } finally {
      if (button) ui.setButtonLoading(button, false);
    }
  }

  return {
    render,
    refresh,
    save,
    // exposed for tests
    _state: () => ({ usage: STATE.usage, providers: STATE.providers, error: STATE.error }),
    _providerRow: providerRow,
  };
})();
