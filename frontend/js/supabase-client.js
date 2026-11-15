/* ========================================
   CORPUS ULTIMATE — Supabase client
   ======================================== */

window.CORPUS_SUPABASE = (function () {
  let client = null;
  let isInitialized = false;
  let initError = null;
  let connectivityChecked = false;
  let connectivityOk = false;

  // Validate Supabase key format before creating the client
  function validateKeyFormat(url, key) {
    const problems = [];

    if (!url || url.trim() === '') {
      problems.push('Supabase project URL is empty.');
      return problems;
    }
    if (!url.startsWith('https://') || !url.includes('.supabase.co')) {
      problems.push('Supabase URL must be https://your-project.supabase.co');
    }

    if (!key || key.trim() === '') {
      problems.push('Supabase public key is empty.');
      return problems;
    }

    const trimmed = key.trim();
    const isPublishable = trimmed.startsWith('sb_publishable_');
    const isLegacyAnon = trimmed.length > 20 && /^[A-Za-z0-9\-_]+$/.test(trimmed);

    if (!isPublishable && !isLegacyAnon) {
      problems.push(
        'Supabase public key looks malformed. Expected a legacy anon key (long base64 string) or a modern publishable key starting with "sb_publishable_".'
      );
    }

    return problems;
  }

  function init() {
    if (isInitialized) {
      if (initError) throw initError;
      return client;
    }

    const url = window.CORPUS_CONFIG.SUPABASE_URL || '';
    const key = window.CORPUS_CONFIG.SUPABASE_ANON_KEY || '';

    // Validate format first
    const formatProblems = validateKeyFormat(url, key);
    if (formatProblems.length > 0) {
      initError = new Error(formatProblems.join(' '));
      console.error('[CORPUS] Supabase config invalid:', initError.message);
      isInitialized = true;
      return null;
    }

    // Validate that the Supabase JS SDK has loaded
    if (typeof supabase === 'undefined' || typeof supabase.createClient !== 'function') {
      initError = new Error('Supabase JS SDK not loaded. Check that <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> is included in index.html.');
      console.error('[CORPUS]', initError.message);
      isInitialized = true;
      return null;
    }

    try {
      client = supabase.createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
      isInitialized = true;
      return client;
    } catch (err) {
      initError = err;
      console.error('[CORPUS] Failed to create Supabase client:', err);
      return null;
    }
  }

  function getClient() {
    if (!client && !isInitialized) {
      init();
    }
    return client;
  }

  function isConfigured() {
    return client !== null;
  }

  function getInitError() {
    return initError;
  }

  // Test connectivity to Supabase before allowing auth operations
  async function testConnectivity() {
    if (connectivityChecked) return connectivityOk;

    const sb = getClient();
    if (!sb) {
      connectivityChecked = true;
      connectivityOk = false;
      return false;
    }

    try {
      // A lightweight request to verify the key works
      const { error } = await sb.auth.getSession();
      if (error) {
        // getSession may return an error if the key is invalid
        connectivityChecked = true;
        connectivityOk = false;
        console.error('[CORPUS] Supabase connectivity test failed:', error.message);
        return false;
      }
      connectivityChecked = true;
      connectivityOk = true;
      return true;
    } catch (err) {
      connectivityChecked = true;
      connectivityOk = false;
      console.error('[CORPUS] Supabase connectivity test error:', err);
      return false;
    }
  }

  function isConnectivityOk() {
    return connectivityOk;
  }

  // Get current access token (async — from Supabase session)
  async function getAccessToken() {
    const sb = getClient();
    if (!sb) return null;
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session && data.session.access_token) {
        return data.session.access_token;
      }
    } catch (e) {
      console.error('Failed to get Supabase access token', e);
    }
    return null;
  }

  // Auth helpers with connectivity pre-check
  async function signUp(email, password, metadata = {}) {
    const ok = await testConnectivity();
    if (!ok) {
      throw new Error('Cannot connect to Supabase. Please verify your Supabase URL and public key in frontend/js/config.js.');
    }
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: metadata } });
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    const ok = await testConnectivity();
    if (!ok) {
      throw new Error('Cannot connect to Supabase. Please verify your Supabase URL and public key in frontend/js/config.js.');
    }
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { error } = await sb.auth.signOut();
    if (error) throw error;
    return true;
  }

  async function getSession() {
    const sb = getClient();
    if (!sb) return { data: { session: null }, error: null };
    const { data, error } = await sb.auth.getSession();
    return { data, error };
  }

  async function getUser() {
    const sb = getClient();
    if (!sb) return { data: { user: null }, error: null };
    const { data, error } = await sb.auth.getUser();
    return { data, error };
  }

  async function resetPassword(email) {
    const ok = await testConnectivity();
    if (!ok) {
      throw new Error('Cannot connect to Supabase. Please verify your Supabase URL and public key in frontend/js/config.js.');
    }
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/update-password.html',
    });
    if (error) throw error;
    return data;
  }

  // Listen to auth changes
  function onAuthStateChange(callback) {
    const sb = getClient();
    if (!sb) return () => {};
    const { data } = sb.auth.onAuthStateChange(callback);
    return data.subscription;
  }

  // Storage helpers
  async function uploadFile(bucket, path, file, options = {}) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.storage.from(bucket).upload(path, file, {
      cacheControl: '3600',
      upsert: options.upsert || false,
      ...options,
    });
    if (error) throw error;
    return data;
  }

  async function downloadFile(bucket, path) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error) throw error;
    return data;
  }

  async function getSignedUrl(bucket, path, expiresIn = 3600) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data;
  }

  async function listFiles(bucket, folder = '') {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { data, error } = await sb.storage.from(bucket).list(folder);
    if (error) throw error;
    return data;
  }

  async function removeFile(bucket, path) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    const { error } = await sb.storage.from(bucket).remove([path]);
    if (error) throw error;
    return true;
  }

  // Database helpers (via REST through Supabase client)
  async function from(table) {
    const sb = getClient();
    if (!sb) throw new Error('Supabase not configured');
    return sb.from(table);
  }

  return {
    init,
    getClient,
    isConfigured,
    isInitialized: () => isInitialized,
    getInitError,
    testConnectivity,
    isConnectivityOk,
    getAccessToken,
    signUp,
    signIn,
    signOut,
    getSession,
    getUser,
    resetPassword,
    onAuthStateChange,
    uploadFile,
    downloadFile,
    getSignedUrl,
    listFiles,
    removeFile,
    from,
  };
})();