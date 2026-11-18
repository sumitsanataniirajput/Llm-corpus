/* ========================================
   CORPUS ULTIMATE — Device Compute & Multi-Device Training

   Two routes share this module:

     #/device-compute  what this browser really is, what it is doing, how it is
                       measured, and the controls that decide when it may work
     #/multi-device    every device on the account, what each one is working on,
                       and the two modes that are actually implemented:
                         parallel              — one independent job per device
                         collaborative-preprocess — devices tokenize shards of
                                                   one dataset and the backend
                                                   aggregates the real counts

   Rules kept throughout: capability values come from the browser or say "Not
   available"; progress comes from the backend; no control exists without a
   working backend action behind it.
   ======================================== */

window.devices = (function () {
  'use strict';

  const REFRESH_MS = 10000;

  let devicesCache = [];
  let jobsCache = [];
  let datasetsCache = [];
  let modelsCache = [];
  let tasksByJob = {};
  let sweepInfo = null;
  let refreshTimer = null;
  let unsubscribeAgent = null;
  let agentPaused = false;   // true while the user paused this device
  let lastNotice = null;

  function agent() {
    return window.CORPUS_DEVICE_AGENT || null;
  }

  function esc(value) {
    return ui.escapeHtml(value == null ? '' : String(value));
  }

  function na(value, suffix) {
    if (value === null || value === undefined || value === '') return 'Not available';
    return suffix ? value + suffix : String(value);
  }

  function mounted(selector) {
    return !!document.querySelector(selector);
  }

  function stopRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function scheduleRefresh(fn) {
    stopRefresh();
    refreshTimer = setInterval(() => {
      if (!mounted('#device-compute-root') && !mounted('#multi-device-root')) {
        stopRefresh();
        return;
      }
      fn();
    }, REFRESH_MS);
  }

  function dispose() {
    stopRefresh();
    if (unsubscribeAgent) unsubscribeAgent();
    unsubscribeAgent = null;
    const a = agent();
    if (a) a.stop();
  }

  /* ------------------------------------------------------------- data load */

  async function loadData(token) {
    const [deviceList, jobList, datasetList, modelList] = await Promise.all([
      window.CORPUS_API.listDevices(token),
      window.CORPUS_API.listTrainingJobs(token, { noCache: true }),
      window.CORPUS_API.listDatasets(token),
      window.CORPUS_API.listModels(token),
    ]);
    devicesCache = Array.isArray(deviceList && deviceList.devices) ? deviceList.devices : [];
    sweepInfo = (deviceList && deviceList.sweep) || null;
    jobsCache = Array.isArray(jobList) ? jobList : (jobList && jobList.jobs) || [];
    datasetsCache = window.CORPUS_API.asDatasetList(datasetList);
    modelsCache = Array.isArray(modelList) ? modelList : (modelList && modelList.models) || [];
    return devicesCache;
  }

  function heartbeatAge(device) {
    if (!device || !device.last_heartbeat) return 'Never';
    const seconds = Number(device.heartbeat_age_seconds);
    if (!Number.isFinite(seconds)) return CORPUS_UTILS.formatDate(device.last_heartbeat);
    if (seconds < 5) return 'Just now';
    if (seconds < 90) return Math.round(seconds) + ' s ago';
    if (seconds < 5400) return Math.round(seconds / 60) + ' min ago';
    return Math.round(seconds / 3600) + ' h ago';
  }

  function datasetName(id) {
    const found = datasetsCache.find((item) => item.id === id);
    return found ? (found.name || found.id) : (id || 'no dataset');
  }

  function modelName(id) {
    const found = modelsCache.find((item) => item.id === id);
    return found ? (found.name || found.id) : (id || 'no model');
  }

  function statusClasses(device) {
    const online = !!device.online;
    if (device.status === 'paused') return 'paused';
    if (!online) return 'offline';
    if (device.task) return 'busy';
    return 'online';
  }

  function deviceStatusLabel(device) {
    const cls = statusClasses(device);
    if (cls === 'busy') return 'Working';
    if (cls === 'online') return 'Connected';
    if (cls === 'paused') return 'Paused';
    return 'Offline';
  }

  function progressBar(percent, label) {
    const value = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
    if (value === null) {
      return '<div class="device-progress device-progress-indeterminate" role="progressbar" aria-valuetext="' +
        esc(label || 'Progress not measurable yet') + '"></div>' +
        '<span class="field-hint" style="margin:0;">' + esc(label || 'Progress not measurable yet') + '</span>';
    }
    return '<div class="device-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      value.toFixed(1) + '"><span style="width:' + value.toFixed(2) + '%"></span></div>' +
      '<span class="field-hint" style="margin:0;">' + value.toFixed(1) + '%' + (label ? ' · ' + esc(label) : '') + '</span>';
  }

  function stageLabel(job) {
    if (!job) return null;
    const labels = {
      queued: 'Queued', preparing: 'Preparing dataset', tokenizing: 'Tokenizing',
      loading_model: 'Loading model', initializing: 'Initialising training', training: 'Training',
      saving_checkpoints: 'Saving checkpoints', validating: 'Validating', finalizing: 'Finalising',
      completed: 'Completed', paused: 'Paused', interrupted: 'Interrupted', failed: 'Failed',
    };
    return labels[job.stage] || job.stage || null;
  }

  /* ------------------------------------------------------------- actions */

  async function connectThisDevice(button) {
    const a = agent();
    if (!a) {
      ui.toast('The device agent did not load on this page. Reload and try again.', 'error');
      return null;
    }
    return window.CORPUS_ACTIONS.run({
      name: 'Connect this device',
      key: 'devices:connect',
      element: button,
      label: 'Connecting…',
      success: 'This device is connected and reporting.',
      failure: 'Could not connect this device.',
      run: async function () {
        const registered = await a.start({ autoStart: true });
        agentPaused = false;
        return registered;
      },
      onSuccess: async function () {
        await refreshAll();
        if (mounted('#device-compute-root')) renderThisDevice();
      },
    });
  }

  async function measureThisDevice(button) {
    const a = agent();
    if (!a) return null;
    return window.CORPUS_ACTIONS.run({
      name: 'Measure device speed',
      key: 'devices:benchmark',
      element: button,
      label: 'Measuring…',
      success: 'Measurement finished — the numbers below were timed on this device.',
      failure: 'The measurement could not run on this device.',
      run: async function () { return a.runBenchmark(); },
      onSuccess: function () {
        if (mounted('#device-compute-root')) renderThisDevice();
      },
    });
  }

  async function disconnectThisDevice(button) {
    const a = agent();
    if (!a) return null;
    return window.CORPUS_ACTIONS.run({
      name: 'Disconnect this device',
      key: 'devices:disconnect',
      element: button,
      label: 'Disconnecting…',
      success: 'This device is offline. Its work was released to other devices.',
      failure: 'Could not disconnect this device.',
      run: async function () {
        agentPaused = true;
        return a.disconnect();
      },
      onSuccess: refreshAll,
    });
  }

  async function toggleSetting(key, value, input) {
    const a = agent();
    if (!a) return;
    a.setSettings({ [key]: value });
    if (!mounted('#device-compute-root')) return;
    // Reflect the effect immediately: turning processing off actually stops the
    // agent loops, and the backend is told on the next heartbeat.
    if (key === 'deviceProcessing') {
      if (value === false) {
        a.stop();
        agentPaused = true;
      } else if (!a.status().running) {
        agentPaused = false;
        await a.start({ autoStart: true }).catch(() => null);
      }
    }
    renderThisDevice();
    if (input) input.blur();
  }

  async function pauseDevice(deviceId, button) {
    return window.CORPUS_ACTIONS.run({
      name: 'Pause device worker',
      key: 'devices:pause:' + deviceId,
      element: button,
      label: 'Pausing…',
      success: 'Device paused. Its leased work was released.',
      failure: 'Could not pause the device.',
      run: async function () {
        const token = await state.getAccessToken();
        return window.CORPUS_API.updateDevice(deviceId, { status: 'paused' }, token);
      },
      onSuccess: refreshAll,
    });
  }

  async function resumeDevice(deviceId, button) {
    return window.CORPUS_ACTIONS.run({
      name: 'Resume device worker',
      key: 'devices:resume:' + deviceId,
      element: button,
      label: 'Resuming…',
      success: 'Device is online again.',
      failure: 'Could not resume the device.',
      run: async function () {
        const token = await state.getAccessToken();
        return window.CORPUS_API.updateDevice(deviceId, { status: 'online' }, token);
      },
      onSuccess: refreshAll,
    });
  }

  async function disconnectDevice(deviceId, button) {
    return window.CORPUS_ACTIONS.run({
      name: 'Disconnect device',
      key: 'devices:offline:' + deviceId,
      element: button,
      label: 'Disconnecting…',
      success: 'Device disconnected and its tasks released.',
      failure: 'Could not disconnect the device.',
      run: async function () {
        const token = await state.getAccessToken();
        return window.CORPUS_API.disconnectDevice(deviceId, token);
      },
      onSuccess: refreshAll,
    });
  }

  function removeDevice(deviceId, deviceName) {
    const device = devicesCache.find((item) => item.id === deviceId) || { name: deviceName };
    const active = !!device.task;
    ui.confirm(
      'Remove device',
      'Remove "' + (device.name || deviceName || deviceId) + '" from this account?' +
        (active ? ' Its current task is released and can be reassigned.' : '') +
        ' Models, datasets, checkpoints and training history are not deleted.',
      async function () {
        const button = document.querySelector('[data-device-remove="' + deviceId + '"]');
        return window.CORPUS_ACTIONS.run({
          name: 'Remove device',
          key: 'devices:remove:' + deviceId,
          element: button,
          label: 'Removing…',
          success: 'Device removed. Training history is untouched.',
          failure: 'Could not remove the device.',
          run: async function () {
            const token = await state.getAccessToken();
            return window.CORPUS_API.deleteDevice(deviceId, token);
          },
          onSuccess: async function () {
            try { window.localStorage.removeItem('corpus.device.id'); } catch (e) { /* ignore */ }
            await refreshAll();
          },
        });
      }
    );
  }

  async function assignJob(deviceId, jobId, kind, button, options) {
    const opts = options || {};
    if (!jobId) {
      ui.toast('Choose a training job first.', 'warning');
      return null;
    }
    return window.CORPUS_ACTIONS.run({
      name: opts.name || 'Assign training job',
      key: 'devices:assign:' + deviceId + ':' + jobId + ':' + (kind || 'train'),
      element: button,
      label: 'Assigning…',
      success: opts.success || 'Job assigned to the device.',
      failure: opts.failure || 'Could not assign the job.',
      run: async function () {
        const token = await state.getAccessToken();
        return window.CORPUS_API.assignDeviceTask(deviceId, { job_id: jobId, kind: kind || 'train' }, token);
      },
      onSuccess: refreshAll,
    });
  }

  /* --------------------------------------------------------- device compute */

  async function renderDeviceCompute() {
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    const user = state.getUser();
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Sign in to connect this device to your CORPUS account.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div id="device-compute-root">
        <div class="page-header">
          <div class="page-header-copy">
            <span class="eyebrow"><i class="fas fa-microchip"></i> Device compute</span>
            <h1 class="section-title">This device</h1>
            <p class="section-subtitle">What this browser really reports, what it is doing right now, and when it is allowed to work.</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-primary" type="button" id="device-connect" onclick="devices.connectThisDevice(this)">
              <i class="fas fa-plug"></i> Connect this device
            </button>
            <button class="btn btn-outline" type="button" id="device-measure" onclick="devices.measureThisDevice(this)">
              <i class="fas fa-gauge-high"></i> Measure speed
            </button>
          </div>
        </div>
        <div id="device-status-panel"></div>
        <div id="device-task-panel"></div>
        <div id="device-capability-panel"></div>
        <div id="device-controls-panel"></div>
      </div>
    `;

    renderThisDevice();

    const a = agent();
    if (a && unsubscribeAgent) unsubscribeAgent();
    if (a) {
      unsubscribeAgent = a.subscribe(function () {
        if (mounted('#device-compute-root')) renderThisDevice();
      });
    }

    try {
      const token = await state.getAccessToken();
      await loadData(token);
      renderOtherDevicesSummary();
    } catch (err) {
      if (!ui.isAborted || !ui.isAborted(err)) {
        ui.toast('Could not load your devices: ' + (err.message || 'unknown error'), 'error');
      }
    }
    scheduleRefresh(async () => {
      try {
        await loadData(await state.getAccessToken());
        renderThisDevice();
        renderOtherDevicesSummary();
      } catch (e) { /* the next tick retries */ }
    });
  }

  function renderThisDevice() {
    const statusPanel = document.getElementById('device-status-panel');
    if (!statusPanel) return;
    const a = agent();
    const snapshot = a ? a.status() : null;
    const device = snapshot && snapshot.device ? snapshot.device : null;
    const caps = snapshot && snapshot.capabilities ? snapshot.capabilities : null;
    const serverCaps = (device && device.capabilities) || {};
    const suit = snapshot ? snapshot.suitability : { level: 'unknown', label: 'Not determined yet', reasons: [] };
    const settings = snapshot ? snapshot.settings : {};

    const connection = device
      ? (device.online ? (device.status === 'paused' ? 'Connected · paused' : 'Connected') : 'Registered · offline')
      : 'Not connected';
    const connectionClass = device ? (device.online ? 'online' : 'offline') : 'offline';
    const workerLabel = snapshot
      ? (snapshot.worker === 'unsupported'
        ? 'Unavailable — this browser does not expose Web Workers'
        : snapshot.worker === 'error'
          ? 'Error — ' + (snapshot.lastError || 'the worker failed')
          : snapshot.worker === 'busy' ? 'Running a task' : 'Ready')
      : 'Not started';

    const executionMethod = caps ? caps.execution_method : (serverCaps.execution_method || null);
    const executionText = executionMethod === 'webgpu'
      ? 'WebGPU (GPU adapter detected)'
      : executionMethod === 'cpu-worker'
        ? 'CPU via Web Worker (WASM SIMD ' + (caps ? (caps.wasm_simd ? 'available' : 'not available') : 'unknown') + ')'
        : executionMethod === 'backend' ? 'Backend worker (this device only orchestrates)' : 'Not determined';

    statusPanel.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Connection</h2>
            <p class="card-subtitle">Registration, heartbeat and the worker that does the work.</p>
          </div>
          <span class="device-status device-status-${connectionClass}"><i class="fas fa-circle"></i> ${esc(connection)}</span>
        </div>
        <dl class="kv-grid">
          <div><dt>Device name</dt><dd>${esc(device ? device.name : na(null))}</dd></div>
          <div><dt>Device ID</dt><dd class="mono">${esc(device ? device.id : na(null))}</dd></div>
          <div><dt>Device type</dt><dd>${esc(caps ? na(caps.device_type) : na(serverCaps.device_type))}</dd></div>
          <div><dt>Platform</dt><dd>${esc(caps ? na(caps.platform) : na(serverCaps.platform))}</dd></div>
          <div><dt>Last heartbeat</dt><dd>${esc(device ? heartbeatAge(device) : na(null))}</dd></div>
          <div><dt>Execution method</dt><dd>${esc(executionText)}</dd></div>
          <div><dt>Worker status</dt><dd>${esc(workerLabel)}</dd></div>
          <div><dt>Suitability</dt><dd>${esc(suit.label)}</dd></div>
        </dl>
        ${suit.reasons.length ? '<p class="field-hint" style="margin:0;">Why: ' + esc(suit.reasons.join(' · ')) + '</p>' : ''}
        <p class="field-hint" style="margin:0;">Model training itself runs in the backend worker — this device orchestrates it and preprocesses dataset shards. Device-side gradient training is not implemented, and the app never claims it is.</p>
      </section>
    `;

    renderTaskPanel(snapshot, device);
    renderCapabilityPanel(caps, serverCaps, snapshot);
    renderControlsPanel(settings, snapshot);
  }

  function renderTaskPanel(snapshot, device) {
    const panel = document.getElementById('device-task-panel');
    if (!panel) return;
    const task = snapshot && snapshot.task ? snapshot.task : (device && device.task ? device.task : null);
    const job = (device && device.job) || null;

    if (!task) {
      panel.innerHTML = `
        <section class="card device-panel">
          <div class="card-head">
            <div>
              <h2 class="card-title">Assigned task</h2>
              <p class="card-subtitle">Nothing is assigned to this device right now.</p>
            </div>
          </div>
          <p class="field-hint" style="margin:0;">Assign work from <a href="#/multi-device" onclick="router.navigate('multi-device'); return false;">Multi-Device Training</a>.</p>
        </section>
      `;
      return;
    }

    const progress = snapshot && snapshot.progress !== null && snapshot.progress !== undefined
      ? snapshot.progress
      : task.progress_percent;

    panel.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Assigned task</h2>
            <p class="card-subtitle">${esc(task.kind === 'preprocess' ? 'Dataset preprocessing shard' : 'Training job (runs in the backend worker)')}</p>
          </div>
          ${ui.statusBadge(task.status === 'running' ? 'running' : task.status === 'assigned' ? 'queued' : task.status)}
        </div>
        <dl class="kv-grid">
          <div><dt>Job</dt><dd class="mono">${esc(task.job_id || na(null))}</dd></div>
          <div><dt>Stage</dt><dd>${esc(stageLabel(job) || 'Not reported yet')}</dd></div>
          <div><dt>Dataset</dt><dd>${esc(job && job.dataset_id ? datasetName(job.dataset_id) : na(null))}</dd></div>
          <div><dt>Model</dt><dd>${esc(job && job.model_id ? modelName(job.model_id) : na(null))}</dd></div>
          <div><dt>Shard</dt><dd>${esc(task.shard_count ? (Number(task.shard_index || 0) + 1) + ' of ' + task.shard_count : 'Not applicable')}</dd></div>
          <div><dt>Lease expires</dt><dd>${esc(task.lease_expires_at ? CORPUS_UTILS.formatDate(task.lease_expires_at) : 'Not held')}</dd></div>
        </dl>
        ${progressBar(progress, 'task progress')}
      </section>
    `;
  }

  function capRow(label, value, note) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) +
      (note ? '<span class="field-hint" style="display:block; margin:0;">' + esc(note) + '</span>' : '') + '</dd></div>';
  }

  function renderCapabilityPanel(caps, serverCaps, snapshot) {
    const panel = document.getElementById('device-capability-panel');
    if (!panel) return;
    const c = caps || {};
    const webgpu = c.webgpu || {};
    const measured = snapshot && snapshot.benchmark ? snapshot.benchmark : (serverCaps.measured || null);
    const gpuDescription = webgpu.supported
      ? (webgpu.description || webgpu.vendor || 'Adapter present') + ' (WebGPU)'
      : 'Not available' + (webgpu.reason ? ' — ' + webgpu.reason : '');
    const warnings = [];
    if (!c.webgpu || !c.webgpu.supported) warnings.push('No WebGPU adapter: work uses CPU workers, which are slower.');
    if (c.worker_support === false) warnings.push('This browser does not expose Web Workers, so device compute is disabled.');
    if (typeof c.device_memory_gb === 'number' && c.device_memory_gb < 2) warnings.push('Low reported memory: workload size is capped.');
    if (c.native_bridge && c.native_bridge.available) {
      warnings.push('A native app bridge is present (' + c.native_bridge.name + '); this page still cannot call NNAPI or a native GPU.');
    } else {
      warnings.push('No Android/native bridge detected. NNAPI and native GPU acceleration cannot be used from a web page.');
    }

    panel.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Measured capabilities</h2>
            <p class="card-subtitle">Values come from the browser and the operating system. Anything they do not expose says "Not available".</p>
          </div>
        </div>
        <dl class="kv-grid">
          ${capRow('CPU logical cores', na(c.cpu_cores))}
          ${capRow('Device memory', c.device_memory_gb ? c.device_memory_gb + ' GB' : na(null), 'navigator.deviceMemory (Chromium)')}
          ${capRow('JS heap limit', c.js_heap_limit_mb ? c.js_heap_limit_mb + ' MB' : na(null))}
          ${capRow('WebGPU', webgpu.supported ? 'Available' : 'Not available', webgpu.supported ? gpuDescription : (webgpu.reason || ''))}
          ${capRow('GPU buffer limit', webgpu.max_buffer_size ? Math.round(webgpu.max_buffer_size / 1048576) + ' MB' : na(null))}
          ${capRow('WebGL renderer', na(c.webgl_renderer))}
          ${capRow('WASM SIMD', c.wasm ? (c.wasm_simd ? 'Available' : 'Not available') : 'Not available')}
          ${capRow('Storage quota', c.storage_quota_gb ? c.storage_quota_gb + ' GB' : na(null))}
          ${capRow('Battery', c.battery && c.battery.level_percent !== null
            ? c.battery.level_percent + '%' + (c.battery.charging ? ' · charging' : ' · on battery')
            : na(null))}
          ${capRow('Connection', c.connection && c.connection.type ? c.connection.type : na(null))}
          ${capRow('Screen', c.screen && c.screen.width ? c.screen.width + '×' + c.screen.height + ' @' + (c.screen.dpr || 1) + 'x' : na(null))}
          ${capRow('Native bridge', c.native_bridge && c.native_bridge.available
            ? 'Available (' + c.native_bridge.name + ')'
            : 'Not detected')}
          ${capRow('Measured tokenizer speed', measured && measured.tokens_per_second
            ? Math.round(measured.tokens_per_second).toLocaleString() + ' tokens/s'
            : na(null), measured ? 'Measured on this device at ' + CORPUS_UTILS.formatDate(measured.measured_at) : 'Run “Measure speed” to obtain a real number')}
        </dl>
        <ul class="device-warnings">
          ${warnings.map((warning) => '<li><i class="fas fa-triangle-exclamation"></i> ' + esc(warning) + '</li>').join('')}
        </ul>
      </section>
    `;
  }

  function toggleRow(key, label, hint, checked) {
    return `
      <label class="device-toggle">
        <input type="checkbox" data-device-setting="${esc(key)}" ${checked ? 'checked' : ''}
          onchange="devices.toggleSetting('${esc(key)}', this.checked, this)">
        <span>
          <strong>${esc(label)}</strong>
          <span class="field-hint">${esc(hint)}</span>
        </span>
      </label>
    `;
  }

  function renderControlsPanel(settings, snapshot) {
    const panel = document.getElementById('device-controls-panel');
    if (!panel) return;
    panel.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Device controls</h2>
            <p class="card-subtitle">Nothing runs on this device unless you allow it. Preferences are stored in this browser and sent with every heartbeat.</p>
          </div>
        </div>
        <div class="device-toggles">
          ${toggleRow('deviceProcessing', 'Device processing', 'Allow this device to take preprocessing work.', settings.deviceProcessing !== false)}
          ${toggleRow('allowCollaborative', 'Collaborative work', 'Accept a shard of a shared dataset.', settings.allowCollaborative !== false)}
          ${toggleRow('cpuFallback', 'CPU fallback', 'Use CPU workers when no GPU is available.', settings.cpuFallback !== false)}
          ${toggleRow('wifiOnly', 'Wi-Fi only', 'Do not use metered connections.', !!settings.wifiOnly)}
          ${toggleRow('preferCharging', 'Prefer charging', 'Pause heavy work while on battery.', !!settings.preferCharging)}
          ${toggleRow('pauseOnMemoryPressure', 'Pause on memory pressure', 'Stop when the device reports low memory.', settings.pauseOnMemoryPressure !== false)}
        </div>
        <div class="form-grid" style="margin-top:var(--space-3);">
          <div class="input-field">
            <label for="device-gpu-mode">GPU usage</label>
            <select id="device-gpu-mode" onchange="devices.setGpuMode(this.value)">
              <option value="auto" ${settings.gpuMode === 'auto' ? 'selected' : ''}>Automatic</option>
              <option value="on" ${settings.gpuMode === 'on' ? 'selected' : ''}>Prefer GPU</option>
              <option value="off" ${settings.gpuMode === 'off' ? 'selected' : ''}>Never use GPU</option>
            </select>
          </div>
          <div class="input-field">
            <label for="device-workload">Maximum workload</label>
            <select id="device-workload" onchange="devices.setWorkload(this.value)">
              <option value="low" ${settings.maxWorkload === 'low' ? 'selected' : ''}>Small (low memory devices)</option>
              <option value="medium" ${settings.maxWorkload === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${settings.maxWorkload === 'high' ? 'selected' : ''}>Large (desktop)</option>
            </select>
            <span class="field-hint">Chunks are capped by the memory the browser reports.</span>
          </div>
        </div>
        <div class="training-actions" style="margin-top:var(--space-3);">
          <button class="btn btn-outline" type="button" onclick="devices.disconnectThisDevice(this)">
            <i class="fas fa-plug-circle-xmark"></i> Disconnect this device
          </button>
        </div>
        <p class="field-hint">${esc(snapshot && snapshot.lastError ? 'Last error: ' + snapshot.lastError : 'No errors reported by the device worker.')}</p>
      </section>
      <div id="device-others"></div>
    `;
  }

  function renderOtherDevicesSummary() {
    const holder = document.getElementById('device-others');
    if (!holder) return;
    const others = devicesCache.filter((device) => {
      const mine = agent() && agent().status().deviceId;
      return !mine || device.id !== mine;
    });
    if (!others.length) {
      holder.innerHTML = '';
      return;
    }
    holder.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Other devices on this account</h2>
            <p class="card-subtitle">Manage them on the Multi-Device Training page.</p>
          </div>
        </div>
        <ul class="device-mini-list">
          ${others.map((device) => `
            <li>
              <span class="device-status device-status-${statusClasses(device) === 'busy' ? 'online' : statusClasses(device)}">
                <i class="fas fa-circle"></i> ${esc(deviceStatusLabel(device))}
              </span>
              <strong>${esc(device.name)}</strong>
              <span class="field-hint" style="margin:0;">${esc(device.device_type || 'type not reported')} · ${esc(heartbeatAge(device))}</span>
            </li>
          `).join('')}
        </ul>
      </section>
    `;
  }

  /* ----------------------------------------------------- multi-device view */

  async function renderMultiDevice() {
    const container = window.CORPUS_APP.getPageContainer();
    if (!container) return;
    const user = state.getUser();
    if (!user) {
      container.innerHTML = ui.emptyState({
        icon: 'fa-user-circle',
        title: 'Sign in required',
        text: 'Sign in to manage your training devices.',
        actionLabel: 'Sign in',
        actionOnclick: "auth.openModal('login')",
        actionIcon: 'fa-sign-in-alt',
      });
      return;
    }

    container.innerHTML = `
      <div id="multi-device-root">
        <div class="page-header">
          <div class="page-header-copy">
            <span class="eyebrow"><i class="fas fa-network-wired"></i> Multi-device training</span>
            <h1 class="section-title">Devices &amp; distribution</h1>
            <p class="section-subtitle">Every device on your account, what each one is doing, and the two modes this backend really implements.</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-primary" type="button" onclick="devices.connectThisDevice(this)">
              <i class="fas fa-plus"></i> Connect new device
            </button>
            <button class="btn btn-outline" type="button" onclick="devices.refresh(this)">
              <i class="fas fa-rotate"></i> Refresh
            </button>
          </div>
        </div>
        <div id="multi-device-alert"></div>
        <div class="worker-grid" id="multi-device-list">
          ${ui.skeletonCards(2)}
        </div>
        <div id="multi-device-plan"></div>
        <div id="multi-device-jobs"></div>
      </div>
    `;

    try {
      await loadData(await state.getAccessToken());
    } catch (err) {
      if (ui.isAborted && ui.isAborted(err)) return;
      const alert = document.getElementById('multi-device-alert');
      if (alert) {
        alert.innerHTML = '<div class="form-alert error" role="alert">Could not load devices: ' +
          esc(err.message || 'unknown error') + '</div>';
      }
    }

    renderDeviceList();
    renderPlanPanel();
    renderJobsPanel();
    scheduleRefresh(async () => {
      try {
        await loadData(await state.getAccessToken());
        renderDeviceList();
        renderJobsPanel();
      } catch (e) { /* retry on the next tick */ }
    });
  }

  async function refresh(button) {
    return window.CORPUS_ACTIONS.refresh({
      name: 'Refresh devices',
      element: button,
      run: async function () {
        await loadData(await state.getAccessToken());
        renderJobCards();
        return devicesCache.length;
      },
      onSuccess: function () {
        renderDeviceList();
        renderJobsPanel();
        renderPlanPanel();
      },
    });
  }

  function renderDeviceList() {
    const holder = document.getElementById('multi-device-list');
    if (!holder) return;
    if (!devicesCache.length) {
      holder.innerHTML = ui.emptyState({
        icon: 'fa-plug',
        title: 'No devices connected',
        text: 'Use “Connect new device” on the machine you want to contribute. Each browser becomes its own device.',
        compact: true,
      });
      return;
    }
    holder.innerHTML = devicesCache.map(renderDeviceCard).join('');
  }

  function renderDeviceCard(device) {
    const caps = device.capabilities || {};
    const job = device.job || null;
    const task = device.task || null;
    const preferredJob = pickPreferredJob(device);
    const jobOptions = jobsCache
      .filter((job) => ['queued', 'preparing', 'running', 'paused'].indexOf(job.status) !== -1)
      .slice(0, 12)
      .map((job) => '<option value="' + esc(job.id) + '"' + (preferredJob === job.id ? ' selected' : '') + '>' +
        esc(job.id + ' · ' + (job.status || 'queued') + ' · ' + modelName(job.model_id)) + '</option>')
      .join('');

    const capabilitiesText = [
      caps.webgpu ? 'WebGPU' : null,
      caps.wasm_simd ? 'WASM SIMD' : null,
      caps.cpu_cores ? caps.cpu_cores + ' cores' : null,
      caps.device_memory_gb ? caps.device_memory_gb + ' GB' : null,
      caps.execution_method || null,
    ].filter(Boolean).join(' · ');

    return `
      <article class="card device-card" data-device-id="${esc(device.id)}">
        <div class="card-head">
          <div>
            <h3 class="card-title">${esc(device.name)}</h3>
            <p class="card-subtitle">${esc(device.device_type || 'type not reported')} · ${esc(device.platform || 'platform not reported')}</p>
          </div>
          <span class="device-status device-status-${statusClasses(device) === 'paused' ? 'paused' : (device.online ? (device.task ? 'busy' : 'online') : 'offline')}">
            <i class="fas fa-circle"></i> ${esc(deviceStatusLabel(device))}
          </span>
        </div>

        <dl class="kv-grid kv-grid-compact">
          <div><dt>Capabilities</dt><dd>${esc(capabilitiesText || 'Not reported')}</dd></div>
          <div><dt>Current job</dt><dd>${esc(job ? (job.id + ' · ' + (job.stage || job.status)) : 'Idle')}</dd></div>
          <div><dt>Dataset</dt><dd>${esc(job && job.dataset_id ? datasetName(job.dataset_id) : 'Not assigned')}</dd></div>
          <div><dt>Modeled work</dt><dd>${esc(task ? (task.kind === 'preprocess' ? 'Preprocessing shard' : 'Backend training') : 'None')}</dd></div>
          <div><dt>Mode</dt><dd>${esc(task && task.detail && task.detail.mode ? task.detail.mode : 'idle')}</dd></div>
          <div><dt>Last heartbeat</dt><dd>${esc(heartbeatAge(device))}</dd></div>
        </dl>

        ${task || job
          ? progressBar(task ? task.progress_percent : job.progress_percent,
              stageLabel(job) || (task ? 'task ' + task.status : 'stage not reported'))
          : '<p class="field-hint" style="margin:0;">No work assigned.</p>'}
        ${job && job.total_steps
          ? '<p class="field-hint" style="margin:0;">' + esc((job.completed_steps || 0) + ' / ' + job.total_steps + ' steps · epoch ' +
              (job.current_epoch || 0) + ' / ' + (job.total_epochs || 0)) + '</p>'
          : ''}

        <div class="device-card-actions">
          <button class="btn btn-outline btn-sm" type="button" data-device-pause="${esc(device.id)}"
            onclick="devices.pauseDevice('${esc(device.id)}', this)" ${device.status === 'paused' ? 'disabled' : ''}>
            <i class="fas fa-pause"></i> Pause
          </button>
          <button class="btn btn-outline btn-sm" type="button" data-device-resume="${esc(device.id)}"
            onclick="devices.resumeDevice('${esc(device.id)}', this)" ${device.status === 'paused' ? '' : 'disabled'}>
            <i class="fas fa-play"></i> Resume
          </button>
          <button class="btn btn-outline btn-sm" type="button" data-device-disconnect="${esc(device.id)}"
            onclick="devices.disconnectDevice('${esc(device.id)}', this)">
            <i class="fas fa-plug-circle-xmark"></i> Disconnect
          </button>
          <button class="btn btn-outline btn-sm" type="button" data-device-remove="${esc(device.id)}"
            onclick="devices.removeDevice('${esc(device.id)}', '${esc(device.name)}')">
            <i class="fas fa-trash"></i> Remove
          </button>
        </div>

        <div class="device-assign">
          <label for="assign-${esc(device.id)}" class="field-hint">Assign training job</label>
          <div class="device-assign-row">
            <select id="assign-${esc(device.id)}" data-assign-select="${esc(device.id)}">
              <option value="">Select a job…</option>
              ${jobOptions}
            </select>
            <select id="assign-kind-${esc(device.id)}" data-assign-kind="${esc(device.id)}">
              <option value="train">Train (backend worker)</option>
              <option value="preprocess">Preprocess shard (this device)</option>
            </select>
            <button class="btn btn-primary btn-sm" type="button" onclick="devices.assignFromCard('${esc(device.id)}', this)">
              <i class="fas fa-share-nodes"></i> Assign
            </button>
          </div>
        </div>
      </article>
    `;
  }

  function pickPreferredJob() {
    const active = jobsCache.find((job) => ['queued', 'preparing', 'running', 'paused'].indexOf(job.status) !== -1);
    return active ? active.id : '';
  }

  function assignFromCard(deviceId, button) {
    const jobSelect = document.querySelector('[data-assign-select="' + deviceId + '"]');
    const kindSelect = document.querySelector('[data-assign-kind="' + deviceId + '"]');
    const jobId = jobSelect ? jobSelect.value : '';
    const kind = kindSelect ? kindSelect.value : 'train';
    if (!jobId) {
      ui.toast('Select a job to assign first.', 'warning');
      return null;
    }
    return assignJob(deviceId, jobId, kind, button);
  }

  function renderPlanPanel() {
    const holder = document.getElementById('multi-device-plan');
    if (!holder) return;
    const online = devicesCache.filter((device) => device.online);
    holder.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Distribution</h2>
            <p class="card-subtitle">Two modes, both backed by real endpoints.</p>
          </div>
        </div>
        <div class="mode-grid">
          <div class="mode-card">
            <h3><i class="fas fa-diagram-project"></i> Independent jobs (parallel)</h3>
            <p class="field-hint">Each device owns a different job. Jobs keep their own progress, metrics and checkpoints; nothing overwrites anything.</p>
            <button class="btn btn-outline" type="button" onclick="devices.startParallel(this)">
              <i class="fas fa-play"></i> Distribute active jobs
            </button>
          </div>
          <div class="mode-card">
            <h3><i class="fas fa-layer-group"></i> Collaborative preprocessing</h3>
            <p class="field-hint">One dataset is split into shards; every chosen device tokenizes its own shard and the backend aggregates the real token counts into the job history.</p>
            <p class="field-hint">Gradient/weight synchronisation is <strong>not</strong> implemented — this mode does not train one shared model across devices.</p>
            <div class="device-assign-row">
              <select id="collab-job" aria-label="Job to preprocess">${
                jobsCache.filter((job) => ['queued', 'preparing', 'running', 'paused'].indexOf(job.status) !== -1)
                  .map((job) => '<option value="' + esc(job.id) + '">' +
                    esc(job.id + ' · ' + datasetName(job.dataset_id)) + '</option>').join('') ||
                  '<option value="">No active job</option>'
              }</select>
              <button class="btn btn-primary" type="button" onclick="devices.startCollaborative(this)" ${online.length ? '' : 'disabled'}>
                <i class="fas fa-share-nodes"></i> Split across ${online.length || 0} online device${online.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
        ${sweepInfo && (sweepInfo.devices_offline || sweepInfo.tasks_expired)
          ? '<p class="field-hint" style="margin-top:var(--space-2);">Last sweep released ' + Number(sweepInfo.tasks_expired || 0) +
            ' expired task(s) and marked ' + Number(sweepInfo.devices_offline || 0) + ' device(s) offline.</p>'
          : ''}
      </section>
    `;
  }

  async function startParallel(button) {
    // Every queued job is offered: the backend decides what fits where and
    // answers per job, so a job that cannot be placed is reported, not dropped.
    const jobIds = jobsCache.filter((job) => job.status === 'queued').slice(0, 20).map((job) => job.id);
    if (!jobIds.length) {
      ui.toast('There are no queued jobs to distribute. Start a job on the Training page first.', 'warning');
      return null;
    }
    return window.CORPUS_ACTIONS.run({
      name: 'Distribute jobs across devices',
      key: 'devices:parallel',
      element: button,
      label: 'Distributing…',
      success: 'Jobs were distributed across the available devices.',
      failure: 'Could not distribute the jobs.',
      run: async function () {
        const token = await state.getAccessToken();
        return window.CORPUS_API.autoAssignDevices(jobIds, token);
      },
      onSuccess: async function (data) {
        await loadData(await state.getAccessToken());
        renderDeviceList();
        renderJobsPanel();
        const assignments = (data && data.assignments) || [];
        const unassigned = assignments.filter((item) => !item.assigned);
        if (unassigned.length) {
          ui.toast(unassigned.length + ' job(s) could not be assigned: ' +
            (unassigned[0].reason || 'no suitable device'), 'warning', 6000);
        }
      },
    });
  }

  async function startCollaborative(button) {
    const select = document.getElementById('collab-job');
    const jobId = select ? select.value : '';
    if (!jobId) {
      ui.toast('Start a training job first, then choose it here.', 'warning');
      return null;
    }
    const deviceIds = devicesCache.filter((device) => device.online).map((device) => device.id);
    return window.CORPUS_ACTIONS.run({
      name: 'Plan collaborative preprocessing',
      key: 'devices:collaborative:' + jobId,
      element: button,
      label: 'Planning…',
      success: 'Dataset shards were assigned to the devices.',
      failure: 'Could not plan the collaborative run.',
      run: async function () {
        const token = await state.getAccessToken();
        return window.CORPUS_API.planCollaborative({ job_id: jobId, device_ids: deviceIds }, token);
      },
      onSuccess: async function (data) {
        await loadData(await state.getAccessToken());
        renderDeviceList();
        renderJobsPanel();
        await loadJobTasks(jobId);
        renderJobsPanel();
        if (data && data.synchronisation) {
          ui.toast(data.synchronisation, 'info', 9000);
        }
      },
    });
  }

  async function loadJobTasks(jobId) {
    try {
      const token = await state.getAccessToken();
      const data = await window.CORPUS_API.listJobDeviceTasks(jobId, token);
      tasksByJob[jobId] = data;
      return data;
    } catch (err) {
      return null;
    }
  }

  function renderJobCards() {
    renderJobsPanel();
  }

  function renderJobsPanel() {
    const holder = document.getElementById('multi-device-jobs');
    if (!holder) return;
    const active = jobsCache.filter((job) => {
      return ['queued', 'preparing', 'running', 'paused', 'finalizing'].indexOf(job.status) !== -1 || tasksByJob[job.id];
    }).slice(0, 6);

    if (!active.length) {
      holder.innerHTML = '';
      return;
    }

    holder.innerHTML = `
      <section class="card device-panel">
        <div class="card-head">
          <div>
            <h2 class="card-title">Live progress per job</h2>
            <p class="card-subtitle">Percent is the coordinator's real completed work — never an average of device percentages.</p>
          </div>
        </div>
        ${active.map((job) => {
          const tasks = (tasksByJob[job.id] || {}).tasks || [];
          const shards = tasks.filter((task) => task.kind === 'preprocess');
          const done = shards.filter((task) => task.status === 'completed').length;
          const tokens = shards.reduce((sum, task) => {
            const value = task.detail && task.detail.result && task.detail.result.token_count;
            return sum + (Number.isFinite(Number(value)) ? Number(value) : 0);
          }, 0);
          return `
            <div class="job-progress-card" data-job-card="${esc(job.id)}">
              <div class="job-row-main">
                ${ui.statusBadge(job.status || 'queued')}
                <span class="job-row-id mono">${esc(job.id)}</span>
                <span class="field-hint" style="margin:0;">${esc(modelName(job.model_id))} · ${esc(datasetName(job.dataset_id))}</span>
              </div>
              ${progressBar(job.progress_percent, stageLabel(job) || job.status)}
              ${job.total_steps
                ? '<p class="field-hint" style="margin:0;">' + esc((job.completed_steps || 0) + ' / ' + job.total_steps + ' steps · epoch ' +
                    (job.current_epoch || 0) + ' / ' + (job.total_epochs || 0) +
                    (job.processed_tokens ? ' · ' + Number(job.processed_tokens).toLocaleString() + ' tokens' : '')) + '</p>'
                : ''}
              ${shards.length
                ? '<p class="field-hint" style="margin:0;">Collaborative preprocessing: ' + done + ' of ' + shards.length +
                    ' shards complete · ' + tokens.toLocaleString() + ' tokens counted by devices</p>'
                : ''}
              ${tasks.length
                ? '<ul class="device-task-list">' + tasks.map((task) => '<li>' +
                    '<span class="mono">' + esc(task.device_name || task.device_id) + '</span> · ' + esc(task.kind) +
                    ' · ' + esc(task.status) + ' · ' + esc(task.progress_percent == null ? 'no progress reported' : task.progress_percent + '%') +
                    '</li>').join('') + '</ul>'
                : ''}
              <button class="btn btn-ghost btn-sm" type="button" onclick="devices.loadJobTasks('${esc(job.id)}').then(function(){devices.renderJobsPanel();})">
                <i class="fas fa-list-check"></i> Device details
              </button>
            </div>
          `;
        }).join('')}
      </section>
    `;
  }

  function setGpuMode(value) {
    const a = agent();
    if (!a) return;
    a.setSettings({ gpuMode: value });
    renderThisDevice();
  }

  function setWorkload(value) {
    const a = agent();
    if (!a) return;
    a.setSettings({ maxWorkload: value });
    renderThisDevice();
  }

  async function refreshAll() {
    const token = await state.getAccessToken();
    if (!token) return;
    await loadData(token);
    if (mounted('#multi-device-root')) {
      renderDeviceList();
      renderPlanPanel();
      renderJobsPanel();
    }
    if (mounted('#device-compute-root')) {
      renderThisDevice();
      renderOtherDevicesSummary();
    }
  }

  /* --------------------------------------------------------------- routing */

  function currentRoute(hint) {
    const candidates = [hint, (window.location.hash || '').replace(/^#\/?/, ''), state.getRoute ? state.getRoute() : ''];
    for (const candidate of candidates) {
      if (candidate === 'multi-device' || candidate === 'device-compute') return candidate;
    }
    return 'device-compute';
  }

  async function render(routeHint) {
    if (currentRoute(routeHint) === 'multi-device') return renderMultiDevice();
    return renderDeviceCompute();
  }

  return {
    render,
    dispose,
    // device compute page
    connectThisDevice,
    measureThisDevice,
    disconnectThisDevice,
    toggleSetting,
    setGpuMode,
    setWorkload,
    // multi-device page
    refresh,
    refreshAll,
    pauseDevice,
    resumeDevice,
    disconnectDevice,
    removeDevice,
    assignFromCard,
    startParallel,
    startCollaborative,
    loadJobTasks,
    renderJobsPanel,
    renderDeviceList,
    // diagnostics for tests
    _state: () => ({ devices: devicesCache, jobs: jobsCache, tasksByJob: tasksByJob, paused: agentPaused, notice: lastNotice }),
    _progressBar: progressBar,
  };
})();
