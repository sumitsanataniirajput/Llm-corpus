/* ========================================
   CORPUS ULTIMATE — Device agent

   Turns this browser into a real, measurable training device:

     detect()      real capability detection (CPU, GPU/WebGPU, memory, battery,
                   network, platform, native bridge) with "Not available" for
                   anything the browser does not expose
     register()    registers the device with the backend and keeps its id in
                   localStorage so a reload reuses the same registration
     heartbeat()   keeps the lease alive; a closed tab stops heartbeating and
                   the backend releases the work to another device
     executeTask() the only device-side compute that is actually implemented:
                   dataset *preprocessing* (tokenizing and counting a shard) in
                   a real Web Worker so the UI never freezes

   What this file deliberately does NOT do: pretend to train a neural network.
   Gradient training still runs in the backend worker; the plan response and the
   UI both say so. Every number reported here was counted or timed on this
   device.
   ======================================== */

window.CORPUS_DEVICE_AGENT = (function () {
  'use strict';

  const DEVICE_ID_KEY = 'corpus.device.id';
  const SETTINGS_KEY = 'corpus.device.settings';
  const HEARTBEAT_MS = 25000;
  const WORKER_TIMEOUT_MS = 120000;

  const DEFAULT_SETTINGS = {
    deviceProcessing: true,      // allow this device to do work at all
    gpuMode: 'auto',             // 'auto' | 'on' | 'off'
    cpuFallback: true,           // use CPU workers when WebGPU is unavailable
    backgroundWork: false,       // only while the tab is visible/open
    wifiOnly: false,             // skip work on metered/cellular connections
    preferCharging: false,       // skip heavy work on battery
    pauseOnMemoryPressure: true, // stop when the device reports low memory
    maxWorkload: 'medium',       // 'low' | 'medium' | 'high' -> chunk size
    allowCollaborative: true,    // may take a shard of a shared dataset
  };

  const WORKLOAD_CHUNKS = { low: 65536, medium: 200000, high: 200000 };

  let device = null;
  let lastHeartbeatAt = null;
  let heartbeatTimer = null;
  let taskLoopTimer = null;
  let worker = null;
  let workerStatus = 'idle';        // idle | busy | error | unsupported
  let currentTask = null;
  let currentProgress = null;
  let lastError = null;
  let benchmarkResult = null;
  let capabilities = null;
  let listeners = [];
  let running = false;

  function emit(event, payload) {
    listeners.forEach((listener) => {
      try { listener(event, payload); } catch (e) { /* a listener must never break the agent */ }
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return function () {};
    listeners.push(listener);
    return function unsubscribe() {
      listeners = listeners.filter((item) => item !== listener);
    };
  }

  /* ------------------------------------------------------------- settings */

  function getSettings() {
    let stored = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    } catch (e) {
      stored = {};
    }
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  }

  function setSettings(patch) {
    const next = Object.assign(getSettings(), patch || {});
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (e) { /* private mode: settings stay in memory for this page load */ }
    emit('settings', next);
    return next;
  }

  /* --------------------------------------------------- capability detection */

  function na(value) {
    return value === undefined || value === null || value === '' ? 'Not available' : value;
  }

  function detectDeviceType(nav, screenInfo) {
    const uaData = nav.userAgentData;
    if (uaData && typeof uaData.mobile === 'boolean') {
      if (uaData.mobile) {
        const minSide = Math.min(screenInfo.width || 0, screenInfo.height || 0);
        return minSide >= 600 ? 'tablet' : 'mobile';
      }
      return screenInfo.width >= 1280 ? 'desktop' : 'laptop';
    }
    const ua = String(nav.userAgent || '');
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Android|iPhone|Mobile/i.test(ua)) return 'mobile';
    return screenInfo.width >= 1280 ? 'desktop' : 'laptop';
  }

  function detectWasmSimd() {
    if (typeof WebAssembly === 'undefined') return false;
    try {
      // (module (func (result v128) (i32x4.splat (i32.const 1))))
      const bytes = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 1, 253, 11, 253, 98, 11,
      ]);
      return WebAssembly.validate(bytes);
    } catch (e) {
      return false;
    }
  }

  function detectWebglRenderer(doc) {
    try {
      const canvas = doc.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return null;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') || null;
      return String(gl.getParameter(gl.RENDERER) || '') || null;
    } catch (e) {
      return null;
    }
  }

  async function detectWebgpu(nav) {
    if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
      return { supported: false, reason: 'navigator.gpu is not exposed by this browser' };
    }
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) {
        return { supported: false, reason: 'The browser exposes WebGPU but no adapter is available' };
      }
      const limits = adapter.limits || {};
      const info = adapter.info || {};
      const features = adapter.features ? Array.from(adapter.features) : [];
      return {
        supported: true,
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        description: info.description || info.device || null,
        max_buffer_size: typeof limits.maxBufferSize === 'number' ? limits.maxBufferSize : null,
        max_storage_buffer_binding_size:
          typeof limits.maxStorageBufferBindingSize === 'number' ? limits.maxStorageBufferBindingSize : null,
        max_compute_workgroup_size_x:
          typeof limits.maxComputeWorkgroupSizeX === 'number' ? limits.maxComputeWorkgroupSizeX : null,
        max_compute_invocations_per_workgroup:
          typeof limits.maxComputeInvocationsPerWorkgroup === 'number' ? limits.maxComputeInvocationsPerWorkgroup : null,
        features: features.slice(0, 12),
      };
    } catch (err) {
      return { supported: false, reason: (err && err.message) ? err.message : 'requestAdapter failed' };
    }
  }

  function detectNativeBridge(win) {
    // A web page cannot see NNAPI or a native GPU API. It can only see a bridge
    // an Android wrapper deliberately injects; if there is one, report it, and
    // if there is not, say so instead of assuming native acceleration.
    const candidates = ['CorpusNative', 'CorpusAndroid', 'AndroidInterface', 'Android'];
    for (const name of candidates) {
      const bridge = win[name];
      if (bridge && typeof bridge === 'object') {
        const methods = Object.keys(bridge).filter((key) => typeof bridge[key] === 'function').slice(0, 12);
        if (methods.length) {
          return { available: true, name: name, methods: methods };
        }
      }
    }
    return { available: false, name: null, methods: [] };
  }

  async function detectCapabilities(options) {
    const opts = options || {};
    const win = opts.window || window;
    const nav = win.navigator || {};
    const doc = win.document || document;
    const screenInfo = {
      width: (win.screen && win.screen.width) || 0,
      height: (win.screen && win.screen.height) || 0,
      dpr: win.devicePixelRatio || 1,
    };

    let storageQuotaGb = null;
    if (nav.storage && typeof nav.storage.estimate === 'function') {
      try {
        const estimate = await nav.storage.estimate();
        if (estimate && typeof estimate.quota === 'number') {
          storageQuotaGb = Math.round((estimate.quota / 1e9) * 100) / 100;
        }
      } catch (e) { /* stays unknown */ }
    }

    let battery = null;
    if (typeof nav.getBattery === 'function') {
      try {
        const manager = await nav.getBattery();
        battery = {
          level_percent: typeof manager.level === 'number' ? Math.round(manager.level * 100) : null,
          charging: typeof manager.charging === 'boolean' ? manager.charging : null,
        };
      } catch (e) { /* stays unknown */ }
    }

    const connection = nav.connection || nav.mozConnection || nav.webkitConnection || null;
    const webgpu = await detectWebgpu(nav);
    const settings = getSettings();
    const jsHeapLimitMb = (win.performance && win.performance.memory &&
      typeof win.performance.memory.jsHeapSizeLimit === 'number')
      ? Math.round(win.performance.memory.jsHeapSizeLimit / 1048576)
      : null;

    let executionMethod = 'backend';
    if (webgpu.supported && settings.gpuMode !== 'off') executionMethod = 'webgpu';
    else if (settings.cpuFallback) executionMethod = 'cpu-worker';

    capabilities = {
      detected_at: new Date().toISOString(),
      device_type: detectDeviceType(nav, screenInfo),
      platform: (nav.userAgentData && nav.userAgentData.platform) || nav.platform || null,
      user_agent: nav.userAgent || null,
      cpu_cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
      device_memory_gb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      js_heap_limit_mb: jsHeapLimitMb,
      storage_quota_gb: storageQuotaGb,
      screen: screenInfo,
      webgpu: webgpu,
      webgl_renderer: detectWebglRenderer(doc),
      wasm: typeof win.WebAssembly !== 'undefined',
      wasm_simd: detectWasmSimd(),
      hardware_acceleration: webgpu.supported ? 'WebGPU adapter available' : 'Not available',
      execution_method: executionMethod,
      battery: battery,
      connection: connection ? {
        type: connection.effectiveType || null,
        downlink_mbps: typeof connection.downlink === 'number' ? connection.downlink : null,
        save_data: typeof connection.saveData === 'boolean' ? connection.saveData : null,
      } : null,
      native_bridge: detectNativeBridge(win),
      worker_support: typeof win.Worker === 'function',
      visibility_state: doc.visibilityState || null,
    };
    return capabilities;
  }

  /** Human-readable suitability, derived only from detected values. */
  function suitability(caps) {
    const c = caps || capabilities;
    if (!c) return { level: 'unknown', label: 'Not determined yet', reasons: [] };
    const reasons = [];
    if (c.webgpu && c.webgpu.supported) reasons.push('WebGPU adapter detected');
    if (c.wasm_simd) reasons.push('WASM SIMD available');
    if (c.cpu_cores) reasons.push(c.cpu_cores + ' logical cores reported');
    if (c.device_memory_gb) reasons.push(c.device_memory_gb + ' GB device memory reported');
    const lowMemory = typeof c.device_memory_gb === 'number' && c.device_memory_gb < 2;
    if (lowMemory) {
      return {
        level: 'limited',
        label: 'Limited — small dataset shards only',
        reasons: reasons.concat(['Less than 2 GB of device memory is exposed; workloads are capped']),
      };
    }
    if (c.webgpu && c.webgpu.supported) return { level: 'high', label: 'Suitable for GPU-accelerated work', reasons: reasons };
    if (c.cpu_cores && c.cpu_cores >= 4) return { level: 'medium', label: 'Suitable for CPU worker preprocessing', reasons: reasons };
    return { level: 'limited', label: 'Limited — preprocessing only, small chunks', reasons: reasons };
  }

  /** Real, timed measurement of this device's tokenizer throughput. */
  async function runBenchmark() {
    if (workerStatus === 'busy') return benchmarkResult;
    const result = await runInWorker({ type: 'benchmark', chars: 300000 });
    benchmarkResult = {
      characters: result.characters,
      tokens: result.tokens,
      elapsed_ms: result.elapsedMs,
      characters_per_second: result.charactersPerSecond,
      tokens_per_second: result.tokensPerSecond,
      measured_at: new Date().toISOString(),
    };
    emit('benchmark', benchmarkResult);
    return benchmarkResult;
  }

  /* ----------------------------------------------------------- web worker */

  function workerUrl() {
    const cfg = window.CORPUS_CONFIG || {};
    const base = cfg.BUILD_ID ? '?v=' + encodeURIComponent(cfg.BUILD_ID) : '';
    return 'js/device-worker.js' + base;
  }

  function ensureWorker() {
    if (worker) return worker;
    const factory = window.CORPUS_WORKER_FACTORY;
    if (typeof factory === 'function') {
      worker = factory(workerUrl());
    } else if (typeof window.Worker === 'function') {
      worker = new window.Worker(workerUrl());
    } else {
      workerStatus = 'unsupported';
      return null;
    }
    workerStatus = 'idle';
    return worker;
  }

  /**
   * Run one worker job and resolve with its `result` message.
   * Progress messages are forwarded to `onProgress` without blocking the caller.
   */
  function runInWorker(payload, onProgress) {
    const instance = ensureWorker();
    if (!instance) {
      return Promise.reject(new Error('Web Workers are not available in this browser, so device compute is disabled.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      workerStatus = 'busy';
      const timer = setTimeout(() => finish(new Error('The device worker did not answer within ' +
        Math.round(WORKER_TIMEOUT_MS / 1000) + ' s.')), WORKER_TIMEOUT_MS);

      function cleanup() {
        clearTimeout(timer);
        instance.onmessage = null;
        instance.onerror = null;
        workerStatus = 'idle';
      }

      function finish(err, value) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          workerStatus = 'error';
          lastError = err.message || String(err);
          emit('worker-error', { message: lastError });
          reject(err);
        } else {
          resolve(value);
        }
      }

      instance.onmessage = (event) => {
        const message = event && event.data ? event.data : {};
        if (message.type === 'progress') {
          if (typeof onProgress === 'function') onProgress(message);
        } else if (message.type === 'result' || message.type === 'benchmark') {
          finish(null, message);
        } else if (message.type === 'error') {
          finish(new Error(message.message || 'The device worker reported an error.'));
        }
      };
      instance.onerror = (event) => {
        finish(new Error((event && event.message) ? event.message : 'The device worker crashed.'));
      };
      try {
        instance.postMessage(payload);
      } catch (err) {
        finish(err);
      }
    });
  }

  /* -------------------------------------------------------- policy checks */

  function policyBlock(caps) {
    const settings = getSettings();
    const c = caps || capabilities || {};
    if (!settings.deviceProcessing) return 'Device processing is turned off on this device.';
    if (!settings.allowCollaborative && currentTask && currentTask.kind === 'preprocess') {
      return 'Collaborative preprocessing is turned off on this device.';
    }
    if (settings.wifiOnly) {
      const type = c.connection && c.connection.type;
      if (type && type !== 'wifi' && type !== 'ethernet' && type !== '4g' && type !== '5g') {
        return 'Wi-Fi only is enabled and this connection reports "' + type + '".';
      }
    }
    if (settings.preferCharging && c.battery && c.battery.charging === false) {
      return 'Prefer charging is enabled and this device is running on battery.';
    }
    return null;
  }

  function chunkChars() {
    const settings = getSettings();
    const caps = capabilities || {};
    let size = WORKLOAD_CHUNKS[settings.maxWorkload] || WORKLOAD_CHUNKS.medium;
    // Never ask more of a device than the memory it reports.
    const memoryGb = typeof caps.device_memory_gb === 'number' ? caps.device_memory_gb : null;
    if (memoryGb !== null && memoryGb < 2) size = Math.min(size, WORKLOAD_CHUNKS.low);
    return size;
  }

  /* ------------------------------------------------------------ task work */

  async function executePreprocess(task) {
    const token = await state.getAccessToken();
    if (!token) throw new Error('Sign in to run device work.');
    const job = (device && device.job) || {};
    const datasetId = task.dataset_id || job.dataset_id;
    if (!datasetId) throw new Error('This task has no dataset to preprocess.');

    const shardIndex = Number(task.shard_index || 0);
    const shardCount = Math.max(1, Number(task.shard_count || 1));

    const probe = await window.CORPUS_API.datasetTextRange(datasetId, token, { offset: 0, limit: 1 });
    const total = Number(probe.total_characters || 0);
    if (!total) throw new Error('The dataset file is empty, so there is nothing to tokenize.');

    const start = Math.floor((total * shardIndex) / shardCount);
    const end = Math.floor((total * (shardIndex + 1)) / shardCount);
    const span = Math.max(1, end - start);
    const limit = Math.min(200000, chunkChars());

    let offset = start;
    let tokens = 0;
    let characters = 0;
    const startedAt = Date.now();

    while (offset < end) {
      const page = await window.CORPUS_API.datasetTextRange(datasetId, token, {
        offset: offset,
        limit: Math.min(limit, end - offset),
      });
      const text = typeof page.text === 'string' ? page.text : '';
      if (!text.length) break;

      const result = await runInWorker({ type: 'tokenize', text: text, chunkChars: Math.min(limit, 200000) },
        (progress) => {
          const done = offset + (progress.processedChars || 0);
          const percent = Math.max(0, Math.min(100, ((done - start) / span) * 100));
          currentProgress = percent;
          emit('task-progress', { taskId: task.id, percent: percent, tokens: tokens + (progress.tokens || 0) });
        });

      tokens += Number(result.tokens || 0);
      characters += text.length;
      offset += text.length;

      const percent = Math.max(0, Math.min(100, ((offset - start) / span) * 100));
      currentProgress = percent;
      await window.CORPUS_API.reportDeviceTaskProgress(device.id, task.id, {
        progress_percent: Math.round(percent * 10) / 10,
        detail: { tokens_so_far: tokens, characters_so_far: characters },
      }, token);
      emit('task-progress', { taskId: task.id, percent: percent, tokens: tokens });
    }

    const finished = await window.CORPUS_API.completeDeviceTask(device.id, task.id, {
      status: 'completed',
      detail: {
        token_count: tokens,
        characters: characters,
        shard_index: shardIndex,
        shard_count: shardCount,
        elapsed_ms: Date.now() - startedAt,
        execution_method: (capabilities && capabilities.execution_method) || 'cpu-worker',
      },
    }, token);
    currentProgress = 100;
    emit('task-complete', { task: finished.task, aggregate: finished.aggregate, tokens: tokens });
    return finished;
  }

  async function failTask(task, error) {
    const token = await state.getAccessToken();
    lastError = (error && error.message) ? error.message : String(error);
    emit('task-failed', { taskId: task && task.id, message: lastError });
    if (!device || !task || !token) return null;
    try {
      return await window.CORPUS_API.completeDeviceTask(device.id, task.id, {
        status: 'failed',
        detail: { error: lastError, execution_method: (capabilities && capabilities.execution_method) || 'cpu-worker' },
      }, token);
    } catch (e) {
      return null;
    }
  }

  async function executeTask(task) {
    if (!task) return null;
    currentTask = task;
    currentProgress = 0;
    emit('task-start', { task: task });

    if (task.kind !== 'preprocess') {
      // Training itself runs in the backend worker. Saying otherwise would be a
      // false claim of device-side training, so this is reported, not faked.
      emit('task-skipped', {
        task: task,
        reason: 'Model training runs in the backend worker; this device keeps the assignment and streams its progress.',
      });
      return null;
    }

    const blocked = policyBlock(capabilities);
    if (blocked) {
      emit('task-skipped', { task: task, reason: blocked });
      return null;
    }

    try {
      const result = await executePreprocess(task);
      currentTask = null;
      return result;
    } catch (err) {
      await failTask(task, err);
      currentTask = null;
      return null;
    }
  }

  /* ---------------------------------------------------- registration loop */

  async function heartbeatOnce() {
    if (!device) return null;
    const token = await state.getAccessToken();
    if (!token) return null;
    const settings = getSettings();
    const payload = {
      capabilities: capabilities || undefined,
      status: settings.deviceProcessing ? (currentTask ? 'busy' : 'online') : 'paused',
    };
    if (currentTask && currentProgress !== null) {
      payload.task_id = currentTask.id;
      payload.progress_percent = Math.round(currentProgress * 10) / 10;
    }
    const updated = await window.CORPUS_API.deviceHeartbeat(device.id, payload, token);
    device = updated;
    lastHeartbeatAt = Date.now();
    emit('heartbeat', updated);
    return updated;
  }

  function startLoops() {
    stopLoops();
    running = true;
    heartbeatTimer = setInterval(() => {
      heartbeatOnce().catch((err) => {
        lastError = err.message || String(err);
        emit('heartbeat-error', { message: lastError });
      });
    }, HEARTBEAT_MS);
    // The heartbeat response carries the current task, so polling it is also
    // how a device discovers work assigned from another device's dashboard.
    taskLoopTimer = setInterval(() => {
      if (currentTask || workerStatus === 'busy') return;
      const task = device && device.task;
      if (task && task.status !== 'expired') executeTask(task);
    }, 5000);
  }

  function stopLoops() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (taskLoopTimer) clearInterval(taskLoopTimer);
    heartbeatTimer = null;
    taskLoopTimer = null;
    running = false;
  }

  /** Register this browser (once per browser) and start heartbeating. */
  async function start(options) {
    const opts = options || {};
    const token = await state.getAccessToken();
    if (!token) throw new Error('Sign in to connect a device.');

    capabilities = await detectCapabilities(opts);
    const listing = await window.CORPUS_API.listDevices(token);
    const known = Array.isArray(listing && listing.devices) ? listing.devices : [];
    let existingId = null;
    try {
      existingId = window.localStorage.getItem(DEVICE_ID_KEY);
    } catch (e) {
      existingId = null;
    }

    let mine = existingId ? known.find((item) => item.id === existingId) : null;
    if (!mine && opts.claimId) mine = known.find((item) => item.id === opts.claimId) || null;

    if (!mine) {
      mine = await window.CORPUS_API.registerDevice({
        name: opts.name || defaultDeviceName(capabilities),
        device_type: capabilities.device_type,
        platform: capabilities.platform || capabilities.user_agent || null,
        capabilities: publicCapabilities(capabilities),
      }, token);
    } else {
      mine = await window.CORPUS_API.deviceHeartbeat(mine.id, {
        status: currentTask ? 'busy' : 'online',
        capabilities: publicCapabilities(capabilities),
      }, token);
    }

    try {
      window.localStorage.setItem(DEVICE_ID_KEY, mine.id);
    } catch (e) { /* ignore storage failures */ }

    device = mine;
    lastHeartbeatAt = Date.now();
    emit('registered', mine);
    if (opts.autoStart !== false) startLoops();
    return mine;
  }

  function defaultDeviceName(caps) {
    const type = caps.device_type ? caps.device_type.charAt(0).toUpperCase() + caps.device_type.slice(1) : 'Device';
    const platform = caps.platform || 'browser';
    return (type + ' · ' + platform).slice(0, 80);
  }

  /** Only capability data goes to the server — never tokens or credentials. */
  function publicCapabilities(caps) {
    if (!caps) return {};
    return {
      device_type: caps.device_type,
      platform: caps.platform,
      cpu_cores: caps.cpu_cores,
      device_memory_gb: caps.device_memory_gb,
      js_heap_limit_mb: caps.js_heap_limit_mb,
      webgpu: !!(caps.webgpu && caps.webgpu.supported),
      webgpu_vendor: caps.webgpu && caps.webgpu.vendor,
      webgpu_limits: caps.webgpu && caps.webgpu.supported ? {
        max_buffer_size: caps.webgpu.max_buffer_size,
        max_storage_buffer_binding_size: caps.webgpu.max_storage_buffer_binding_size,
        max_compute_invocations_per_workgroup: caps.webgpu.max_compute_invocations_per_workgroup,
      } : null,
      webgl_renderer: caps.webgl_renderer,
      wasm: caps.wasm,
      wasm_simd: caps.wasm_simd,
      execution_method: caps.execution_method,
      worker_support: caps.worker_support,
      connection_type: caps.connection ? caps.connection.type : null,
      battery_percent: caps.battery ? caps.battery.level_percent : null,
      battery_charging: caps.battery ? caps.battery.charging : null,
      native_bridge: !!(caps.native_bridge && caps.native_bridge.available),
      measured: benchmarkResult ? {
        tokens_per_second: benchmarkResult.tokens_per_second,
        characters_per_second: benchmarkResult.characters_per_second,
        measured_at: benchmarkResult.measured_at,
      } : null,
      detected_at: caps.detected_at,
    };
  }

  async function disconnect() {
    stopLoops();
    if (!device) return null;
    const token = await state.getAccessToken();
    if (!token) return null;
    const result = await window.CORPUS_API.disconnectDevice(device.id, token);
    emit('disconnected', result);
    return result;
  }

  function stop() {
    stopLoops();
    if (worker) {
      try { worker.terminate(); } catch (e) { /* ignore */ }
      worker = null;
      workerStatus = 'idle';
    }
  }

  function status() {
    return {
      device: device,
      deviceId: device ? device.id : null,
      running: running,
      heartbeatAt: lastHeartbeatAt,
      worker: workerStatus,
      task: currentTask,
      progress: currentProgress,
      capabilities: capabilities,
      settings: getSettings(),
      benchmark: benchmarkResult,
      lastError: lastError,
      suitability: suitability(capabilities),
    };
  }

  return {
    detectCapabilities,
    detect: detectCapabilities,
    publicCapabilities,
    suitability,
    runBenchmark,
    start,
    stop,
    disconnect,
    heartbeatOnce,
    executeTask,
    getSettings,
    setSettings,
    status,
    subscribe,
    na,
    chunkChars,
    // exposed for tests
    _runInWorker: runInWorker,
    _countTokensForTest: null,
  };
})();
