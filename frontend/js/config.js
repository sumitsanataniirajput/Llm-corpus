/* ========================================
   CORPUS ULTIMATE — Configuration
   ======================================== */

window.CORPUS_CONFIG = {
  // ========================================
  // SUPABASE CONFIGURATION — REQUIRED
  // ========================================
  // Paste your actual Supabase project values here.
  // Get them from: Supabase Dashboard → Project Settings → API
  //
  // SUPABASE_URL: Your project URL (e.g. https://abcdefgh.supabase.co)
  // SUPABASE_ANON_KEY: Your public anon key (legacy) OR publishable key (sb_publishable_...)
  // NEVER put the service_role key here — it must stay backend-only.
  // ========================================
  SUPABASE_URL: 'https://avxftwnfuqkyoksjzriu.supabase.co',

  SUPABASE_ANON_KEY: 'sb_publishable_1jU4Eqs_1AqYCS4CkJoLkQ_HL0mxZlt',

  // ========================================
  // BACKEND API URL — CONFIGURABLE
  // ========================================
  // LOCAL COMPUTER DEVELOPMENT:
  //   http://localhost:8000
  //
  // ANDROID TESTING OVER WI-FI:
  //   http://<your-computers-lan-ip>:8000
  //   Example: http://192.168.1.42:8000
  //   Find your IP: ipconfig (Windows) / ifconfig (Mac/Linux)
  //
  // PRODUCTION:
  //   https://your-backend-domain.com
  //
  // Do NOT use localhost on Android — it refers to the phone itself.
  // ========================================
  API_BASE_URL: 'https://corpus-ultimate-api.onrender.com',

  // App settings
  APP_NAME: 'CORPUS ULTIMATE',
  APP_VERSION: '1.0.0',

  // Must match frontend/version.json buildId and the ?v= query on every local
  // CSS/JS in index.html. Used to cache-bust a page module the router has to
  // re-request when one failed to register. Enforced by
  // frontend/tests/build-id.test.mjs.
  BUILD_ID: '2026-11-20.1',

  // Small files use the authenticated API upload; larger files go directly to
  // private Supabase Storage using resumable TUS chunks.
  UPLOAD_TIMEOUT_MS: 600000,
  STANDARD_UPLOAD_THRESHOLD: 6 * 1024 * 1024,

  // Default model configuration (small, CPU-friendly)
  DEFAULT_MODEL_CONFIG: {
    vocab_size: 5000,
    context_length: 256,
    d_model: 256,
    n_layers: 4,
    n_heads: 4,
    d_ff: 1024,
    dropout: 0.1,
  },

  // Training defaults
  DEFAULT_TRAINING_CONFIG: {
    engine: 'pytorch', // 'pytorch' or 'numerical'
    compute: 'local',  // 'local' or 'cloud'
    batch_size: 16,
    learning_rate: 0.001,
    epochs: 10,
    gradient_accumulation_steps: 1,
    gradient_clip: 1.0,
    weight_decay: 0.01,
    warmup_steps: 100,
    seed: 42,
  },

  // Supported dataset formats
  SUPPORTED_DATASET_FORMATS: ['txt', 'md', 'csv', 'json', 'jsonl', 'pdf'],

  // No arbitrary app-level size cap. Supabase Storage plan/global limits apply.
  MAX_FILE_SIZE: 0,

  // WebSocket reconnect
  WS_RECONNECT_INTERVAL: 3000,
  WS_MAX_RECONNECT_ATTEMPTS: 10,

  // Storage
  INDEXEDDB_NAME: 'corpus-ultimate-cache',
  INDEXEDDB_VERSION: 1,

  // Request timeout in milliseconds
  REQUEST_TIMEOUT: 15000,

  // Collection reads (models, datasets, jobs, checkpoints…) are cached for this
  // long so revisiting a page is instant instead of another cold-backend round
  // trip. Every write and every "changed" event invalidates the cache, and a
  // manual Refresh bypasses it. 0 disables caching.
  API_CACHE_TTL_MS: 20000,
};

// ========================================
// Supabase configuration validation
// ========================================
window.CORPUS_VALIDATE_SUPABASE_CONFIG = function () {
  const cfg = window.CORPUS_CONFIG;
  const url = cfg.SUPABASE_URL || '';
  const key = cfg.SUPABASE_ANON_KEY || '';
  const errors = [];

  if (!url) {
    errors.push('SUPABASE_URL is not set. Paste your Supabase project URL in frontend/js/config.js.');
  } else if (!url.startsWith('https://') || !url.includes('.supabase.co')) {
    errors.push('SUPABASE_URL looks invalid. It should be like https://your-project.supabase.co');
  }

  if (!key) {
    errors.push('SUPABASE_ANON_KEY is not set. Paste your Supabase public anon key in frontend/js/config.js.');
  } else {
    // Accept both modern publishable keys and legacy anon keys
    const isPublishable = key.startsWith('sb_publishable_');
    const isLegacyAnon = key.length > 20 && /^[A-Za-z0-9\-_]+$/.test(key);
    if (!isPublishable && !isLegacyAnon) {
      errors.push('SUPABASE_ANON_KEY looks malformed. It should start with "sb_publishable_" (modern) or be a long base64-like string (legacy anon key).');
    }
  }

  // Validate backend API URL
  const apiUrl = cfg.API_BASE_URL || '';
  if (!apiUrl) {
    errors.push('API_BASE_URL is not set. Set your backend URL in frontend/js/config.js.');
  } else {
    try {
      const parsed = new URL(apiUrl);
      if (!parsed.protocol || !['http:', 'https:'].includes(parsed.protocol)) {
        errors.push('API_BASE_URL must start with http:// or https://');
      }
      if (!parsed.hostname) {
        errors.push('API_BASE_URL has no hostname.');
      }
    } catch (e) {
      errors.push('API_BASE_URL is malformed: ' + e.message);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

// Normalize the backend API base URL (strip trailing slash)
window.CORPUS_NORMALIZE_API_BASE = function () {
  if (window.CORPUS_CONFIG && window.CORPUS_CONFIG.API_BASE_URL) {
    window.CORPUS_CONFIG.API_BASE_URL = window.CORPUS_CONFIG.API_BASE_URL.replace(/\/+$/, '');
  }
};

// Call normalization on load
window.CORPUS_NORMALIZE_API_BASE();

window.CORPUS_GET_CONFIG = function (key) {
  return window.CORPUS_CONFIG[key] || null;
};