/* ========================================
   CORPUS ULTIMATE — API client (REST + WebSocket)
   ======================================== */

window.CORPUS_API = (function () {
  let ws = null;
  let wsCallbacks = {};
  let wsReconnectAttempts = 0;
  let wsReconnectTimer = null;
  let messageHandlers = {};

  const BASE = window.CORPUS_CONFIG.API_BASE_URL;

  // Backend-unavailable guard: once a network error occurs, skip subsequent
  // protected requests for a short window to avoid repeated "Failed to fetch"
  // spam and unnecessary token resolution attempts.
  let backendUnavailable = false;
  let backendUnavailableUntil = 0;
  const BACKEND_UNAVAILABLE_WINDOW_MS = 30000;

  function isBackendUnavailable() {
    return backendUnavailable && Date.now() < backendUnavailableUntil;
  }

  function setBackendUnavailable(untilMs) {
    backendUnavailable = true;
    backendUnavailableUntil = Date.now() + untilMs;
    state.setConnection('disconnected');
  }

  function clearBackendUnavailable() {
    backendUnavailable = false;
    backendUnavailableUntil = 0;
    state.setConnection('connected');
  }

  let tokenRefreshInProgress = false;
  let tokenRefreshPromise = null;

  function headers(token) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  // Obtain a fresh Supabase access token, deduplicating concurrent refresh attempts.
  async function resolveToken(optionsToken) {
    if (optionsToken) return optionsToken;
    try {
      const token = await state.getAccessToken();
      return token;
    } catch (e) {
      return null;
    }
  }

  async function refreshSession() {
    if (tokenRefreshInProgress) return tokenRefreshPromise;
    tokenRefreshInProgress = true;
    tokenRefreshPromise = (async () => {
      try {
        const { data } = await window.CORPUS_SUPABASE.getSession();
        if (data && data.session && data.session.access_token) {
          return data.session.access_token;
        }
      } catch (e) {
        // Session refresh failed
      }
      return null;
    })();
    const result = await tokenRefreshPromise;
    tokenRefreshInProgress = false;
    tokenRefreshPromise = null;
    return result;
  }

  /** Current Supabase access token, or null when there is no session. */
  async function currentSupabaseToken() {
    try {
      const { data } = await window.CORPUS_SUPABASE.getSession();
      return (data && data.session && data.session.access_token) || null;
    } catch (e) {
      return null;
    }
  }

  function authError(message, extra = {}) {
    const err = new Error(message);
    err.status = 401;
    err.data = { message };
    Object.assign(err, extra);
    // Keep the machine-readable flags on err.data too: callers and tests use
    // both shapes, and older code reads err.data.message.
    if (extra.sessionExpired) err.data.sessionExpired = true;
    if (extra.backendAuthError) err.data.backendError = true;
    return err;
  }

  /** Parse a fetch Response, throwing a descriptive Error for non-2xx. */
  async function finishResponse(res) {
    let data;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      let msg = null;
      if (data && typeof data === 'object') {
        if (typeof data.message === 'string' && data.message) msg = data.message;
        else if (typeof data.detail === 'string' && data.detail) msg = data.detail;
        else if (Array.isArray(data.detail)) msg = data.detail.map(d => (d && d.msg) || String(d)).join(' ');
        else if (data.detail && typeof data.detail === 'object') {
          msg = data.detail.message || (Array.isArray(data.detail.errors) ? data.detail.errors.join(' ') : JSON.stringify(data.detail));
        }
      }
      const err = new Error(msg || 'Request failed (' + res.status + ')');
      err.status = res.status;
      err.data = data;
      err.networkError = false;
      throw err;
    }
    return data;
  }

  async function request(endpoint, options = {}) {
    // Skip protected requests if backend is known to be unavailable
    // (avoids repeated "Failed to fetch" spam and unnecessary token resolution)
    if (isBackendUnavailable() && endpoint !== '/api/v1/health') {
      const err = new Error('Backend is currently unavailable. Please check Settings → Backend Connectivity and retry.');
      err.status = 0;
      err.code = 'BACKEND_UNAVAILABLE';
      err.networkError = true;
      err.backendUrl = BASE;
      throw err;
    }

    const url = BASE + endpoint;
    const token = await resolveToken(options.token);
    const mergedHeaders = { ...headers(token), ...(options.headers || {}) };
    const opts = {
      ...options,
      method: options.method || 'GET',
      headers: mergedHeaders,
    };
    if (options.body && typeof options.body !== 'string') {
      opts.body = JSON.stringify(options.body);
      opts.headers['Content-Type'] = 'application/json';
    }

    // Abort controller for request timeout
    const timeoutMs = options.timeout || window.CORPUS_CONFIG.REQUEST_TIMEOUT || 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const fetchOpts = { ...opts, signal: controller.signal };

    let res;
    try {
      res = await fetch(url, fetchOpts);
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      // Mark backend as unavailable to prevent repeated failed requests
      setBackendUnavailable(BACKEND_UNAVAILABLE_WINDOW_MS);

      // Distinguish network errors from HTTP errors
      if (fetchErr.name === 'AbortError') {
        const err = new Error('Request timed out after ' + timeoutMs + 'ms. Check your backend URL and network connection.');
        err.status = 0;
        err.code = 'TIMEOUT';
        err.networkError = true;
        throw err;
      }
      // Network error (DNS failure, connection refused, CORS, etc.)
      const err = new Error('Network error: cannot reach backend at ' + BASE + '. ' +
        (fetchErr.message || 'Check your API_BASE_URL in frontend/js/config.js.'));
      err.status = 0;
      err.code = 'NETWORK_ERROR';
      err.networkError = true;
      err.backendUrl = BASE;
      throw err;
    }
    clearTimeout(timeoutId);

    // Successful response — clear the backend-unavailable flag
    clearBackendUnavailable();

    // Handle 401.
    //
    // A 401 from the API does NOT mean "the user is signed out": it means the
    // backend could not validate this particular token. That happens when
    //   * the access token expired mid-request (refreshable), or
    //   * the backend verifies tokens against a different Supabase project /
    //     is missing its public key (config problem, session still valid).
    //
    // The old code threw the "backend misconfigured" error from *inside* the
    // try block that was meant to detect it, so its own catch ran and wiped the
    // session — the user was bounced to the login screen while their Supabase
    // session was perfectly valid. That is the "logged out after upload /
    // refresh" bug. Everything below keeps the session unless Supabase itself
    // says there is none.
    if (res.status === 401) {
      const sessionToken = await currentSupabaseToken();

      if (!sessionToken) {
        // No Supabase session at all: this really is a signed-out request.
        if (state.getUser()) state.clearUser();
        throw authError('Your session has ended. Please sign in again.', { sessionExpired: true });
      }

      // Refresh and retry once. Only idempotent methods are retried so a POST
      // can never be applied twice.
      const canRetry = options.method !== 'POST' && options.method !== 'PUT';
      if (canRetry && token) {
        const refreshed = await refreshSession();
        if (refreshed && refreshed !== token) {
          const retryOpts = {
            ...options,
            method: options.method || 'GET',
            headers: { ...headers(refreshed), ...(options.headers || {}) },
          };
          if (options.body && typeof options.body !== 'string') {
            retryOpts.body = JSON.stringify(options.body);
            retryOpts.headers['Content-Type'] = 'application/json';
          }
          res = await fetch(url, { ...retryOpts, signal: controller.signal });
          if (res.status !== 401) {
            return finishResponse(res);
          }
        }
      }

      // Still 401 while Supabase holds a valid session: the backend rejected a
      // live token. Keep the user signed in and report the real problem.
      throw authError(
        'The backend rejected your session (401) even though you are signed in. ' +
        'Your sign-in is still valid — the API is probably missing SUPABASE_URL / ' +
        'SUPABASE_PUBLISHABLE_KEY or is verifying tokens for a different Supabase project.',
        { backendAuthError: true }
      );
    }

    return finishResponse(res);
  }

  // ---------- Backend health check ----------
  async function healthCheck() {
    const url = BASE + '/api/v1/health';
    const timeoutMs = window.CORPUS_CONFIG.REQUEST_TIMEOUT || 10000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return { ok: true, status: res.status, data: data };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, data: data, httpError: true };
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return { ok: false, status: 0, code: 'TIMEOUT', networkError: true, message: 'Backend health check timed out.' };
      }
      return {
        ok: false,
        status: 0,
        code: 'NETWORK_ERROR',
        networkError: true,
        message: 'Cannot reach backend at ' + BASE + '. ' + (fetchErr.message || 'Check your API_BASE_URL.'),
        backendUrl: BASE,
      };
    }
  }

  // ---------- Auth ----------
  async function me(token) {
    return request('/api/v1/auth/me', { token });
  }

  async function verifySession(token) {
    return request('/api/v1/auth/verify', { token });
  }

  // ---------- Models ----------
  async function listModels(token) {
    return request('/api/v1/models/', { token });
  }

  async function getModel(modelId, token) {
    return request('/api/v1/models/' + encodeURIComponent(modelId), { token });
  }

  async function createModel(config, token) {
    return request('/api/v1/models/', { method: 'POST', token, body: config });
  }

  async function updateModel(modelId, updates, token) {
    return request('/api/v1/models/' + encodeURIComponent(modelId), { method: 'PUT', token, body: updates });
  }

  async function deleteModel(modelId, token, options = {}) {
    const qs = options && options.stopActive ? '?stop_active=true' : '';
    return request('/api/v1/models/' + encodeURIComponent(modelId) + qs, { method: 'DELETE', token });
  }

  async function cloneModel(modelId, token) {
    return request('/api/v1/models/' + encodeURIComponent(modelId) + '/clone', { method: 'POST', token });
  }

  async function validateConfig(config, token) {
    return request('/api/v1/models/validate', { method: 'POST', token, body: config });
  }

  async function listModelVersions(modelId, token) {
    return request('/api/v1/models/' + encodeURIComponent(modelId) + '/versions', { token });
  }

  async function exportModel(modelId, version, token) {
    return request('/api/v1/models/' + encodeURIComponent(modelId) + '/export?version=' + encodeURIComponent(version), { token });
  }

  // ---------- Datasets ----------
  async function listDatasets(token) {
    return request('/api/v1/datasets/', { token });
  }

  async function getDataset(datasetId, token) {
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId), { token });
  }

  async function createDataset(data, token) {
    return request('/api/v1/datasets/', { method: 'POST', token, body: data });
  }

  async function updateDataset(datasetId, updates, token) {
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId), { method: 'PUT', token, body: updates });
  }

  async function deleteDataset(datasetId, token) {
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId), { method: 'DELETE', token });
  }

  // Dataset bytes are far larger than a JSON request, so uploads get their own
  // timeout and their own 401 handling:
  //   * the XHR is given an explicit timeout (a stalled mobile connection used
  //     to hang forever with no feedback),
  //   * a 401 refreshes the Supabase session and retries once — long uploads
  //     regularly outlive one access token — without ever creating a second
  //     dataset record (the dataset id is created before the upload starts).
  function uploadTimeoutMs() {
    const configured = window.CORPUS_CONFIG.UPLOAD_TIMEOUT_MS;
    return typeof configured === 'number' && configured > 0 ? configured : 600000; // 10 min
  }

  function uploadUrl(datasetId) {
    return BASE + '/api/v1/datasets/' + encodeURIComponent(datasetId) + '/upload';
  }

  function parseUploadFailure(status, payload) {
    let detail = payload;
    if (payload && typeof payload === 'object') {
      detail = payload.message || payload.detail;
    }
    let message = typeof detail === 'string' && detail ? detail : 'Upload failed (HTTP ' + status + ')';
    if (status === 401) {
      message = 'The upload was rejected (401). Your sign-in is still active — ' +
        'the backend could not verify the access token. Retry, and if it keeps failing ' +
        'check the backend SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY.';
    } else if (status === 413) {
      message = 'This file is larger than the backend upload limit. Compress or split it, then retry.';
    } else if (status === 503) {
      message = 'The backend cannot store files right now: ' + message;
    } else if (status === 0) {
      message = 'Upload interrupted by a network error. Your dataset record is kept — press Upload again to resume.';
    }
    const err = new Error(message);
    err.status = status || 0;
    err.data = payload;
    return err;
  }

  /** One upload attempt over XHR, reporting real byte progress. */
  function uploadOnce(datasetId, file, token, onProgress) {
    return new Promise((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') {
        // No XHR (very old engines): fall back to fetch, no progress events.
        const formData = new FormData();
        formData.append('file', file);
        fetch(uploadUrl(datasetId), {
          method: 'POST',
          headers: token ? { Authorization: 'Bearer ' + token } : {},
          body: formData,
        }).then(async (res) => {
          const ct = res.headers.get('content-type') || '';
          const payload = ct.includes('application/json') ? await res.json() : await res.text();
          if (!res.ok) {
            reject(parseUploadFailure(res.status, payload));
            return;
          }
          resolve(payload);
        }).catch((err) => {
          const wrapped = new Error('Upload interrupted by a network error: ' + (err.message || err));
          wrapped.status = 0;
          wrapped.networkError = true;
          reject(wrapped);
        });
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl(datasetId), true);
      xhr.timeout = uploadTimeoutMs();
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.upload.onprogress = (event) => {
        if (!onProgress) return;
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        } else {
          onProgress(null);
        }
      };
      xhr.onload = () => {
        let payload = null;
        const ct = xhr.getResponseHeader('content-type') || '';
        try {
          payload = ct.indexOf('application/json') !== -1 ? JSON.parse(xhr.responseText) : xhr.responseText;
        } catch (e) {
          payload = xhr.responseText;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress(100);
          resolve(payload);
          return;
        }
        reject(parseUploadFailure(xhr.status, payload));
      };
      xhr.onerror = () => {
        const err = new Error('Upload interrupted — the network connection dropped. Press Upload again to resume; the dataset record is kept.');
        err.status = 0;
        err.networkError = true;
        reject(err);
      };
      xhr.ontimeout = () => {
        const err = new Error('Upload timed out after ' + Math.round(uploadTimeoutMs() / 1000) + 's. Try again on a stronger connection — the dataset record is kept.');
        err.status = 0;
        err.code = 'TIMEOUT';
        reject(err);
      };
      const formData = new FormData();
      formData.append('file', file);
      xhr.send(formData);
    });
  }

  async function uploadDatasetFile(datasetId, file, token) {
    const resolvedToken = token || (await state.getAccessToken());
    try {
      return await uploadOnce(datasetId, file, resolvedToken, null);
    } catch (err) {
      if (err && err.status === 401) {
        const refreshed = await refreshSession();
        if (refreshed) return uploadOnce(datasetId, file, refreshed, null);
        throw authError(
          'The upload was rejected (401) and the session could not be refreshed. ' +
          'Sign in again, then retry — the dataset record is kept.',
          { sessionExpired: true }
        );
      }
      throw err;
    }
  }

  // Upload a dataset file with real progress reporting (XHR upload events).
  // Resolves with the parsed response body, rejects with an Error carrying
  // `status` just like the fetch-based helpers above.
  async function uploadDatasetFileWithProgress(datasetId, file, token, onProgress) {
    const resolvedToken = token || (await state.getAccessToken());
    try {
      return await uploadOnce(datasetId, file, resolvedToken, onProgress);
    } catch (err) {
      if (err && err.status === 401) {
        // Long uploads outlive a short-lived access token: refresh once and
        // retry the same dataset id. No second dataset record is created.
        const refreshed = await refreshSession();
        if (refreshed) {
          if (onProgress) onProgress(0);
          return uploadOnce(datasetId, file, refreshed, onProgress);
        }
        throw authError(
          'The upload was rejected (401) and the session could not be refreshed. ' +
          'Sign in again, then press Upload — the dataset record is kept.',
          { sessionExpired: true }
        );
      }
      throw err;
    }
  }

  async function previewDataset(datasetId, token, maxChars = 2000) {
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId) + '/preview?max_chars=' + encodeURIComponent(maxChars), { token });
  }

  async function preprocessDataset(datasetId, config, token) {
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId) + '/preprocess', { method: 'POST', token, body: config });
  }

  async function splitDataset(datasetId, config, token) {
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId) + '/split', { method: 'POST', token, body: config });
  }

  // ---------- Training ----------
  async function listTrainingJobs(token) {
    return request('/api/v1/training/', { token });
  }

  async function createTrainingJob(config, token) {
    return request('/api/v1/training/', { method: 'POST', token, body: config });
  }

  async function getTrainingJob(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId), { token });
  }

  async function pauseTrainingJob(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/pause', { method: 'POST', token });
  }

  async function resumeTrainingJob(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/resume', { method: 'POST', token });
  }

  async function stopTrainingJob(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/stop', { method: 'POST', token });
  }

  async function listTrainingMetrics(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/metrics', { token });
  }

  async function listTrainingLogs(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/logs', { token });
  }

  async function listCheckpoints(modelId, token) {
    return request('/api/v1/training/checkpoints?model_id=' + encodeURIComponent(modelId), { token });
  }

  // Every checkpoint owned by the caller (no model filter).
  async function listAllCheckpoints(token) {
    return request('/api/v1/training/checkpoints', { token });
  }

  async function saveCheckpoint(modelId, config, token) {
    return request('/api/v1/training/checkpoints', { method: 'POST', token, body: { model_id: modelId, ...config } });
  }

  async function loadCheckpoint(checkpointId, token) {
    return request('/api/v1/training/checkpoints/' + encodeURIComponent(checkpointId) + '/load', { method: 'POST', token });
  }

  // ---------- Inference ----------
  async function infer(modelId, payload, token) {
    return request('/api/v1/inference/' + encodeURIComponent(modelId), { method: 'POST', token, body: payload });
  }

  async function inferStream(modelId, payload, onMessage, onError, onClose, token) {
    const resolvedToken = token || (await state.getAccessToken());
    const url = BASE + '/api/v1/inference/' + encodeURIComponent(modelId) + '/stream';
    const socket = new WebSocket(url.replace('http', 'ws') + '?token=' + encodeURIComponent(resolvedToken));
    socket.onopen = () => {
      socket.send(JSON.stringify(payload));
    };
    socket.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (onMessage) onMessage(data);
    };
    socket.onerror = (ev) => { if (onError) onError(ev); };
    socket.onclose = (ev) => { if (onClose) onClose(ev); };
    return socket;
  }

  async function tokenize(modelId, text, token) {
    return request('/api/v1/tokenize/' + encodeURIComponent(modelId), { method: 'POST', token, body: { text } });
  }

  async function nextToken(modelId, payload, token) {
    return request('/api/v1/predict/' + encodeURIComponent(modelId), { method: 'POST', token, body: payload });
  }

  // ---------- Evaluation ----------
  async function listEvaluations(token) {
    return request('/api/v1/evaluation/', { token });
  }

  async function runEvaluation(config, token) {
    return request('/api/v1/evaluation/run', { method: 'POST', token, body: config });
  }

  async function getEvaluation(evalId, token) {
    return request('/api/v1/evaluation/' + encodeURIComponent(evalId), { token });
  }

  // ---------- Experiments ----------
  async function listExperiments(token) {
    return request('/api/v1/experiments/', { token });
  }

  async function createExperiment(data, token) {
    return request('/api/v1/experiments/', { method: 'POST', token, body: data });
  }

  // ---------- Compute / Workers ----------
  async function listWorkers(token) {
    return request('/api/v1/compute/workers', { token });
  }

  async function registerWorker(data, token) {
    return request('/api/v1/compute/workers/register', { method: 'POST', token, body: data });
  }

  async function workerHeartbeat(workerId, data, token) {
    return request('/api/v1/compute/workers/' + encodeURIComponent(workerId) + '/heartbeat', { method: 'POST', token, body: data });
  }

  // ---------- Storage ----------
  async function listStorageObjects(token) {
    return request('/api/v1/storage/objects', { token });
  }

  async function getStorageObject(objectId, token) {
    return request('/api/v1/storage/objects/' + encodeURIComponent(objectId), { token });
  }

  async function downloadStorageObject(objectId, token) {
    return request('/api/v1/storage/objects/' + encodeURIComponent(objectId) + '/download', { token });
  }

  // ---------- Settings ----------
  async function getSettings(token) {
    return request('/api/v1/settings/', { token });
  }

  async function updateSettings(data, token) {
    return request('/api/v1/settings/', { method: 'PUT', token, body: data });
  }

  async function listApiKeys(token) {
    return request('/api/v1/settings/api-keys', { token });
  }

  async function createApiKey(data, token) {
    return request('/api/v1/settings/api-keys', { method: 'POST', token, body: data });
  }

  async function revokeApiKey(keyId, token) {
    return request('/api/v1/settings/api-keys/' + encodeURIComponent(keyId), { method: 'DELETE', token });
  }

  // ---------- Health ----------
  async function health() {
    return healthCheck();
  }

  // ---------- WebSocket ----------
  async function connectWS(token, onConnect, onDisconnect) {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const resolvedToken = token || (await state.getAccessToken()) || '';
    const wsUrl = (BASE.replace('http', 'ws') + '/api/v1/ws?token=' + encodeURIComponent(resolvedToken));
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      wsReconnectAttempts = 0;
      if (onConnect) onConnect();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const type = msg.type || msg.event;
        if (messageHandlers[type]) messageHandlers[type](msg);
        if (wsCallbacks[type]) wsCallbacks[type](msg);
      } catch (e) {
        console.error('WS parse error', e);
      }
    };
    ws.onerror = (err) => {
      console.error('WS error', err);
    };
    ws.onclose = () => {
      ws = null;
      if (onDisconnect) onDisconnect();
      if (wsReconnectAttempts < window.CORPUS_CONFIG.WS_MAX_RECONNECT_ATTEMPTS) {
        wsReconnectAttempts++;
        wsReconnectTimer = setTimeout(() => connectWS(token, onConnect, onDisconnect), window.CORPUS_CONFIG.WS_RECONNECT_INTERVAL);
      }
    };
    return ws;
  }

  function disconnectWS() {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (ws) ws.close();
    ws = null;
  }

  function onWSMessage(type, handler) {
    messageHandlers[type] = handler;
  }

  function sendWS(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  // Normalise dataset payloads: the API returns a bare array today, but keep
  // this tolerant so callers never end up iterating over an object.
  function asDatasetList(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.datasets)) return data.datasets;
    return [];
  }

  // Dedicated realtime socket for one training job.
  // Streams real status/metric events produced by the backend from the database.
  async function connectTrainingWS(jobId, handlers = {}) {
    const token = await state.getAccessToken();
    if (!token) {
      if (handlers.onError) handlers.onError(new Error('Sign in to stream training progress.'));
      return null;
    }
    const wsUrl = BASE.replace(/^http/, 'ws') +
      '/api/v1/training/ws/' + encodeURIComponent(jobId) +
      '?token=' + encodeURIComponent(token);
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      if (handlers.onError) handlers.onError(err);
      return null;
    }
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      const event = msg.event;
      const data = msg.data;
      if (event === 'status' && handlers.onStatus) handlers.onStatus(data);
      else if (event === 'metric' && handlers.onMetric) handlers.onMetric(data);
      else if (event === 'log' && handlers.onLog) handlers.onLog(data);
      else if (event === 'complete' && handlers.onComplete) handlers.onComplete(data);
      else if (event === 'error' && handlers.onError) handlers.onError(data || msg);
    };
    socket.onerror = () => {
      if (handlers.onError) handlers.onError(new Error('Live training stream unavailable.'));
    };
    socket.onclose = (ev) => {
      if (handlers.onClose) handlers.onClose(ev);
    };
    return socket;
  }

  function subscribeTraining(jobId, handlers) {
    onWSMessage('training.' + jobId, (msg) => {
      if (msg.event === 'metric' && handlers.onMetric) handlers.onMetric(msg.data);
      if (msg.event === 'log' && handlers.onLog) handlers.onLog(msg.data);
      if (msg.event === 'status' && handlers.onStatus) handlers.onStatus(msg.data);
      if (msg.event === 'complete' && handlers.onComplete) handlers.onComplete(msg.data);
    });
  }

  return {
    request,
    me,
    verifySession,
    listModels, getModel, createModel, updateModel, deleteModel, cloneModel,
    validateConfig, listModelVersions, exportModel,
    listDatasets, getDataset, createDataset, updateDataset, deleteDataset,
    uploadDatasetFile, uploadDatasetFileWithProgress, previewDataset, preprocessDataset,
    splitDataset, asDatasetList,
    listTrainingJobs, createTrainingJob, getTrainingJob, pauseTrainingJob,
    resumeTrainingJob, stopTrainingJob, listTrainingMetrics, listTrainingLogs,
    listCheckpoints, listAllCheckpoints, saveCheckpoint, loadCheckpoint,
    infer, inferStream, tokenize, nextToken,
    listEvaluations, runEvaluation, getEvaluation,
    listExperiments, createExperiment,
    listWorkers, registerWorker, workerHeartbeat,
    listStorageObjects, getStorageObject, downloadStorageObject,
    getSettings, updateSettings,
    listApiKeys, createApiKey, revokeApiKey,
    health,
    connectWS, disconnectWS, onWSMessage, sendWS, subscribeTraining, connectTrainingWS,
  };
})();

// Alias for modules that reference the global "API" object
window.API = window.CORPUS_API;