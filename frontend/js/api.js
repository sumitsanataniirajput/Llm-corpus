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

  // ---------- read cache + request de-duplication ------------------------
  //
  // Every page used to fetch everything on every visit (Dashboard alone made
  // five calls, and Models/Training/Datasets repeated the same lists), so a
  // cold Render backend turned each navigation into seconds of dead UI. Reads
  // are now cached for a short TTL, identical concurrent reads share one
  // request, and every mutation invalidates the cache so data never goes stale
  // in a way the user cannot explain.
  const responseCache = new Map();   // key -> { data, at }
  const inFlightReads = new Map();   // key -> promise
  const CACHE_MAX_ENTRIES = 40;

  function cacheTtlMs() {
    const configured = window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_CACHE_TTL_MS;
    return typeof configured === 'number' && configured >= 0 ? configured : 20000;
  }

  function cacheKey(endpoint) {
    // Scope by user: a cached list must never be served to another account
    // after sign-out/sign-in on the same browser tab.
    const user = state.getUser ? state.getUser() : null;
    return (user && user.id ? user.id : 'anon') + ' ' + endpoint;
  }

  function cloneData(data) {
    if (Array.isArray(data)) return data.map((item) => (item && typeof item === 'object' ? { ...item } : item));
    if (data && typeof data === 'object') return { ...data };
    return data;
  }

  function cacheStats() {
    return { entries: responseCache.size, inFlight: inFlightReads.size, ttlMs: cacheTtlMs() };
  }

  function invalidateCache() {
    responseCache.clear();
  }

  async function request(endpoint, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const cacheable = method === 'GET'
      && !options.body
      && !options.noCache
      && endpoint !== '/api/v1/health'
      && cacheTtlMs() > 0;

    if (!cacheable) {
      const promise = performRequest(endpoint, options);
      if (method !== 'GET') {
        // Any write can change any collection; drop the cache so the next read
        // reflects it. Cheap (≤40 small entries) and never stale-by-accident.
        promise.then(invalidateCache, invalidateCache);
      }
      return promise;
    }

    const key = cacheKey(endpoint);
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.at < cacheTtlMs()) {
      return cloneData(hit.data);
    }

    const pending = inFlightReads.get(key);
    if (pending) return pending;   // same read already on the wire

    const promise = performRequest(endpoint, options)
      .then((data) => {
        responseCache.delete(key);          // refresh insertion order
        responseCache.set(key, { data: cloneData(data), at: Date.now() });
        while (responseCache.size > CACHE_MAX_ENTRIES) {
          responseCache.delete(responseCache.keys().next().value);
        }
        return cloneData(data);
      })
      .finally(() => { inFlightReads.delete(key); });

    inFlightReads.set(key, promise);
    return promise;
  }

  async function performRequest(endpoint, options = {}) {
    const perfStart = window.CORPUS_PERF ? window.CORPUS_PERF.now() : 0;
    try {
      const data = await performRequestInner(endpoint, options);
      if (window.CORPUS_PERF) {
        window.CORPUS_PERF.recordApi(endpoint, window.CORPUS_PERF.now() - perfStart, true, 200);
      }
      return data;
    } catch (err) {
      if (window.CORPUS_PERF && !(err && err.aborted)) {
        // Only the route and the status are recorded: no headers, no bodies.
        window.CORPUS_PERF.recordApi(endpoint, window.CORPUS_PERF.now() - perfStart, false, (err && err.status) || 0);
      }
      throw err;
    }
  }

  async function performRequestInner(endpoint, options = {}) {
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

    // A caller (a page being navigated away from, a search box, a superseded
    // refresh) can cancel this request. Cancelling is not a backend failure, so
    // it must never mark the API "unavailable" the way a network error does.
    const externalSignal = options.signal
      || (endpoint !== '/api/v1/health' && window.CORPUS_APP && typeof window.CORPUS_APP.getPageSignal === 'function'
        ? window.CORPUS_APP.getPageSignal() : null);
    let externallyAborted = false;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        externallyAborted = true;
        const aborted = new Error('Request cancelled.');
        aborted.status = 0;
        aborted.code = 'ABORTED';
        aborted.aborted = true;
        throw aborted;
      }
      const onAbort = () => { externallyAborted = true; controller.abort(); };
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    let res;
    try {
      res = await fetch(url, fetchOpts);
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (externallyAborted) {
        // The page moved on; this is not a backend problem.
        const aborted = new Error('Request cancelled.');
        aborted.status = 0;
        aborted.code = 'ABORTED';
        aborted.aborted = true;
        throw aborted;
      }
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
  async function listModels(token, opts = {}) {
    return request('/api/v1/models/', { token, ...opts });
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
  async function listDatasets(token, opts = {}) {
    return request('/api/v1/datasets/', { token, ...opts });
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
      const result = await uploadOnce(datasetId, file, resolvedToken, null);
      invalidateCache();
      return result;
    } catch (err) {
      if (err && err.status === 401) {
        const refreshed = await refreshSession();
        if (refreshed) {
          const retried = await uploadOnce(datasetId, file, refreshed, null);
          invalidateCache();
          return retried;
        }
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
      const result = await uploadOnce(datasetId, file, resolvedToken, onProgress);
      invalidateCache();
      return result;
    } catch (err) {
      if (err && err.status === 401) {
        // Long uploads outlive a short-lived access token: refresh once and
        // retry the same dataset id. No second dataset record is created.
        const refreshed = await refreshSession();
        if (refreshed) {
          if (onProgress) onProgress(0);
          const retried = await uploadOnce(datasetId, file, refreshed, onProgress);
          invalidateCache();
          return retried;
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

  async function createDatasetUploadSession(datasetId, payload, token) {
    return request(
      '/api/v1/datasets/' + encodeURIComponent(datasetId) + '/upload-session',
      { method: 'POST', token, body: payload }
    );
  }

  async function completeDatasetUpload(datasetId, payload, token) {
    return request(
      '/api/v1/datasets/' + encodeURIComponent(datasetId) + '/complete',
      { method: 'POST', token, body: payload }
    );
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
  async function listTrainingJobs(token, opts = {}) {
    return request('/api/v1/training/', { token, ...opts });
  }

  async function createTrainingJob(config, token) {
    return request('/api/v1/training/', { method: 'POST', token, body: config });
  }

  async function getTrainingJob(jobId, token) {
    // Polled every 5 s: always read live status, never a cached copy.
    return request('/api/v1/training/' + encodeURIComponent(jobId), { token, noCache: true });
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

  async function deleteTrainingJob(jobId, token, options = {}) {
    // Removing history only. The backend refuses (409) while the job is active
    // and keeps models, datasets and checkpoints, so the UI never needs to
    // guess: it shows whatever the response says.
    const qs = options && options.hard ? '?hard=true' : '';
    return request('/api/v1/training/' + encodeURIComponent(jobId) + qs, { method: 'DELETE', token });
  }

  async function datasetTextRange(datasetId, token, opts = {}) {
    const params = new URLSearchParams();
    params.set('offset', String(opts.offset || 0));
    params.set('limit', String(opts.limit || 200000));
    // Device workers read the real stored text: always ask the backend live.
    return request('/api/v1/datasets/' + encodeURIComponent(datasetId) + '/text?' + params.toString(),
      { token, noCache: true });
  }

  async function listTrainingMetrics(jobId, token, opts = {}) {
    // `limit` asks the backend for only the newest N steps (still oldest-first):
    // a long run would otherwise stream its whole history on every poll.
    const suffix = opts.limit ? '?limit=' + encodeURIComponent(opts.limit) : '';
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/metrics' + suffix, { token, noCache: true });
  }

  async function listTrainingLogs(jobId, token, opts = {}) {
    const suffix = opts.limit ? '?limit=' + encodeURIComponent(opts.limit) : '';
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/logs' + suffix, { token, noCache: true });
  }

  async function listCheckpoints(modelId, token) {
    return request('/api/v1/training/checkpoints?model_id=' + encodeURIComponent(modelId), { token });
  }

  // ---------- Devices (multi-device training) ----------
  async function listDevices(token) {
    return request('/api/v1/devices/', { token, noCache: true });
  }

  async function registerDevice(payload, token) {
    return request('/api/v1/devices/', { method: 'POST', token, body: payload });
  }

  async function deviceHeartbeat(deviceId, payload, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/heartbeat',
      { method: 'POST', token, body: payload || {} });
  }

  async function updateDevice(deviceId, payload, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId), { method: 'PATCH', token, body: payload });
  }

  async function disconnectDevice(deviceId, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/disconnect', { method: 'POST', token });
  }

  async function deleteDevice(deviceId, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId), { method: 'DELETE', token });
  }

  async function assignDeviceTask(deviceId, payload, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/assign',
      { method: 'POST', token, body: payload });
  }

  async function autoAssignDevices(jobIds, token) {
    return request('/api/v1/devices/auto-assign', { method: 'POST', token, body: { job_ids: jobIds } });
  }

  async function planCollaborative(payload, token) {
    return request('/api/v1/devices/plan/collaborative', { method: 'POST', token, body: payload });
  }

  async function listDeviceTasks(deviceId, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/tasks', { token, noCache: true });
  }

  async function listJobDeviceTasks(jobId, token) {
    return request('/api/v1/devices/jobs/' + encodeURIComponent(jobId) + '/tasks', { token, noCache: true });
  }

  async function reportDeviceTaskProgress(deviceId, taskId, payload, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/tasks/' + encodeURIComponent(taskId) + '/progress',
      { method: 'POST', token, body: payload });
  }

  async function completeDeviceTask(deviceId, taskId, payload, token) {
    return request('/api/v1/devices/' + encodeURIComponent(deviceId) + '/tasks/' + encodeURIComponent(taskId) + '/complete',
      { method: 'POST', token, body: payload || {} });
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
    // The real socket is /{model_id}/ws, not the POST /stream REST route.
    // Credentials are sent as the first frame, never in the URL (URLs leak into
    // proxy logs, browser history and Referer headers).
    const url = BASE + '/api/v1/inference/' + encodeURIComponent(modelId) + '/ws';
    const socket = new WebSocket(url.replace(/^http/, 'ws'));
    socket.onopen = () => {
      if (resolvedToken) socket.send(JSON.stringify({ type: 'auth', token: resolvedToken }));
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
    // Mounted at /api/v1/inference/tokenize/{id}, not a top-level /tokenize.
    return request('/api/v1/inference/tokenize/' + encodeURIComponent(modelId), { method: 'POST', token, body: { text } });
  }

  async function nextToken(modelId, payload, token) {
    // The real next-token logits endpoint lives under the inference router.
    return request('/api/v1/inference/predict/' + encodeURIComponent(modelId), { method: 'POST', token, body: payload });
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
    const wsUrl = (BASE.replace(/^http/, 'ws') + '/api/v1/ws');
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      // No access token in the URL. The first frame carries it instead.
      if (resolvedToken) ws.send(JSON.stringify({ type: 'auth', token: resolvedToken }));
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

  // Normalise list payloads: the API returns a bare array today, but keep this
  // tolerant so callers never iterate over an object or a malformed envelope.
  function asDatasetList(data) {
    if (Array.isArray(data)) return data.filter(item => item && typeof item === 'object');
    if (!data || typeof data !== 'object') return [];
    const keys = ['datasets', 'items', 'data', 'results'];
    for (let index = 0; index < keys.length; index += 1) {
      if (Array.isArray(data[keys[index]])) {
        return data[keys[index]].filter(item => item && typeof item === 'object');
      }
    }
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
      '/api/v1/training/ws/' + encodeURIComponent(jobId);
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      if (handlers.onError) handlers.onError(err);
      return null;
    }
    socket.onopen = () => {
      // Authenticate in-band, not through a query string.
      socket.send(JSON.stringify({ type: 'auth', token }));
    };
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
      else if (event === 'progress' && handlers.onProgress) handlers.onProgress(data);
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
      if (msg.event === 'progress' && handlers.onProgress) handlers.onProgress(msg.data);
      if (msg.event === 'complete' && handlers.onComplete) handlers.onComplete(msg.data);
    });
  }

  /* ---------------------------------------------------------------------
     AI Teacher Network, distillation, student studio and telemetry.

     Every helper below hits an owner-scoped endpoint. API keys are only ever
     sent *to* the server (create/rotate); nothing here reads one back, because
     the backend never returns one.
     --------------------------------------------------------------------- */

  async function listProviderTypes() {
    return request('/api/v1/teachers/types');
  }

  async function getCredentialStatus() {
    return request('/api/v1/teachers/credential-status');
  }

  async function listProviders(token) {
    return request('/api/v1/teachers/providers', { token, noCache: true });
  }

  async function createProvider(payload, token) {
    return request('/api/v1/teachers/providers', { method: 'POST', token, body: payload });
  }

  async function updateProvider(providerId, payload, token) {
    return request('/api/v1/teachers/providers/' + encodeURIComponent(providerId),
      { method: 'PATCH', token, body: payload });
  }

  async function deleteProvider(providerId, token) {
    return request('/api/v1/teachers/providers/' + encodeURIComponent(providerId),
      { method: 'DELETE', token });
  }

  async function testProvider(providerId, token) {
    return request('/api/v1/teachers/providers/' + encodeURIComponent(providerId) + '/test',
      { method: 'POST', token });
  }

  async function discoverTeacherModels(providerId, token) {
    return request('/api/v1/teachers/providers/' + encodeURIComponent(providerId) + '/discover',
      { method: 'POST', token });
  }

  async function listTeacherModels(token) {
    return request('/api/v1/teachers/models', { token, noCache: true });
  }

  async function addTeacherModel(providerId, payload, token) {
    return request('/api/v1/teachers/providers/' + encodeURIComponent(providerId) + '/models',
      { method: 'POST', token, body: payload });
  }

  async function updateTeacherModel(modelRowId, payload, token) {
    return request('/api/v1/teachers/models/' + encodeURIComponent(modelRowId),
      { method: 'PATCH', token, body: payload });
  }

  async function deleteTeacherModel(modelRowId, token) {
    return request('/api/v1/teachers/models/' + encodeURIComponent(modelRowId),
      { method: 'DELETE', token });
  }

  async function getTeacherUsage(token) {
    return request('/api/v1/teachers/usage', { token, noCache: true });
  }

  async function setProviderBudget(providerId, budget, token) {
    return request('/api/v1/teachers/providers/' + encodeURIComponent(providerId) + '/budget',
      { method: 'PUT', token, body: budget });
  }

  async function getDistillationOptions() {
    return request('/api/v1/distillation/options');
  }

  async function previewDistillationSource(params) {
    const query = new URLSearchParams(params || {}).toString();
    return request('/api/v1/distillation/source-preview' + (query ? '?' + query : ''));
  }

  async function createDistillationJob(payload, token) {
    return request('/api/v1/distillation/jobs', { method: 'POST', token, body: payload });
  }

  async function listDistillationJobs(token) {
    return request('/api/v1/distillation/jobs', { token, noCache: true });
  }

  async function getDistillationJob(jobId, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId), { token, noCache: true });
  }

  async function startDistillationJob(jobId, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/start',
      { method: 'POST', token });
  }

  async function cancelDistillationJob(jobId, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/cancel',
      { method: 'POST', token });
  }

  async function deleteDistillationJob(jobId, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId),
      { method: 'DELETE', token });
  }

  async function listDistillationRecords(jobId, filters, token) {
    const query = new URLSearchParams(filters || {}).toString();
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/records'
      + (query ? '?' + query : ''), { token, noCache: true });
  }

  async function updateDistillationRecord(recordId, payload, token) {
    return request('/api/v1/distillation/records/' + encodeURIComponent(recordId),
      { method: 'PATCH', token, body: payload });
  }

  async function deleteDistillationRecord(recordId, token) {
    return request('/api/v1/distillation/records/' + encodeURIComponent(recordId),
      { method: 'DELETE', token });
  }

  async function bulkReviewDistillationRecords(jobId, payload, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/records/bulk',
      { method: 'POST', token, body: payload });
  }

  async function getDistillationSummary(jobId, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/summary',
      { token, noCache: true });
  }

  async function listDistillationEvaluations(jobId, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/evaluations',
      { token, noCache: true });
  }

  // The export endpoint is authenticated with a bearer token, so it is fetched
  // with the normal request path and turned into a downloadable blob rather than
  // linked directly (a plain <a href> would be a 401).
  async function downloadDistillationExport(jobId, format, split, token) {
    const query = new URLSearchParams({ format: format || 'chat_jsonl', split: split || 'all' }).toString();
    const response = await fetch(
      BASE + '/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/export?' + query,
      { headers: token ? { Authorization: 'Bearer ' + token } : {} }
    );
    if (!response.ok) {
      let detail = 'Export failed (' + response.status + ')';
      try {
        const body = await response.json();
        if (body && body.detail) detail = body.detail;
      } catch (err) { /* keep the status line */ }
      throw new Error(detail);
    }
    return {
      text: await response.text(),
      recordCount: Number(response.headers.get('X-Record-Count') || 0),
      skippedCount: Number(response.headers.get('X-Skipped-Count') || 0),
      filename: jobId + '_' + (format || 'chat_jsonl') + '_' + (split || 'all') + '.jsonl',
    };
  }

  async function convertDistillationJob(jobId, payload, token) {
    return request('/api/v1/distillation/jobs/' + encodeURIComponent(jobId) + '/convert',
      { method: 'POST', token, body: payload });
  }

  async function getStudentSystem(token) {
    return request('/api/v1/students/system', { token });
  }

  async function inspectStudentModel(payload, token) {
    return request('/api/v1/students/inspect', { method: 'POST', token, body: payload });
  }

  async function planLoraAdapters(payload, token) {
    return request('/api/v1/students/lora-plan', { method: 'POST', token, body: payload });
  }

  async function listStudentModels(token) {
    return request('/api/v1/students/models', { token, noCache: true });
  }

  async function listStudentConfigs(token) {
    return request('/api/v1/students/configs', { token, noCache: true });
  }

  async function createStudentConfig(payload, token) {
    return request('/api/v1/students/configs', { method: 'POST', token, body: payload });
  }

  async function deleteStudentConfig(configId, token) {
    return request('/api/v1/students/configs/' + encodeURIComponent(configId),
      { method: 'DELETE', token });
  }

  async function getTrainingIntelligence(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/intelligence',
      { token, noCache: true });
  }

  async function getTrainingTelemetry(jobId, token) {
    return request('/api/v1/training/' + encodeURIComponent(jobId) + '/telemetry',
      { token, noCache: true });
  }

  return {
    request,
    // Cache control for pages and diagnostics: a manual "Refresh" passes
    // noCache, and mutations invalidate automatically.
    invalidateCache,
    cacheStats,
    me,
    verifySession,
    listModels, getModel, createModel, updateModel, deleteModel, cloneModel,
    validateConfig, listModelVersions, exportModel,
    listDatasets, getDataset, createDataset, updateDataset, deleteDataset,
    uploadDatasetFile, uploadDatasetFileWithProgress,
    createDatasetUploadSession, completeDatasetUpload, previewDataset, preprocessDataset,
    splitDataset, asDatasetList,
    listTrainingJobs, createTrainingJob, getTrainingJob, pauseTrainingJob,
    resumeTrainingJob, stopTrainingJob, deleteTrainingJob, listTrainingMetrics, listTrainingLogs,
    datasetTextRange,
    listDevices, registerDevice, deviceHeartbeat, updateDevice, disconnectDevice, deleteDevice,
    assignDeviceTask, autoAssignDevices, planCollaborative, listDeviceTasks, listJobDeviceTasks,
    reportDeviceTaskProgress, completeDeviceTask,
    listCheckpoints, listAllCheckpoints, saveCheckpoint, loadCheckpoint,
    infer, inferStream, tokenize, nextToken,
    listEvaluations, runEvaluation, getEvaluation,
    listExperiments, createExperiment,
    listWorkers, registerWorker, workerHeartbeat,
    listStorageObjects, getStorageObject, downloadStorageObject,
    getSettings, updateSettings,
    listApiKeys, createApiKey, revokeApiKey,
    health,
    listProviderTypes, getCredentialStatus, listProviders, createProvider, updateProvider,
    deleteProvider, testProvider, discoverTeacherModels, listTeacherModels, addTeacherModel,
    updateTeacherModel, deleteTeacherModel, getTeacherUsage, setProviderBudget,
    getDistillationOptions, previewDistillationSource, createDistillationJob,
    listDistillationJobs, getDistillationJob, startDistillationJob, cancelDistillationJob,
    deleteDistillationJob, listDistillationRecords, updateDistillationRecord,
    deleteDistillationRecord, bulkReviewDistillationRecords, getDistillationSummary,
    listDistillationEvaluations, downloadDistillationExport, convertDistillationJob,
    getStudentSystem, inspectStudentModel, planLoraAdapters, listStudentModels,
    listStudentConfigs, createStudentConfig, deleteStudentConfig,
    getTrainingIntelligence, getTrainingTelemetry,
    connectWS, disconnectWS, onWSMessage, sendWS, subscribeTraining, connectTrainingWS,
  };
})();

// Alias for modules that reference the global "API" object
window.API = window.CORPUS_API;