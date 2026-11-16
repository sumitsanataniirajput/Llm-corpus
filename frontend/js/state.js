/* ========================================
   CORPUS ULTIMATE — Application state
   ======================================== */

window.state = (function () {
  let user = null;
  let currentRoute = 'dashboard';
  let models = [];
  let datasets = [];
  let pendingDatasetId = null;  // dataset chosen on the Datasets page, consumed by Training
  let trainingJobs = [];
  let activeModel = null;
  let activeJob = null;
  let workers = [];
  let notifications = [];
  let evaluations = [];
  let experiments = [];
  let storageObjects = [];
  let apiKeys = [];
  let settings = {};
  let connectionStatus = 'disconnected';

  // Authentication initialization state
  let authReady = false;        // Set to true once initial Supabase session restore completes
  let authInitializing = false; // Set to true while the initial session check is in flight

  // ========================================
  // User state (Supabase Auth is the source of truth)
  // ========================================

  function setUser(u) {
    user = u;
    if (u) {
      // Cache display metadata only — never treat this as proof of authentication
      try {
        localStorage.setItem('corpus_user', JSON.stringify(u));
      } catch (e) {}
    } else {
      try {
        localStorage.removeItem('corpus_user');
      } catch (e) {}
    }
  }

  function getUser() {
    return user;
  }

  function clearUser() {
    user = null;
    try {
      localStorage.removeItem('corpus_user');
    } catch (e) {}
  }

  // ========================================
  // Authentication readiness
  // ========================================

  function setAuthReady(ready) {
    authReady = !!ready;
  }

  function isAuthReady() {
    return authReady;
  }

  function setAuthInitializing(initializing) {
    authInitializing = !!initializing;
  }

  function isAuthInitializing() {
    return authInitializing;
  }

  // Returns true while the initial session is still being restored.
  // Pages should show a loading state (not "Sign in required") during this period.
  function isAuthLoading() {
    return authInitializing && !authReady;
  }

  // ========================================
  // Access token (from Supabase client only)
  // ========================================

  async function getAccessToken() {
    // Obtain the current Supabase access token asynchronously.
    // The Supabase SDK manages session persistence and token refresh.
    try {
      const { data } = await window.CORPUS_SUPABASE.getSession();
      if (data && data.session && data.session.access_token) {
        return data.session.access_token;
      }
    } catch (e) {
      // Supabase not configured or session unavailable
    }
    return null;
  }

  function getToken() {
    // Synchronous fallback — returns null. Prefer getAccessToken() for fresh tokens.
    return null;
  }

  // ========================================
  // Route
  // ========================================

  function setRoute(route) {
    currentRoute = route;
  }

  function getRoute() {
    return currentRoute;
  }

  // ========================================
  // Models
  // ========================================

  function setModels(list) { models = list || []; }
  function getModels() { return models; }
  function addModel(m) { models.push(m); }
  function updateModel(id, changes) {
    const idx = models.findIndex(m => m.id === id);
    if (idx >= 0) models[idx] = { ...models[idx], ...changes };
  }
  function removeModel(id) {
    models = models.filter(m => m.id !== id);
  }
  function getModel(id) {
    return models.find(m => m.id === id) || null;
  }
  function setActiveModel(m) { activeModel = m; }
  function getActiveModel() { return activeModel; }

  // ========================================
  // Datasets
  // ========================================

  function setDatasets(list) { datasets = list || []; }
  function getDatasets() { return datasets; }
  function addDataset(d) { datasets.push(d); }
  function removeDataset(id) { datasets = datasets.filter(d => d.id !== id); }
  function getDataset(id) { return datasets.find(d => d.id === id) || null; }
  function setPendingDatasetId(id) { pendingDatasetId = id || null; }
  function getPendingDatasetId() { return pendingDatasetId; }
  function clearPendingDatasetId() { pendingDatasetId = null; }

  // ========================================
  // Training jobs
  // ========================================

  function setTrainingJobs(list) { trainingJobs = list || []; }
  function getTrainingJobs() { return trainingJobs; }
  function addTrainingJob(j) { trainingJobs.push(j); }
  function updateTrainingJob(id, changes) {
    const idx = trainingJobs.findIndex(j => j.id === id);
    if (idx >= 0) trainingJobs[idx] = { ...trainingJobs[idx], ...changes };
  }
  function removeTrainingJob(id) {
    trainingJobs = trainingJobs.filter(j => j.id !== id);
  }
  function getTrainingJob(id) { return trainingJobs.find(j => j.id === id) || null; }
  function setActiveJob(j) { activeJob = j; }
  function getActiveJob() { return activeJob; }

  // ========================================
  // Workers
  // ========================================

  function setWorkers(list) { workers = list || []; }
  function getWorkers() { return workers; }
  function getWorker(id) { return workers.find(w => w.id === id) || null; }

  // ========================================
  // Notifications
  // ========================================

  function setNotifications(list) { notifications = list || []; }
  function addNotification(n) { notifications.unshift(n); }
  function getNotifications() { return notifications; }
  function unreadCount() { return notifications.filter(n => !n.read).length; }

  // ========================================
  // Evaluations
  // ========================================

  function setEvaluations(list) { evaluations = list || []; }
  function getEvaluations() { return evaluations; }

  // ========================================
  // Experiments
  // ========================================

  function setExperiments(list) { experiments = list || []; }
  function getExperiments() { return experiments; }

  // ========================================
  // Storage
  // ========================================

  function setStorageObjects(list) { storageObjects = list || []; }
  function getStorageObjects() { return storageObjects; }

  // ========================================
  // API keys
  // ========================================

  function setApiKeys(list) { apiKeys = list || []; }
  function getApiKeys() { return apiKeys; }

  // ========================================
  // Settings
  // ========================================

  function setSettings(s) { settings = s || {}; }
  function getSettings() { return settings; }

  // ========================================
  // Connection
  // ========================================

  function setConnection(status) { connectionStatus = status; }
  function getConnection() { return connectionStatus; }

  return {
    setUser, getUser, clearUser, getAccessToken, getToken,
    setAuthReady, isAuthReady, setAuthInitializing, isAuthInitializing, isAuthLoading,
    setRoute, getRoute,
    setModels, getModels, addModel, updateModel, removeModel, getModel,
    setActiveModel, getActiveModel,
    setDatasets, getDatasets, addDataset, removeDataset, getDataset,
    setPendingDatasetId, getPendingDatasetId, clearPendingDatasetId,
    setTrainingJobs, getTrainingJobs, addTrainingJob, updateTrainingJob,
    removeTrainingJob, getTrainingJob, setActiveJob, getActiveJob,
    setWorkers, getWorkers, getWorker,
    setNotifications, addNotification, getNotifications, unreadCount,
    setEvaluations, getEvaluations,
    setExperiments, getExperiments,
    setStorageObjects, getStorageObjects,
    setApiKeys, getApiKeys,
    setSettings, getSettings,
    setConnection, getConnection,
  };
})();