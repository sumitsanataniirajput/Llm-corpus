/* ========================================
   CORPUS ULTIMATE — UI components & helpers
   ======================================== */

window.ui = (function () {
  // Toast
  function toast(message, type = 'info', duration = 4000) {
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

    function cleanup() {
      dialog.classList.add('hidden');
      okBtn.onclick = null;
      backdrop.onclick = null;
      closeBtn.onclick = null;
    }

    okBtn.onclick = () => { cleanup(); if (onConfirm) onConfirm(); };
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
    const dot = indicator.querySelector('i');
    if (!indicator) return;
    indicator.classList.remove('hidden');
    if (status === 'connected') {
      dot.className = 'fas fa-circle text-success';
      text.textContent = 'Connected';
    } else if (status === 'disconnected') {
      dot.className = 'fas fa-circle text-error';
      text.textContent = 'Disconnected';
    } else {
      dot.className = 'fas fa-circle text-warning';
      text.textContent = 'Connecting...';
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

  return {
    toast,
    confirm,
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
    updateNotificationBadge,
    statusBadge,
    modelConfigSummary,
    createChartContainer,
  };
})();

// Expose closeConfirm globally for inline HTML
window.ui.closeConfirm = window.ui.closeConfirm;