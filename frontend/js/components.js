/* ========================================
   CORPUS ULTIMATE — UI components & helpers
   ======================================== */

// window.ui is shared with js/auth.js, which loads first and attaches the
// offline/loading helpers it calls at runtime (showOffline, hideOffline,
// setLoading, closeAuth). Assigning the object outright — as this file used to
// — wiped those helpers, so an auth event threw "ui.hideOffline is not a
// function". Merge instead, and let components win on a name collision.
window.ui = Object.assign(window.ui || {}, (function () {
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
    // Route through the action manager so success/error notifications are
    // deduplicated there, in one place, for the whole app.
    if (window.CORPUS_ACTIONS && window.CORPUS_ACTIONS.notify) {
      const opts = {};
      if (typeof duration === 'number') opts.duration = duration;
      window.CORPUS_ACTIONS.notify(message, type, opts);
      return;
    }
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

  /* Loading state on a button.

     The old version replaced the markup, disabled the control and set
     `disabled = false` again when it finished — which silently re-enabled
     controls the page had deliberately disabled (that is how Start Training
     came back from a failed run), lost the original markup when two actions
     touched the same button, and left "Working..." behind whenever an error
     path skipped the reset. It now delegates to the action manager, which
     snapshots the exact markup and accessibility attributes, reference-counts
     concurrent actions on the same control, and never touches `disabled`
     (the page owns that).

     `label` is optional; pass it to say what is happening ("Saving…"). */
  function setButtonLoading(btn, loading, label) {
    if (!btn) return;
    const manager = window.CORPUS_ACTIONS;
    if (!manager) {
      // Minimal fallback if actions.js failed to load.
      if (loading) {
        btn.dataset.originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Working…';
      } else if (btn.dataset.originalText) {
        btn.innerHTML = btn.dataset.originalText;
      }
      return;
    }
    if (loading) manager.beginButton(btn, label || 'Working…');
    else manager.resetButton(btn);
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
    const TARGETS = '.btn, button, .nav-item, .nav-group-summary, [role="button"], .tab, .chip';
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

  /* ------------------------------------------------------------------------
     Form-state preservation across full-page re-renders

     Several pages replace their whole container with `innerHTML = ...` while
     the user is typing: the Knowledge Distillation poller (every 5s), the
     Dataset Quality Review filters, provider save/retry, and auth session
     events (SIGNED_IN after an Android file-picker round trip or a token
     refresh). Replacing a focused <input> destroys its value, caret, text
     selection and — on Android — dismisses the soft keyboard. That is the
     "I cannot type into this field" bug, and it is not caused by an overlay.

     The guard below snapshots editable state immediately before ANY innerHTML
     write to the page container and restores it afterwards. It is installed
     once on that single element, so every page and every future page is
     covered without each module having to remember to opt in.

     Values live only in a local variable for the duration of one repaint:
     never in localStorage, never in a URL, never in a log. Password fields
     keep their `type="password"` masking at all times. When the form identity
     changes (i.e. the user navigated to a different page) nothing is restored,
     so a value can never leak from one page into another.
     ------------------------------------------------------------------------ */

  const FORM_FIELD_SELECTOR = 'input, textarea, select';
  // File inputs cannot be reassigned; buttons/hidden fields carry no typed text.
  const FORM_SKIP_TYPES = new Set([
    'file', 'hidden', 'submit', 'button', 'reset', 'image', 'color',
  ]);
  const FORM_TEXT_TYPES = new Set([
    '', 'text', 'password', 'search', 'email', 'url', 'tel', 'number',
    'date', 'time', 'datetime-local', 'month', 'week',
  ]);

  // Reads an attribute from either a DOM element or a captured entry object.
  function _formAttr(el, name) {
    if (el && typeof el.getAttribute === 'function') return el.getAttribute(name) || '';
    if (!el) return '';
    if (name === 'aria-label') return el.ariaLabel || '';
    return el[name] || '';
  }

  // The signature must identify the exact form, not merely the number of
  // inputs. Including the route means a value can never be carried from one
  // page into a different page that happens to use the same field names.
  function _formStateSignature(root, fields) {
    const view = root.ownerDocument && root.ownerDocument.defaultView;
    const route = (view && view.location && view.location.hash) || '';
    return String(route) + '|' + fields.map(function (el) {
      return [
        el.id || _formAttr(el, 'id'),
        _formAttr(el, 'name'),
        el.tagName || el.tag || '',
        String(el.type || _formAttr(el, 'type') || '').toLowerCase(),
        _formAttr(el, 'placeholder'),
        _formAttr(el, 'aria-label'),
      ].join(':');
    }).join('|');
  }

  function captureFormState(root) {
    if (!root || !root.querySelectorAll) return null;
    const ownerDocument = root.ownerDocument || document;
    const activeElement = ownerDocument.activeElement || null;
    const fields = Array.prototype.slice.call(root.querySelectorAll(FORM_FIELD_SELECTOR))
      .map(function (el, index) {
        const type = String(el.type || '').toLowerCase();
        const entry = {
          index: index,
          id: el.id || '',
          name: el.getAttribute('name') || '',
          tag: el.tagName,
          type: type,
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          skip: FORM_SKIP_TYPES.has(type),
          value: null,
          checked: !!el.checked,
          selectionStart: null,
          selectionEnd: null,
          scrollTop: el.scrollTop || 0,
          scrollLeft: el.scrollLeft || 0,
          focused: el === activeElement,
        };
        if (!entry.skip) {
          entry.value = el.value;
          if (el.tagName === 'TEXTAREA' || FORM_TEXT_TYPES.has(type)) {
            try {
              entry.selectionStart = el.selectionStart;
              entry.selectionEnd = el.selectionEnd;
            } catch (e) { /* search/email inputs do not expose selection */ }
          }
        }
        return entry;
      });
    return {
      fields: fields,
      signature: _formStateSignature(root, fields),
      focusWasInRoot: !!(activeElement && root.contains(activeElement)),
    };
  }

  function restoreFormState(root, snapshot) {
    if (!root || !snapshot || !snapshot.fields.length) return false;
    const fresh = Array.prototype.slice.call(root.querySelectorAll(FORM_FIELD_SELECTOR));
    // A different set of fields means a different page/form. Never carry typed
    // values (especially credentials) across a navigation.
    const signature = _formStateSignature(root, fresh);
    if (signature !== snapshot.signature) return false;

    const ownerDocument = root.ownerDocument || document;
    const EventCtor = (ownerDocument.defaultView && ownerDocument.defaultView.Event) || window.Event;
    root.__corpusRestoring = true;
    try {
      snapshot.fields.forEach(function (entry) {
        let el = fresh[entry.index];
        if (el && entry.id && el.id !== entry.id) el = null;
        if (!el && entry.id) el = fresh.find(function (c) { return c.id === entry.id; });
        if (!el && entry.name) {
          el = fresh.find(function (c) {
            return c.getAttribute('name') === entry.name && c.tagName === entry.tag;
          });
        }
        if (!el || el.tagName !== entry.tag) return;

        // Checkbox/radio state must survive too (e.g. the distillation consent).
        if (entry.type === 'checkbox' || entry.type === 'radio') {
          if (el.checked !== entry.checked) el.checked = entry.checked;
        } else if (!entry.skip && entry.value != null && el.value !== entry.value) {
          el.value = entry.value;
          // Let the page recompute derived UI (auto-grow, send-button state,
          // slider readouts) without bubbling into delegated page handlers.
          try { el.dispatchEvent(new EventCtor('input', { bubbles: false })); } catch (e) {}
        }
        if (entry.focused) {
          try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
          if (entry.selectionStart != null && typeof el.setSelectionRange === 'function') {
            try { el.setSelectionRange(entry.selectionStart, entry.selectionEnd); } catch (e) {}
          }
          el.scrollTop = entry.scrollTop;
          el.scrollLeft = entry.scrollLeft;
        }
      });
    } finally {
      root.__corpusRestoring = false;
    }
    return snapshot.focusWasInRoot;
  }

  /** Explicit wrapper for renders that are known to happen while typing. */
  async function repaintPreservingForms(root, repaint) {
    const snapshot = captureFormState(root);
    try {
      return await repaint();
    } finally {
      restoreFormState(root, snapshot);
    }
  }

  function _innerHTMLDescriptor(node) {
    let proto = Object.getPrototypeOf(node);
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      if (descriptor && typeof descriptor.get === 'function' && typeof descriptor.set === 'function') {
        return descriptor;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  /* Every page has hand-written forms, so fill in the Android keyboard hints
     once per render instead of trying to remember them in 15 modules. Existing
     explicit attributes (login `current-password`, Chat `enterkeyhint=send`,
     password `autocomplete=new-password`, …) are always left untouched. */
  function applyMobileInputHints(root) {
    if (!root || !root.querySelectorAll) return 0;
    let changed = 0;
    root.querySelectorAll('input, textarea').forEach(function (el) {
      const type = String(el.type || '').toLowerCase();
      if (FORM_SKIP_TYPES.has(type) ||
          ['checkbox', 'radio', 'range', 'file'].indexOf(type) !== -1) return;
      if (!el.hasAttribute('inputmode')) {
        let mode = 'text';
        if (type === 'number') {
          mode = String(el.getAttribute('step') || '').indexOf('.') !== -1 ? 'decimal' : 'numeric';
        } else if (type === 'email') mode = 'email';
        else if (type === 'url') mode = 'url';
        else if (type === 'tel') mode = 'tel';
        else if (type === 'search') mode = 'search';
        else if (type === 'password') mode = 'text';
        el.setAttribute('inputmode', mode);
        changed += 1;
      }
      if (!el.hasAttribute('enterkeyhint')) {
        el.setAttribute('enterkeyhint',
          el.tagName === 'TEXTAREA' ? 'enter' : (type === 'search' ? 'search' : 'done'));
        changed += 1;
      }
      if (!el.hasAttribute('autocapitalize')) {
        const cap = el.tagName === 'TEXTAREA' ? 'sentences'
          : (['password', 'email', 'url', 'search'].indexOf(type) !== -1 ? 'off' : 'words');
        el.setAttribute('autocapitalize', cap);
        changed += 1;
      }
      if (!el.hasAttribute('spellcheck')) {
        el.setAttribute('spellcheck',
          ['password', 'email', 'url', 'number', 'search'].indexOf(type) !== -1 ? 'false' : 'true');
        changed += 1;
      }
    });
    return changed;
  }

  /** Install the shared guard on one container. Safe to call repeatedly. */
  function installFormStateGuard(root) {
    if (!root || root.__corpusFormStateGuard) return false;
    const descriptor = _innerHTMLDescriptor(root);
    if (!descriptor) return false;
    Object.defineProperty(root, 'innerHTML', {
      configurable: true,
      enumerable: true,
      get: function () { return descriptor.get.call(this); },
      set: function (markup) {
        // A restore-triggered repaint must not recurse into another capture.
        if (this.__corpusRestoring) {
          descriptor.set.call(this, markup);
          return;
        }
        const snapshot = captureFormState(this);
        descriptor.set.call(this, markup);
        restoreFormState(this, snapshot);
        applyMobileInputHints(this);
      },
    });
    root.__corpusFormStateGuard = true;

    // Nested sections (`#kd-progress`, provider form slots, dynamic rows) are
    // replaced without touching the root's innerHTML setter. A childList
    // observer decorates those fields too. Setting attributes does not add or
    // remove nodes, so this cannot recurse.
    try {
      const view = root.ownerDocument && root.ownerDocument.defaultView;
      const Observer = (view && view.MutationObserver) || window.MutationObserver;
      if (Observer) {
        const observer = new Observer(function () { applyMobileInputHints(root); });
        observer.observe(root, { childList: true, subtree: true });
        root.__corpusMobileHintObserver = observer;
      }
    } catch (e) { /* MutationObserver is optional */ }
    applyMobileInputHints(root);
    return true;
  }

  // The page container exists by the time deferred scripts execute. Installing
  // here (as well as from the bootstrap, which is idempotent) means every page
  // — including pages loaded before bootstrap finishes — is protected.
  try {
    if (typeof document !== 'undefined' && document.getElementById) {
      installFormStateGuard(document.getElementById('page-container'));
    }
  } catch (e) { /* no DOM (source-only test sandbox) */ }

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
      // The execCommand fallback creates a temporary textarea. Calling
      // select() on it steals focus — on Android that closes the soft keyboard
      // and drops the caret in the field the user was editing. Remember the
      // focused control (and its selection) and put it back, and make sure the
      // helper element can never intercept a tap.
      const previous = document.activeElement;
      let previousStart = null;
      let previousEnd = null;
      if (previous && typeof previous.setSelectionRange === 'function') {
        try {
          previousStart = previous.selectionStart;
          previousEnd = previous.selectionEnd;
        } catch (e) { /* not a text field */ }
      }
      let area = null;
      try {
        area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.setAttribute('aria-hidden', 'true');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        area.style.pointerEvents = 'none';
        area.style.width = '1px';
        area.style.height = '1px';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand ? document.execCommand('copy') : false;
      } catch (e) {
        ok = false;
      } finally {
        if (area && area.parentNode) area.parentNode.removeChild(area);
        if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
          try { previous.focus({ preventScroll: true }); } catch (e) { try { previous.focus(); } catch (e2) {} }
          if (previousStart != null && typeof previous.setSelectionRange === 'function') {
            try { previous.setSelectionRange(previousStart, previousEnd); } catch (e) {}
          }
        }
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
    captureFormState,
    restoreFormState,
    repaintPreservingForms,
    installFormStateGuard,
    applyMobileInputHints,
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
})());