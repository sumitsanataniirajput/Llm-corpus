/* ========================================
   CORPUS ULTIMATE — Utility functions
   ======================================== */

window.CORPUS_UTILS = (function () {
  // Format bytes to human readable
  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // Format number with commas
  function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Format duration (seconds to human readable)
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  // Format date relative
  function formatDate(dateString) {
    if (!dateString) return '—';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + 'm ago';
    if (diffHours < 24) return diffHours + 'h ago';
    if (diffDays < 7) return diffDays + 'd ago';
    return d.toLocaleDateString();
  }

  // Show a toast. Deduplication lives in CORPUS_ACTIONS.notify() so it applies
  // to every notification in the app, including the ones that never pass
  // through ui.toast(). This renderer only has to paint and clean up.
  const ICONS = {
    success: 'check-circle',
    error: 'exclamation-circle',
    warning: 'triangle-exclamation',
    progress: 'circle-notch fa-spin',
    info: 'info-circle',
  };
  const MAX_VISIBLE_TOASTS = 4;
  const liveToasts = new Map();       // key → { el, timer }

  function dismissToast(key, immediate) {
    const entry = liveToasts.get(key);
    if (!entry) return;
    liveToasts.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    const el = entry.el;
    if (!el || !el.parentNode) return;
    if (immediate) {
      el.remove();
      return;
    }
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }

  function toast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return null;
    const kind = ICONS[type] ? type : 'info';
    const text = String(message == null ? '' : message);

    // One live toast per message+type: a repeated poll or a double submit must
    // not stack identical banners.
    const key = kind + ':' + text;
    if (liveToasts.has(key)) {
      const existing = liveToasts.get(key);
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = duration > 0 ? setTimeout(() => dismissToast(key), duration) : null;
      return key;
    }

    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.setAttribute('role', kind === 'error' || kind === 'warning' ? 'alert' : 'status');
    el.innerHTML = '<i class="fas fa-' + ICONS[kind] + '" aria-hidden="true"></i><span>' +
      escapeHtml(text) + '</span>' +
      '<button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>';
    el.querySelector('.toast-close').addEventListener('click', () => dismissToast(key));
    container.appendChild(el);
    // A burst of toasts must not cover the page on a phone.
    const overflow = container.querySelectorAll('.toast:not(.is-leaving)');
    if (overflow.length > MAX_VISIBLE_TOASTS) {
      const oldest = overflow[0];
      oldest.classList.add('is-leaving');
      setTimeout(() => oldest.remove(), 220);
    }

    let timer = null;
    if (duration > 0) timer = setTimeout(() => dismissToast(key), duration);
    liveToasts.set(key, { el: el, timer: timer });
    return key;
  }

  /** Long-running progress banner with a real percentage (never a fake one). */
  function progressToast(id, message, percent) {
    const container = document.getElementById('toast-container');
    if (!container) return { update: function () {}, close: function () {} };
    const key = 'progress:' + id;
    let entry = liveToasts.get(key);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'toast progress';
      el.setAttribute('role', 'status');
      el.innerHTML = '<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>' +
        '<span class="toast-progress-copy"></span>' +
        '<span class="toast-progress-track"><span class="toast-progress-fill"></span></span>';
      container.appendChild(el);
      entry = { el: el, timer: null };
      liveToasts.set(key, entry);
    }
    const copy = entry.el.querySelector('.toast-progress-copy');
    const fill = entry.el.querySelector('.toast-progress-fill');
    if (copy) copy.textContent = String(message == null ? '' : message);
    const pct = typeof percent === 'number' && isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
    if (fill) {
      fill.style.width = (pct == null ? 35 : pct) + '%';
      entry.el.classList.toggle('is-indeterminate', pct == null);
    }
    return {
      update: function (nextMessage, nextPercent) {
        if (copy) copy.textContent = String(nextMessage == null ? '' : nextMessage);
        const next = typeof nextPercent === 'number' && isFinite(nextPercent) ? Math.max(0, Math.min(100, nextPercent)) : null;
        if (fill) {
          fill.style.width = (next == null ? 35 : next) + '%';
          entry.el.classList.toggle('is-indeterminate', next == null);
        }
      },
      close: function () { dismissToast(key); },
    };
  }

  function dismissAllToasts() {
    Array.from(liveToasts.keys()).forEach(key => dismissToast(key, true));
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Debounce
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // Throttle
  function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  // Deep clone
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // Generate short ID
  function generateId(prefix = 'id') {
    return prefix + '_' + Math.random().toString(36).substr(2, 9);
  }

  // Calculate model parameters from config
  function calculateParameters(config) {
    const { vocab_size, context_length, d_model, n_layers, n_heads, d_ff } = config;
    if (!vocab_size || !d_model || !n_layers || !n_heads || !d_ff) return 0;
    // Embeddings: vocab_size * d_model + context_length * d_model (positional)
    const embeddings = vocab_size * d_model + context_length * d_model;
    // Per layer: attention (Q,K,V,O: 4 * d_model * d_model) + FFN (2 * d_model * d_ff) + layer norms (2 * d_model * 2)
    const attentionParams = 4 * d_model * d_model;
    const ffnParams = 2 * d_model * d_ff;
    const normParams = 4 * d_model;
    const perLayer = attentionParams + ffnParams + normParams;
    const layers = n_layers * perLayer;
    // Output projection: d_model * vocab_size
    const output = d_model * vocab_size;
    return embeddings + layers + output;
  }

  // Validate model config
  function validateModelConfig(config) {
    const errors = [];
    if (!config.vocab_size || config.vocab_size < 100) errors.push('Vocabulary size must be at least 100.');
    if (!config.context_length || config.context_length < 16) errors.push('Context length must be at least 16.');
    if (!config.d_model || config.d_model < 16) errors.push('Embedding dimension must be at least 16.');
    if (!config.n_layers || config.n_layers < 1) errors.push('At least 1 layer is required.');
    if (!config.n_heads || config.n_heads < 1) errors.push('At least 1 attention head is required.');
    if (config.d_model % config.n_heads !== 0) errors.push('Embedding dimension must be divisible by attention heads.');
    if (!config.d_ff || config.d_ff < 32) errors.push('Feed-forward dimension must be at least 32.');
    const params = calculateParameters(config);
    if (params > 100000000) errors.push('Estimated parameters exceed 100M — large configurations require explicit confirmation.');
    return { valid: errors.length === 0, errors, parameters: params };
  }

  // Parse a date value safely (returns null when unparseable).
  function asDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return {
    formatBytes,
    formatNumber,
    formatDuration,
    formatDate,
    toast,
    progressToast,
    dismissToast,
    dismissAllToasts,
    escapeHtml,
    asDate,
    debounce,
    throttle,
    clone,
    generateId,
    calculateParameters,
    validateModelConfig,
  };
})();