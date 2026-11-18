/* ========================================
   CORPUS ULTIMATE — UI components & helpers
   ======================================== */

window.ui = (function () {
  // Toast
  // A request cancelled because the user navigated away is not a failure and
  // must never surface as an error toast.
  function isAborted(err) {
    if (!err) return false;
    if (err.aborted || err.code === 'ABORTED') return true;
    const name = err.name || '';
    return name === 'AbortError';
  }

  function toast(message, type = 'info', duration = 4000) {
    if (isAborted(message)) return;
    if (message && message.aborted) return;
    CORPUS_UTILS.toast(message, type, duration);
  }

  // Confirm dialog
  function confirm(title, message, onConfirm) {
    const dialog = document.getElementById('confirm-dialog');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    dialog.classList.remove('hidden');
    const okBtn = document.getElementById('confirm-ok');
    const backdrop = dialog.querySelector('.modal-backdrop');
    const closeBtn = dialog.querySelector('.modal-close');
    let handled = false;

    function cleanup() {
      dialog.classList.add('hidden');
      okBtn.onclick = null;
      backdrop.onclick = null;
      closeBtn.onclick = null;
    }

    okBtn.onclick = () => {
      if (handled) return;
      handled = true;
      cleanup();
      if (onConfirm) onConfirm();
    };
    backdrop.onclick = cleanup;
    closeBtn.onclick = cleanup;
  }

  function closeConfirm() {
    document.getElementById('confirm-dialog').classList.add('hidden');
  }

  // Loading state on button
  function setButtonLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Working...';
    } else {
      btn.disabled = false;
      if (btn.dataset.originalText) btn.innerHTML = btn.dataset.originalText;
    }
  }

  // Format helpers (expose utils)
  const formatBytes = CORPUS_UTILS.formatBytes;
  const formatNumber = CORPUS_UTILS.formatNumber;
  const formatDuration = CORPUS_UTILS.formatDuration;
  const formatDate = CORPUS_UTILS.formatDate;

  // Connection indicator
  function setConnection(status) {
    const indicator = document.getElementById('connection-indicator');
    const text = document.getElementById('connection-text');
    if (!indicator || !text) return;
    const dot = indicator.querySelector('i');
    indicator.classList.remove('hidden');
    if (status === 'connected') {
      if (dot) dot.className = 'fas fa-circle text-success';
      text.textContent = 'Connected';
    } else if (status === 'disconnected') {
      if (dot) dot.className = 'fas fa-circle text-error';
      text.textContent = 'Disconnected';
    } else {
      if (dot) dot.className = 'fas fa-circle text-warning';
      text.textContent = 'Connecting…';
    }
    state.setConnection(status);
  }

  // Offline banner
  function showOffline() {
    const b = document.getElementById('offline-banner');
    if (b) b.classList.remove('hidden');
  }
  function hideOffline() {
    const b = document.getElementById('offline-banner');
    if (b) b.classList.add('hidden');
  }


  /* ------------------------------------------------------------------------
     Responsiveness helpers

     A page with 300 models used to build one giant innerHTML string: the click
     that opened the page blocked the main thread for the whole parse, and every
     card carried data-aos, so AOS then observed hundreds of elements and did
     scroll work on each frame. These helpers keep the same markup and the same
     look while rendering in bounded chunks, delegating events from one listener
     and giving the user instant feedback on press.
     ------------------------------------------------------------------------ */

  // Paged list rendering: only `initial` rows hit the DOM at once, the rest are
  // one click away. Search/refresh always operate on the full data set.
  function renderPagedList(target, items, rowHtml, options = {}) {
    if (!target) return null;
    const initial = options.initial || 40;
    const step = options.step || 40;
    const state = { shown: initial };

    function paint() {
      const visible = items.slice(0, state.shown);
      const remaining = items.length - visible.length;
      let html = visible.map(rowHtml).join('');
      if (remaining > 0) {
        html += '<div class="list-more"><button class="btn btn-outline" type="button" data-show-more="' +
          Math.min(step, remaining) + '"><i class="fas fa-chevron-down"></i> Show ' +
          Math.min(step, remaining) + ' more<span class="list-more-count"> (' + remaining + ' hidden)</span></button></div>';
      }
      target.innerHTML = html;
    }

    function showMore(count) {
      state.shown = Math.min(items.length, state.shown + (count || step));
      paint();
      return state.shown;
    }

    delegate(target, '[data-show-more]', 'click', (event, btn) => {
      event.preventDefault();
      showMore(Number(btn.getAttribute('data-show-more')) || step);
    });

    paint();
    return { paint, showMore, get shown() { return state.shown; } };
  }

  // One listener per container instead of one per row. Re-delegating the same
  // selector/type replaces the previous handler, so repeated renders cannot
  // stack listeners (the old code added a listener to every row on every render).
  function delegate(root, selector, type, handler) {
    if (!root) return null;
    root.__corpusDelegates = root.__corpusDelegates || {};
    const key = type + '::' + selector;
    if (root.__corpusDelegates[key]) {
      root.removeEventListener(type, root.__corpusDelegates[key]);
    }
    const listener = (event) => {
      const match = event.target && event.target.closest ? event.target.closest(selector) : null;
      if (match && root.contains(match)) handler(event, match);
    };
    root.__corpusDelegates[key] = listener;
    root.addEventListener(type, listener);
    return listener;
  }

  // Visual feedback on press, before any handler code runs. Pure CSS transform,
  // so it costs nothing on the main thread.
  function installPressFeedback() {
    if (window.__corpusPressFeedback) return;
    window.__corpusPressFeedback = true;
    const TARGETS = '.btn, button, .nav-link, .sidebar-link, [role="button"], .tab, .chip';
    const clear = (el) => { if (el && el.classList) el.classList.remove('is-pressed'); };
    document.addEventListener('pointerdown', (event) => {
      const el = event.target && event.target.closest ? event.target.closest(TARGETS) : null;
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      el.classList.add('is-pressed');
    }, { passive: true });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => {
      document.addEventListener(name, (event) => {
        const el = event.target && event.target.closest ? event.target.closest(TARGETS) : null;
        clear(el);
      }, { passive: true });
    });
    // A press that starts on one button and ends elsewhere must not stay stuck.
    document.addEventListener('pointerup', () => {
      document.querySelectorAll('.is-pressed').forEach(clear);
    }, { passive: true });
  }

  // Run `fn` at most once per element while it is in flight, and reflect the
  // state on the element so a double tap cannot fire two requests.
  const inFlight = new WeakMap();
  function guard(element, fn) {
    if (!element) return Promise.resolve().then(fn);
    // Re-entry returns the same promise, so the action itself never runs twice.
    if (inFlight.has(element)) return inFlight.get(element);
    let promise;
    try {
      promise = Promise.resolve(fn());
    } catch (err) {
      promise = Promise.reject(err);
    }
    // Deliberately does not touch `disabled`: page code owns button state
    // (updateControls, setButtonLoading) and restoring a stale value here would
    // re-enable a button the page had just correctly disabled.
    element.setAttribute('aria-busy', 'true');
    promise = promise.finally(() => {
      inFlight.delete(element);
      element.removeAttribute('aria-busy');
    });
    inFlight.set(element, promise);
    return promise;
  }

  function isBusy(element) {
    return !!(element && inFlight.has(element));
  }

  // Set loading overlay
  function setLoading(loading) {
    document.body.classList.toggle('loading', loading);
  }

  // Notification badge
  function updateNotificationBadge() {
    const badge = document.getElementById('notification-badge');
    const count = state.unreadCount();
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
  }

  // Render a status badge
  function statusBadge(status) {
    const map = {
      queued: 'queued',
      preparing: 'preparing',
      running: 'running',
      pausing: 'paused',
      paused: 'paused',
      stopping: 'paused',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
    };
    const cls = map[status] || 'cancelled';
    const labels = {
      queued: 'Queued',
      preparing: 'Preparing',
      running: 'Running',
      pausing: 'Pausing',
      paused: 'Paused',
      stopping: 'Stopping',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    };
    return '<span class="status-badge ' + cls + '"><i class="fas fa-circle"></i> ' + (labels[status] || status) + '</span>';
  }

  // Render model config summary
  function modelConfigSummary(config) {
    if (!config) return '<span class="text-warning">No configuration</span>';
    const params = CORPUS_UTILS.calculateParameters(config);
    return `
      <div class="config-grid">
        <div class="config-item"><div class="config-label">Layers</div><div class="config-value">${config.n_layers || '—'}</div></div>
        <div class="config-item"><div class="config-label">Heads</div><div class="config-value">${config.n_heads || '—'}</div></div>
        <div class="config-item"><div class="config-label">Dim</div><div class="config-value">${config.d_model || '—'}</div></div>
        <div class="config-item"><div class="config-label">FFN</div><div class="config-value">${config.d_ff || '—'}</div></div>
        <div class="config-item"><div class="config-label">Vocab</div><div class="config-value">${config.vocab_size || '—'}</div></div>
        <div class="config-item"><div class="config-label">Context</div><div class="config-value">${config.context_length || '—'}</div></div>
        <div class="config-item"><div class="config-label">Parameters</div><div class="config-value">${formatNumber(params)}</div></div>
      </div>
    `;
  }

  // Create a chart container element
  function createChartContainer(id, title) {
    return `
      <div class="chart-container" data-aos="fade-up">
        <h4 style="margin-bottom:var(--space-3); font-size:var(--text-title-medium); color:var(--color-text);">${title}</h4>
        <canvas id="${id}"></canvas>
      </div>
    `;
  }

  // Escape untrusted text for safe HTML interpolation
  function escapeHtml(value) {
    return CORPUS_UTILS.escapeHtml(value == null ? '' : String(value));
  }

  // Copy text to the clipboard with a safe fallback; updates the button label.
  async function copyText(text, btn) {
    const value = String(text == null ? '' : text);
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand ? document.execCommand('copy') : false;
        document.body.removeChild(area);
      } catch (e) {
        ok = false;
      }
    }
    if (btn) {
      const previous = btn.innerHTML;
      btn.classList.toggle('copied', ok);
      btn.innerHTML = ok ? '<i class="fas fa-check"></i> Copied' : '<i class="fas fa-times"></i> Copy failed';
      setTimeout(function () {
        btn.innerHTML = previous;
        btn.classList.remove('copied');
      }, 1600);
    }
    toast(ok ? 'Copied to clipboard' : 'Copy failed — select the text manually', ok ? 'success' : 'error', 1800);
    return ok;
  }

  // Copy-to-clipboard button markup. `label` may be empty for an icon-only button.
  function copyButton(text, label) {
    const encoded = encodeURIComponent(String(text == null ? '' : text));
    const caption = label ? ' ' + escapeHtml(label) : '';
    return '<button type="button" class="copy-btn" data-copy="' + encoded + '" ' +
      'onclick="ui.handleCopy(event, this)" title="Copy to clipboard">' +
      '<i class="fas fa-copy"></i>' + caption + '</button>';
  }

  function handleCopy(event, btn) {
    if (event) event.preventDefault();
    let text = '';
    try {
      text = decodeURIComponent(btn.getAttribute('data-copy') || '');
    } catch (e) {
      text = btn.getAttribute('data-copy') || '';
    }
    return copyText(text, btn);
  }

  // Consistent empty-state markup used across pages.
  function emptyState(options) {
    const opts = options || {};
    const icon = opts.icon || 'fa-inbox';
    const title = escapeHtml(opts.title || 'Nothing here yet');
    const text = opts.text ? '<p>' + escapeHtml(opts.text) + '</p>' : '';
    const action = opts.actionLabel
      ? '<button class="btn ' + (opts.actionClass || 'btn-primary') + '" ' +
        (opts.actionOnclick ? 'onclick="' + opts.actionOnclick + '"' : '') + '>' +
        (opts.actionIcon ? '<i class="fas ' + escapeHtml(opts.actionIcon) + '"></i> ' : '') +
        escapeHtml(opts.actionLabel) + '</button>'
      : '';
    return '<div class="empty-state' + (opts.compact ? ' is-compact' : '') + '">' +
      '<i class="fas ' + escapeHtml(icon) + '"></i>' +
      '<h3>' + title + '</h3>' + text + action + '</div>';
  }

  // Skeleton placeholders for list/grid loading states.
  function skeletonCards(count, className) {
    const total = Math.max(1, Number(count) || 1);
    return new Array(total).fill(0).map(function () {
      return '<div class="skeleton-card ' + (className || '') + '">' +
        '<div class="skeleton skeleton-line short"></div>' +
        '<div class="skeleton skeleton-line"></div>' +
        '<div class="skeleton skeleton-block"></div>' +
        '</div>';
    }).join('');
  }

  // Human friendly relative time (client clock only).
  function timeAgo(value) {
    if (!value) return '—';
    const then = new Date(value).getTime();
    if (!Number.isFinite(then)) return '—';
    const diff = Math.max(0, Date.now() - then);
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return Math.floor(diff / minute) + 'm ago';
    if (diff < day) return Math.floor(diff / hour) + 'h ago';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return CORPUS_UTILS.formatDate(value);
  }

  return {
    toast,
    renderPagedList,
    delegate,
    guard,
    isBusy,
    installPressFeedback,
    confirm,
    escapeHtml,
    copyText,
    copyButton,
    handleCopy,
    emptyState,
    skeletonCards,
    timeAgo,
    closeConfirm,
    setButtonLoading,
    formatBytes,
    formatNumber,
    formatDuration,
    formatDate,
    setConnection,
    showOffline,
    hideOffline,
    setLoading,
    isAborted,
    updateNotificationBadge,
    statusBadge,
    modelConfigSummary,
    createChartContainer,
  };
})();

// Expose closeConfirm globally for inline HTML
window.ui.closeConfirm = window.ui.closeConfirm;