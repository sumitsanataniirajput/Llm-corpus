/* ========================================
   CORPUS ULTIMATE — Global action lifecycle
   ----------------------------------------
   One place that owns "what is happening right now". Every action in the app
   runs through `actions.run()` so the same guarantees hold everywhere:

     · the control that started it shows the work immediately;
     · the control always returns to exactly the markup/state it had before,
       even on failure, timeout, abort or navigation;
     · the same action on the same control can never run twice;
     · exactly one success or failure notification per outcome, and only after
       the backend confirmed it;
     · long-running work is a tracked operation with its real backend state,
       not a spinner that never ends.

   States: idle → processing → (success | completed | failed | cancelled).
   Background work goes idle → processing → queued → running → terminal.
   ======================================== */

window.CORPUS_ACTIONS = (function () {
  'use strict';

  const STATES = Object.freeze({
    IDLE: 'idle',
    PROCESSING: 'processing',
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCESS: 'success',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  });

  const TERMINAL = new Set([STATES.SUCCESS, STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED]);
  const BUSY = new Set([STATES.PROCESSING, STATES.QUEUED, STATES.RUNNING]);

  const STORAGE_KEY = 'corpus:operations:v1';
  const MAX_OPERATIONS = 25;
  const MAX_TEXT = 300;
  const DEFAULT_TIMEOUT_MS = 120000;   // ordinary API calls; uploads pass their own
  const SUCCESS_DEDUPE_MS = 1500;
  const ERROR_DEDUPE_MS = 6000;

  /* ------------------------------------------------------------------ utils */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function trim(value) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
  }

  let counter = 0;
  function nextId(prefix) {
    counter += 1;
    return (prefix || 'op') + '-' + Date.now().toString(36) + '-' + counter;
  }

  function isAbort(err) {
    if (!err) return false;
    if (err.aborted || err.code === 'ABORTED' || err.name === 'AbortError') return true;
    return false;
  }

  function isTimeout(err) {
    return !!(err && (err.timeout || err.name === 'TimeoutError' || err.code === 'TIMEOUT'));
  }

  function errorText(err) {
    if (!err) return 'The operation failed.';
    if (isTimeout(err)) return 'The request timed out. The backend did not answer in time.';
    if (isAbort(err)) return 'The operation was cancelled.';
    const detail = err.data && err.data.detail;
    if (Array.isArray(detail)) {
      const joined = detail.map(item => (item && (item.msg || item.message)) || String(item)).join(' ');
      if (joined) return trim(joined);
    }
    if (typeof detail === 'string' && detail) return trim(detail);
    if (detail && typeof detail === 'object' && detail.message) return trim(detail.message);
    if (typeof err.message === 'string' && err.message) return trim(err.message);
    return 'The operation failed.';
  }

  /* ---------------------------------------------------------------- toaster */

  // Notification bookkeeping lives here (not in the toast renderer) so a
  // duplicate click, a duplicated WebSocket event or a poll that fires twice
  // cannot produce two identical banners for one real outcome.
  const recentNotifications = new Map();

  function notify(message, type, options) {
    if (!message) return;
    const opts = options || {};
    const text = trim(message);
    const kind = type || 'info';
    const windowMs = kind === 'error' ? ERROR_DEDUPE_MS : SUCCESS_DEDUPE_MS;
    const key = opts.key ? kind + ':' + opts.key + ':' + text : kind + ':' + text;
    const now = Date.now();
    const previous = recentNotifications.get(key);
    if (previous && now - previous < windowMs) return;      // already announced
    recentNotifications.set(key, now);
    if (recentNotifications.size > 60) {
      // Forget the oldest keys; they are far outside the dedupe window anyway.
      const oldest = [...recentNotifications.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) recentNotifications.delete(oldest[0]);
    }
    const duration = opts.duration;
    // Always the low-level renderer: ui.toast() delegates here, so calling it
    // would loop back into this function.
    if (window.CORPUS_UTILS && typeof window.CORPUS_UTILS.toast === 'function') {
      window.CORPUS_UTILS.toast(text, kind, duration);
    }
  }

  /* ------------------------------------------------------- button lifecycle */

  // One snapshot per element, reference counted. The page owns `disabled`
  // (updateControls decides when a control is unavailable), so an action only
  // ever adds and removes its own busy attributes and markup.
  const buttonSnapshots = new WeakMap();

  function isElement(node) {
    return !!(node && node.nodeType === 1 && node.ownerDocument);
  }

  function beginButton(el, label) {
    if (!isElement(el)) return;
    let snap = buttonSnapshots.get(el);
    if (!snap) {
      snap = { count: 0, html: el.innerHTML, ariaBusy: el.getAttribute('aria-busy'), ariaDisabled: el.getAttribute('aria-disabled') };
      buttonSnapshots.set(el, snap);
    }
    snap.count += 1;
    if (snap.count > 1) return;               // outer action keeps the original markup
    if (!snap.html) snap.html = el.innerHTML;
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('aria-disabled', 'true');
    el.setAttribute('data-busy', 'true');
    el.classList.add('is-busy');
    el.innerHTML = '<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> ' +
      '<span class="btn-busy-label">' + escapeHtml(label || 'Working…') + '</span>';
  }

  function endButton(el) {
    if (!isElement(el)) return;
    const snap = buttonSnapshots.get(el);
    if (!snap) return;
    snap.count -= 1;
    if (snap.count > 0) return;
    buttonSnapshots.delete(el);
    // The element may have been replaced by a re-render; writing to a detached
    // node is harmless, and clearing data-busy keeps a recycled node usable.
    el.classList.remove('is-busy');
    if (snap.html) el.innerHTML = snap.html;
    if (snap.ariaBusy == null) el.removeAttribute('aria-busy');
    else el.setAttribute('aria-busy', snap.ariaBusy);
    if (snap.ariaDisabled == null) el.removeAttribute('aria-disabled');
    else el.setAttribute('aria-disabled', snap.ariaDisabled);
    el.removeAttribute('data-busy');
  }

  // A control that is mid-action cannot start another one — press or keyboard.
  // Capture phase, so the inline onclick never sees the click either.
  let pressBlockInstalled = false;
  function installBusyBlock() {
    if (pressBlockInstalled || typeof document === 'undefined') return;
    pressBlockInstalled = true;
    document.addEventListener('click', function (event) {
      const origin = event.target;
      // A busy control must never swallow a tap on an editable field. If a
      // page ever marks a container busy, its inputs still have to accept
      // focus and typing (Android opens the keyboard on the tap itself).
      if (origin && origin.matches && origin.matches(
        'input, textarea, select, [contenteditable="true"]'
      )) return;
      const target = origin && origin.closest ? origin.closest('[data-busy="true"]') : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  /* ------------------------------------------------------------- operations */

  const operations = [];                 // newest first
  const operationsById = new Map();

  function readStoredOperations() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function persistOperations() {
    try {
      const slim = operations.slice(0, MAX_OPERATIONS).map(op => ({
        id: op.id,
        kind: op.kind,
        name: op.name,
        state: op.state,
        progress: op.progress,
        startedAt: op.startedAt,
        endedAt: op.endedAt,
        result: op.result,
        error: op.error,
        jobId: op.jobId,
        key: op.key || null,
      }));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch (e) {
      // Private mode / quota: the centre still works for this session.
    }
  }

  function hydrateOperations() {
    readStoredOperations().forEach(op => {
      if (!op || !op.id || operationsById.has(op.id)) return;
      // An operation interrupted by a reload can never still be running: the
      // browser owned the poller. Mark it cancelled instead of showing a stale
      // "Running" forever.
      if (BUSY.has(op.state) && op.kind !== 'job') {
        op.state = STATES.CANCELLED;
        op.error = op.error || 'The page was reloaded before this operation finished.';
        op.endedAt = op.endedAt || op.startedAt;
      }
      operations.push(op);
      operationsById.set(op.id, op);
    });
    operations.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }

  const STATE_LABELS = {
    idle: 'Idle',
    processing: 'Processing',
    queued: 'Queued',
    running: 'Running',
    success: 'Success',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  function timeLabel(value) {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return '—';
    }
  }

  function ensureOperationPanel() {
    if (typeof document === 'undefined' || !document.body) return null;
    let host = document.getElementById('operation-center');
    if (host) return host;
    host = document.createElement('section');
    host.id = 'operation-center';
    host.className = 'operation-center hidden';
    host.setAttribute('aria-label', 'Operation status');
    host.innerHTML =
      '<button class="operation-toggle" type="button" id="operation-toggle" aria-expanded="false" aria-controls="operation-panel">' +
        '<i class="fas fa-list-check" aria-hidden="true"></i>' +
        '<span class="operation-toggle-label">Operations</span>' +
        '<span class="operation-count" id="operation-count" hidden>0</span>' +
      '</button>' +
      '<div class="operation-panel" id="operation-panel" role="region" aria-live="polite" hidden>' +
        '<div class="operation-panel-head">' +
          '<strong>Recent operations</strong>' +
          '<div class="operation-panel-actions">' +
            '<button class="btn btn-ghost btn-sm" type="button" id="operation-clear">Clear finished</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" id="operation-clear-all">Clear all</button>' +
          '</div>' +
        '</div>' +
        '<div class="operation-list" id="operation-list"></div>' +
      '</div>';
    document.body.appendChild(host);

    host.querySelector('#operation-toggle').addEventListener('click', function () {
      const open = host.classList.toggle('is-open');
      host.querySelector('#operation-panel').hidden = !open;
      host.querySelector('#operation-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    host.querySelector('#operation-clear').addEventListener('click', function () {
      clearFinished();
    });
    host.querySelector('#operation-clear-all').addEventListener('click', function () {
      clearAll();
    });
    // One delegated listener survives every re-render of the operation list.
    host.querySelector('#operation-list').addEventListener('click', function (event) {
      const target = event.target;
      if (!target || !target.closest) return;
      const clearBtn = target.closest('[data-operation-clear]');
      if (clearBtn) {
        clearOperation(clearBtn.getAttribute('data-operation-clear'));
        return;
      }
      const cancelBtn = target.closest('[data-operation-cancel]');
      if (cancelBtn) {
        cancelOperation(cancelBtn.getAttribute('data-operation-cancel'));
      }
    });
    return host;
  }

  function renderOperations() {
    const host = ensureOperationPanel();
    if (!host) return;
    const list = host.querySelector('#operation-list');
    const badge = host.querySelector('#operation-count');
    if (!list) return;

    host.classList.toggle('hidden', operations.length === 0);
    const active = operations.filter(op => BUSY.has(op.state)).length;
    if (badge) {
      badge.hidden = active === 0;
      badge.textContent = String(active);
      badge.classList.toggle('has-active', active > 0);
    }

    list.textContent = '';
    if (!operations.length) {
      const empty = document.createElement('p');
      empty.className = 'operation-empty';
      empty.textContent = 'No operations yet.';
      list.appendChild(empty);
      return;
    }

    operations.slice(0, 12).forEach(op => {
      const row = document.createElement('article');
      row.className = 'operation-row state-' + op.state;
      row.setAttribute('data-operation-id', op.id);

      const head = document.createElement('div');
      head.className = 'operation-row-head';
      const title = document.createElement('span');
      title.className = 'operation-name';
      title.textContent = op.name || 'Operation';
      const state = document.createElement('span');
      state.className = 'operation-state';
      state.textContent = STATE_LABELS[op.state] || op.state;
      head.appendChild(title);
      head.appendChild(state);

      const meta = document.createElement('div');
      meta.className = 'operation-meta';
      meta.textContent = 'Started ' + timeLabel(op.startedAt) + (op.endedAt ? ' · Finished ' + timeLabel(op.endedAt) : '');

      row.appendChild(head);
      row.appendChild(meta);

      if (op.state === STATES.PROCESSING || op.state === STATES.RUNNING) {
        const bar = document.createElement('div');
        bar.className = 'operation-progress';
        const fill = document.createElement('span');
        const pct = typeof op.progress === 'number' ? Math.max(0, Math.min(100, op.progress)) : null;
        fill.style.width = (pct == null ? 40 : pct) + '%';
        if (pct == null) bar.classList.add('is-indeterminate');
        bar.appendChild(fill);
        row.appendChild(bar);
        if (pct != null) {
          const label = document.createElement('div');
          label.className = 'operation-meta';
          label.textContent = pct + '%';
          row.appendChild(label);
        }
      }

      const tailText = op.error || op.result;
      if (tailText) {
        const tail = document.createElement('div');
        tail.className = 'operation-tail';
        tail.textContent = tailText;
        row.appendChild(tail);
      }

      const rowActions = document.createElement('div');
      rowActions.className = 'operation-row-actions';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-ghost btn-sm';
      clear.setAttribute('data-operation-clear', op.id);
      clear.setAttribute('aria-label', 'Clear ' + (op.name || 'operation'));
      clear.textContent = 'Clear';
      rowActions.appendChild(clear);
      if (BUSY.has(op.state)) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-ghost btn-sm';
        cancelBtn.setAttribute('data-operation-cancel', op.id);
        cancelBtn.setAttribute('aria-label', 'Cancel ' + (op.name || 'operation'));
        cancelBtn.textContent = 'Cancel';
        rowActions.appendChild(cancelBtn);
      }
      row.appendChild(rowActions);

      list.appendChild(row);
    });
  }

  function upsertOperation(patch) {
    if (!patch || !patch.id) return null;
    let op = operationsById.get(patch.id);
    if (!op) {
      op = {
        id: patch.id,
        kind: patch.kind || 'action',
        name: patch.name || 'Operation',
        state: STATES.PROCESSING,
        progress: null,
        startedAt: patch.startedAt || new Date().toISOString(),
        endedAt: null,
        result: null,
        error: null,
        jobId: patch.jobId || null,
        key: patch.key || null,
      };
      operationsById.set(op.id, op);
      operations.unshift(op);
      if (operations.length > MAX_OPERATIONS * 2) {
        const dropped = operations.splice(MAX_OPERATIONS);
        dropped.forEach(item => operationsById.delete(item.id));
      }
    }
    ['name', 'state', 'progress', 'result', 'error', 'jobId', 'endedAt', 'key'].forEach(key => {
      if (patch[key] !== undefined) op[key] = patch[key];
    });
    persistOperations();
    renderOperations();
    return op;
  }

  function beginOperation(options) {
    const opts = options || {};
    return upsertOperation({
      id: opts.id || nextId('op'),
      kind: opts.kind || 'action',
      name: opts.name || 'Operation',
      state: opts.state || STATES.PROCESSING,
      progress: opts.progress == null ? null : opts.progress,
      result: opts.result || null,
      error: null,
      jobId: opts.jobId || null,
      key: opts.key || null,
    });
  }

  function updateOperation(id, patch) {
    const op = operationsById.get(id);
    if (!op) return null;
    if (TERMINAL.has(op.state) && patch.state && !TERMINAL.has(patch.state)) return op;  // terminal is final
    return upsertOperation(Object.assign({ id: id }, patch));
  }

  /**
   * Finish a tracked operation exactly once. Duplicate events (the WebSocket
   * event and the polling fallback both seeing "completed", a double click
   * sending the same delete twice) resolve to a single notification.
   */
  function finishOperation(id, state, options) {
    const opts = options || {};
    const op = operationsById.get(id);
    if (!op) return null;
    if (TERMINAL.has(op.state)) {
      if (!op.endedAt) {
        // Terminal but unstamped (e.g. created straight into its final state).
        op.endedAt = new Date().toISOString();
        persistOperations();
        renderOperations();
      }
      return op;                                    // already settled: stay quiet
    }
    const settled = upsertOperation({
      id: id,
      state: state,
      progress: state === STATES.COMPLETED || state === STATES.SUCCESS ? 100 : op.progress,
      endedAt: new Date().toISOString(),
      result: opts.result ? trim(opts.result) : op.result,
      error: state === STATES.FAILED ? trim(opts.error || op.error || 'The operation failed.') : null,
    });
    if (opts.notify !== false) {
      if (state === STATES.FAILED) notify(opts.error || (op.name + ' failed.'), 'error', { key: id });
      else if (state === STATES.CANCELLED) notify((op.name || 'Operation') + ' cancelled.', 'warning', { key: id, duration: 2600 });
      else notify(opts.result || (op.name + ' completed successfully!'), 'success', { key: id });
    }
    if (typeof opts.onSettled === 'function') {
      try { opts.onSettled(settled); } catch (e) { /* never let a callback break the lifecycle */ }
    }
    return settled;
  }

  function clearFinished() {
    for (let index = operations.length - 1; index >= 0; index -= 1) {
      if (TERMINAL.has(operations[index].state)) {
        operationsById.delete(operations[index].id);
        operations.splice(index, 1);
      }
    }
    persistOperations();
    renderOperations();
  }

  /** Remove exactly one operation. Active work is cancelled before removal. */
  function clearOperation(id) {
    const op = operationsById.get(id);
    if (!op) return false;
    if (BUSY.has(op.state) && op.key) {
      try { cancel(op.key, 'cleared from operations'); } catch (e) { /* no controller */ }
    }
    operationsById.delete(id);
    const index = operations.findIndex(item => item.id === id);
    if (index !== -1) operations.splice(index, 1);
    persistOperations();
    renderOperations();
    return true;
  }

  /** Cancel a running operation from its row, leaving the cancelled record. */
  function cancelOperation(id) {
    const op = operationsById.get(id);
    if (!op || !BUSY.has(op.state)) return false;
    if (op.key) {
      try { cancel(op.key, 'cancelled from operations'); } catch (e) { /* no controller */ }
    }
    finishOperation(id, STATES.CANCELLED, {
      result: 'Cancelled from the Operations panel.',
      notify: false,
    });
    return true;
  }

  /** Clear the whole list, but only after an explicit confirmation. */
  function clearAll() {
    if (!operations.length) return false;
    const removeEverything = function () {
      Array.from(operationsById.values()).forEach(op => {
        if (BUSY.has(op.state) && op.key) {
          try { cancel(op.key, 'clear all'); } catch (e) { /* no controller */ }
        }
      });
      operationsById.clear();
      operations.length = 0;
      persistOperations();
      renderOperations();
    };
    const canConfirm = typeof window !== 'undefined' && window.ui &&
      typeof window.ui.confirm === 'function' && typeof document !== 'undefined' &&
      document.getElementById('confirm-dialog');
    if (canConfirm) {
      window.ui.confirm(
        'Clear all operations',
        'Remove every operation from this list? Active work will be cancelled.',
        removeEverything
      );
    } else {
      removeEverything();
    }
    return true;
  }

  function getOperation(id) {
    return operationsById.get(id) || null;
  }

  function listOperations() {
    return operations.slice();
  }

  /* ------------------------------------------------------------ action core */

  const running = new Map();        // dedupe key → promise of the outcome
  const abortControllers = new Map();

  // Stable identity per control. Deriving it from the current text would make
  // the same button look like a different button once its label changed to
  // "Saving…", which is exactly how a double tap slipped through before.
  const elementIds = new WeakMap();
  let elementCounter = 0;

  function elementKey(el) {
    if (!isElement(el)) return null;
    if (el.id) return 'el:' + el.id;
    const attr = (el.getAttribute('data-delete-model') || el.getAttribute('data-delete-dataset') ||
      el.getAttribute('data-storage-download') || el.getAttribute('data-api-key') || '');
    if (attr) return 'el:' + attr;
    let id = elementIds.get(el);
    if (!id) {
      elementCounter += 1;
      id = 'anon-' + elementCounter;
      elementIds.set(el, id);
    }
    return 'el:' + id;
  }

  function normaliseOutcome(state, extra) {
    return Object.assign({ state: state, ok: state === STATES.SUCCESS || state === STATES.COMPLETED }, extra || {});
  }

  /**
   * Run one action with full lifecycle, button and notification handling.
   *
   * spec = {
   *   name,                     // human label for the operation centre
   *   key,                      // dedupe key (defaults to the element)
   *   element,                  // control that shows the work
   *   label,                    // text while processing ("Saving…")
   *   success,                  // message shown after backend confirmation
   *   failure,                  // fallback error message
   *   track,                    // true → record in the operation centre
   *   background,               // true → resolves to queued/running, not success
   *   silent,                   // no success toast
   *   timeoutMs,                // abort the action after this long
   *   run: async (ctx) => value // the actual work; ctx.signal / ctx.report()
   *   onSuccess(value, ctx), onFailure(error, ctx), onFinally(outcome)
   * }
   */
  function run(spec) {
    const options = spec || {};
    const key = options.key || elementKey(options.element, options.name);

    if (key && running.has(key)) {
      // Second press while the first is still running: same promise, no second
      // request, no second toast.
      return running.get(key);
    }

    const name = options.name || 'Operation';
    const notifyFailure = options.notifyFailure !== undefined ? options.notifyFailure : options.silent !== true;
    const notifySuccess = options.notifySuccess !== undefined ? options.notifySuccess : options.silent !== true;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const operationId = options.track ? (options.id || nextId('op')) : null;
    const startedAt = new Date().toISOString();
    let stage = options.label || 'Working…';
    let timedOut = false;

    if (options.track) {
      beginOperation({
        id: operationId,
        kind: options.kind || 'action',
        name: name,
        state: STATES.PROCESSING,
        jobId: options.jobId || null,
        key: key || null,
      });
    }

    beginButton(options.element, stage);
    if (options.element && typeof window !== 'undefined') {
      installBusyBlock();
    }

    const ctx = {
      signal: controller ? controller.signal : undefined,
      operationId: operationId,
      name: name,
      /** Update the control label and long-running progress with real values. */
      report: function (update) {
        const patch = typeof update === 'string' ? { label: update } : (update || {});
        if (patch.label) {
          stage = patch.label;
          const el = options.element;
          const labelEl = isElement(el) && el.querySelector ? el.querySelector('.btn-busy-label') : null;
          if (labelEl) labelEl.textContent = stage;
        }
        if (operationId && (patch.progress !== undefined || patch.state !== undefined || patch.result !== undefined)) {
          updateOperation(operationId, {
            progress: patch.progress,
            state: patch.state,
            result: patch.result,
          });
        }
      },
      /** Some backends accept the work (202) and finish later. */
      background: function (job) {
        if (operationId) {
          updateOperation(operationId, {
            state: STATES.QUEUED,
            jobId: (job && (job.job_id || job.id)) || null,
            result: 'Accepted by the backend — waiting for it to run.',
          });
        }
      },
    };

    let timeoutHandle = null;
    let rejectTimeout = null;
    if (controller && Number(options.timeoutMs) > 0) {
      timeoutHandle = setTimeout(function () {
        timedOut = true;
        const err = new Error('Timed out');
        err.name = 'TimeoutError';
        err.timeout = true;
        try { controller.abort(err); } catch (e) { /* older browsers take no reason */ }
        if (typeof rejectTimeout === 'function') rejectTimeout(err);
      }, Number(options.timeoutMs));
    }

    const promise = (async function () {
      let value;
      try {
        const work = Promise.resolve().then(() => {
          // The user may have navigated away before the work even started.
          if (controller && controller.signal.aborted) {
            const aborted = new Error('Cancelled');
            aborted.name = 'AbortError';
            aborted.aborted = true;
            throw aborted;
          }
          return typeof options.run === 'function' ? options.run(ctx) : undefined;
        });
        if (timeoutHandle) {
          // Race, do not just abort: a request that ignores the abort signal
          // must still stop looking like it is in progress.
          const timeoutPromise = new Promise((resolve, reject) => { rejectTimeout = reject; });
          value = await Promise.race([work, timeoutPromise]);
        } else {
          value = await work;
        }
      } catch (error) {
        if (timedOut) {
          error = Object.assign(new Error('Timed out'), { name: 'TimeoutError', timeout: true });
        }
        const cancelled = isAbort(error) && !timedOut;
        const state = cancelled ? STATES.CANCELLED : STATES.FAILED;
        // The backend's own words always win over a generic label; the label is
        // only used when the error carries no useful detail.
        const detailText = errorText(error);
        const message = cancelled
          ? 'Cancelled'
          : (detailText && detailText !== 'The operation failed.' ? detailText : (options.failure || detailText));
        if (operationId) {
          finishOperation(operationId, state, { error: message, notify: !cancelled && notifyFailure });
        } else if (!cancelled && notifyFailure) {
          notify(message, 'error', { key: key || name });
        }
        if (typeof options.onFailure === 'function') {
          try { options.onFailure(error, ctx); } catch (e) { /* keep lifecycle intact */ }
        }
        return normaliseOutcome(state, { error: error, message: message, id: operationId });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      if (options.background) {
        const acceptedState = STATES.QUEUED;
        if (operationId) {
          updateOperation(operationId, {
            state: acceptedState,
            result: 'Accepted by the backend — waiting for it to run.',
          });
        }
        if (typeof options.onSuccess === 'function') {
          try {
            await options.onSuccess(value, ctx);
          } catch (callbackError) {
            if (window.CORPUS_APP && typeof window.CORPUS_APP.recordError === 'function') {
              window.CORPUS_APP.recordError('actions.onSuccess.' + name, (callbackError && callbackError.message) || 'callback failed', callbackError);
            }
          }
        }
        return normaliseOutcome(acceptedState, { value: value, id: operationId });
      }

      const successMessage = options.success || (name + ' completed successfully!');
      if (operationId) {
        finishOperation(operationId, STATES.COMPLETED, { result: successMessage, notify: notifySuccess });
      } else if (notifySuccess) {
        notify(successMessage, 'success', { key: key || name });
      }
      if (typeof options.onSuccess === 'function') {
        try {
          await options.onSuccess(value, ctx);
        } catch (callbackError) {
          // The backend action succeeded; only the follow-up UI work failed.
          // Record it instead of losing it silently.
          if (window.CORPUS_APP && typeof window.CORPUS_APP.recordError === 'function') {
            window.CORPUS_APP.recordError('actions.onSuccess.' + name, (callbackError && callbackError.message) || 'callback failed', callbackError);
          }
        }
      }
      return normaliseOutcome(STATES.SUCCESS, { value: value, message: successMessage, id: operationId });
    })();

    const tracked = promise.then(outcome => {
      endButton(options.element);
      if (options.track && operationId && !outcome.ok && outcome.state === STATES.CANCELLED) {
        finishOperation(operationId, STATES.CANCELLED, { notify: false });
      }
      if (key) running.delete(key);
      abortControllers.delete(key);
      if (typeof options.onFinally === 'function') {
        try { options.onFinally(outcome); } catch (e) { /* ignore */ }
      }
      return outcome;
    });

    if (key) {
      running.set(key, tracked);
      abortControllers.set(key, controller);
    }
    return tracked;
  }

  /**
   * A read/refresh control: it must show that it is working and come back, but
   * it must not fire a success toast for merely reloading a list (the refreshed
   * data is the feedback). A failure the loader does not render itself is still
   * reported.
   */
  function refresh(spec) {
    const options = spec || {};
    return run({
      name: options.name || 'Refresh',
      key: options.key || elementKey(options.element, options.name || 'refresh'),
      element: options.element,
      label: options.label || 'Refreshing…',
      notifySuccess: false,
      notifyFailure: options.notifyFailure !== false,
      failure: options.failure || ((options.name || 'Refresh') + ' failed.'),
      run: options.run,
      onSuccess: options.onSuccess,
      onFailure: options.onFailure,
    });
  }

  /** Cancel one action by key, or every running action (route change). */
  function cancel(key, reason) {
    const controller = abortControllers.get(key);
    if (!controller) return false;
    try { controller.abort(reason || 'cancelled'); } catch (e) { /* ignore */ }
    return true;
  }

  /**
   * Leaving a page must not leave a spinner behind on a control the user can
   * come back to, and must not let an in-flight action toast over the new page.
   */
  function cancelAll(reason) {
    Array.from(abortControllers.keys()).forEach(key => cancel(key, reason || 'navigation'));
  }

  // A navigation cancels what belonged to the page the user left.
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', function () { cancelAll('navigation'); });
    window.addEventListener('corpus:route-change', function () { cancelAll('navigation'); });
  }

  /* ------------------------------------------- background job status bridge */

  const JOB_STATE_MAP = {
    queued: STATES.QUEUED,
    preparing: STATES.QUEUED,
    requested: STATES.QUEUED,
    pending: STATES.QUEUED,
    running: STATES.RUNNING,
    training: STATES.RUNNING,
    evaluating: STATES.RUNNING,
    pausing: STATES.RUNNING,
    paused: STATES.RUNNING,
    stopping: STATES.RUNNING,
    completed: STATES.COMPLETED,
    succeeded: STATES.SUCCESS,
    success: STATES.SUCCESS,
    failed: STATES.FAILED,
    error: STATES.FAILED,
    cancelled: STATES.CANCELLED,
    canceled: STATES.CANCELLED,
  };

  const jobOperations = new Map();   // backend job id → operation id

  function mapStatus(status) {
    return JOB_STATE_MAP[String(status || '').toLowerCase()] || STATES.RUNNING;
  }

  /**
   * Track a backend job for its whole life. `syncJob` is called by every status
   * source (create response, WebSocket event, poll) and is idempotent: the
   * terminal state and its notification are emitted once, no matter how many
   * times or from how many places the same status arrives.
   */
  function syncJob(job, options) {
    if (!job || !job.id) return null;
    const opts = options || {};
    const state = mapStatus(job.status);
    let operationId = jobOperations.get(job.id);
    if (!operationId) {
      operationId = 'job-' + job.id;
      jobOperations.set(job.id, operationId);
    }
    const existing = operationsById.get(operationId);
    const name = opts.name || (existing && existing.name) || ('Training job ' + job.id);

    if (!existing) {
      // A job whose first observation is already terminal still has to go
      // through finishOperation(), otherwise it would never record a finish
      // time or announce anything.
      beginOperation({
        id: operationId,
        kind: 'job',
        name: name,
        state: BUSY.has(state) ? state : STATES.RUNNING,
        jobId: job.id,
        progress: opts.progress,
      });
    } else if (TERMINAL.has(existing.state)) {
      return existing;                        // final state already announced
    } else if (!TERMINAL.has(state)) {
      // Terminal transitions go through finishOperation() below, which stamps
      // the finish time and announces the outcome exactly once.
      updateOperation(operationId, { state: state, progress: opts.progress, jobId: job.id });
    }

    if (TERMINAL.has(state)) {
      const result = opts.result || (state === STATES.FAILED
        ? null
        : (name + ' completed successfully!'));
      finishOperation(operationId, state, {
        result: result,
        error: opts.error || (job.error ? trim(String(job.error)) : 'The backend reported this job as failed.'),
        notify: opts.notify !== false,
      });
    }
    return operationsById.get(operationId) || null;
  }

  function isJobTracked(jobId) {
    const operationId = jobOperations.get(jobId);
    return !!(operationId && operationsById.has(operationId));
  }

  /* ------------------------------------------------------------------- init */

  hydrateOperations();
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderOperations);
    } else {
      renderOperations();
    }
    installBusyBlock();
  }

  return {
    STATES: STATES,
    TERMINAL: TERMINAL,
    BUSY: BUSY,
    run: run,
    refresh: refresh,
    cancel: cancel,
    cancelAll: cancelAll,
    notify: notify,
    beginOperation: beginOperation,
    updateOperation: updateOperation,
    finishOperation: finishOperation,
    getOperation: getOperation,
    operations: listOperations,
    clearFinished: clearFinished,
    clearOperation: clearOperation,
    cancelOperation: cancelOperation,
    clearAll: clearAll,
    renderOperations: renderOperations,
    syncJob: syncJob,
    isJobTracked: isJobTracked,
    mapStatus: mapStatus,
    // exposed for ui.setButtonLoading and for tests
    beginButton: beginButton,
    endButton: endButton,
    // Restore a control completely (legacy setButtonLoading(false) semantics:
    // a page that called setButtonLoading twice must still be able to clear it).
    resetButton: function (el) {
      if (!isElement(el)) return;
      const snap = buttonSnapshots.get(el);
      if (!snap) return;
      snap.count = 1;
      endButton(el);
    },
    resetButtons: function () {
      // Safety valve for a re-render that drops a control mid-action.
      document.querySelectorAll('[data-busy="true"]').forEach(el => {
        buttonSnapshots.delete(el);
        el.classList.remove('is-busy');
        el.removeAttribute('data-busy');
        el.removeAttribute('aria-busy');
      });
    },
  };
})();

// Short alias used by page modules.
window.actions = window.CORPUS_ACTIONS;
