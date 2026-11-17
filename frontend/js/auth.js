/* ========================================
   CORPUS ULTIMATE — Authentication
   ======================================== */

window.auth = (function () {
  const modal = document.getElementById('auth-modal');
  const formContainer = document.getElementById('auth-form-container');
  const resetLink = document.getElementById('auth-reset-link');

  let currentTab = 'login';
  let initializing = true; // Set to false once initial session check completes
  // True only while an interactive sign-in/sign-up started from this page is in
  // flight. Supabase also emits SIGNED_IN when it restores or refreshes a stored
  // session (page reload, token refresh, returning from the Android file
  // picker); treating those as fresh logins used to yank the user to Dashboard.
  let interactiveSignIn = false;

  // Check Supabase configuration before allowing any auth operation
  function checkSupabaseConfig() {
    const validation = window.CORPUS_VALIDATE_SUPABASE_CONFIG
      ? window.CORPUS_VALIDATE_SUPABASE_CONFIG()
      : { valid: false, errors: ['Supabase validation not available'] };
    if (!validation.valid) {
      const msg = validation.errors.join(' ');
      ui.toast(msg, 'error', 10000);
      console.error('[CORPUS] Supabase config invalid:', msg);
      return false;
    }
    return true;
  }

  function init() {
    // Check Supabase configuration first
    const configOk = checkSupabaseConfig();
    if (!configOk) {
      initializing = false;
      state.setAuthReady(true);
      state.setAuthInitializing(false);
      state.clearUser();
      return;
    }

    // Initialize Supabase client
    CORPUS_SUPABASE.init();

    // Subscribe to auth state changes — this is the SINGLE source of auth state
    // It handles: INITIAL_SESSION, SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, PASSWORD_RECOVERY
    // NOTE: We do NOT call getSession() separately here — that would compete with the listener.
    // The INITIAL_SESSION event from onAuthStateChange is the authoritative session restoration.
    CORPUS_SUPABASE.onAuthStateChange((event, session) => {
      console.log('[CORPUS AUTH] Auth state event:', event, session ? session.user?.email : 'no user');

      if (event === 'INITIAL_SESSION') {
        // Supabase is restoring an existing session from storage
        state.setAuthInitializing(true);
        if (session && session.user) {
          state.setUser(session.user);
          state.setAuthReady(true);
          console.log('[CORPUS AUTH] Initial session restored for:', session.user.email);
        } else {
          state.clearUser();
          state.setAuthReady(true);
          console.log('[CORPUS AUTH] No initial session found');
        }
        state.setAuthInitializing(false);
        updateProfileUI();
        // Re-render the current route if router is already initialized
        // so the page reflects the restored session
        if (typeof router !== 'undefined' && router.initialized) {
          router.render();
        }
        return;
      }

      if (event === 'SIGNED_IN') {
        if (session && session.user) {
          state.setUser(session.user);
          state.setAuthReady(true);
          const wasInteractive = interactiveSignIn;
          interactiveSignIn = false;
          if (wasInteractive) {
            ui.toast('Signed in successfully', 'success');
            closeModal();
            if (typeof router !== 'undefined' && router.initialized) {
              router.navigate('dashboard');
            }
          } else {
            // Session restored/refreshed by Supabase (reload, token refresh,
            // returning from the system file picker). Stay exactly where the
            // user is and just re-render so the page picks up the session.
            if (typeof router !== 'undefined' && router.initialized) {
              router.render();
            }
          }
          updateProfileUI();
        }
        return;
      }

      if (event === 'TOKEN_REFRESHED') {
        if (session && session.user) {
          state.setUser(session.user);
          // Do NOT show a toast on every token refresh — that's noisy
          // Just update the profile UI silently
          updateProfileUI();
        }
        return;
      }

      if (event === 'SIGNED_OUT') {
        state.clearUser();
        state.setAuthReady(true);
        if (!initializing) {
          ui.toast('Signed out', 'info');
        }
        if (typeof router !== 'undefined' && router.initialized) {
          router.navigate('dashboard');
        }
        updateProfileUI();
        return;
      }

      if (event === 'USER_UPDATED') {
        if (session && session.user) {
          state.setUser(session.user);
          updateProfileUI();
        }
        return;
      }

      if (event === 'PASSWORD_RECOVERY') {
        // Password reset flow — show appropriate UI
        ui.toast('Password recovery email sent. Check your inbox.', 'info', 8000);
        return;
      }
    });

    initializing = false;

    // Online/offline
    window.addEventListener('online', () => {
      ui.hideOffline();
      ui.toast('Connection restored', 'success');
    });
    window.addEventListener('offline', () => {
      ui.showOffline();
      ui.toast('You are offline', 'warning');
    });

    // Wire up profile button
    const profileBtn = document.getElementById('user-profile-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', toggleProfileMenu);
    }

    // Close profile menu when clicking outside
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('profile-menu');
      const btn = document.getElementById('user-profile-btn');
      if (menu && !menu.contains(e.target) && btn && !btn.contains(e.target)) {
        menu.classList.add('hidden');
      }
    });

    // Update profile UI based on current auth state
    updateProfileUI();
  }

  function updateProfileUI() {
    const user = state.getUser();
    const profileBtn = document.getElementById('user-profile-btn');
    const sidebarUserInfo = document.getElementById('sidebar-user-info');
    const sidebarLogout = document.getElementById('sidebar-logout');
    const sidebarUserName = document.getElementById('sidebar-user-name');
    const sidebarUserEmail = document.getElementById('sidebar-user-email');

    if (user) {
      // Signed in — show user info
      if (sidebarUserInfo) sidebarUserInfo.style.display = 'flex';
      if (sidebarLogout) sidebarLogout.style.display = 'block';
      if (sidebarUserName) sidebarUserName.textContent = user.user_metadata?.full_name || user.email || 'User';
      if (sidebarUserEmail) sidebarUserEmail.textContent = user.email || '';
      if (profileBtn) {
        profileBtn.title = 'Account: ' + (user.email || 'user');
      }
    } else {
      // Signed out — hide user info
      if (sidebarUserInfo) sidebarUserInfo.style.display = 'none';
      if (sidebarLogout) sidebarLogout.style.display = 'none';
      if (profileBtn) {
        profileBtn.title = 'Sign in';
      }
    }
  }

  function toggleProfileMenu() {
    const user = state.getUser();
    let menu = document.getElementById('profile-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'profile-menu';
      menu.className = 'profile-menu hidden';
      document.body.appendChild(menu);
    }

    if (user) {
      menu.innerHTML = `
        <div class="profile-menu-header">
          <div class="profile-menu-avatar">
            <i class="fas fa-user-circle"></i>
          </div>
          <div class="profile-menu-info">
            <div class="profile-menu-name">${escapeHtml(user.user_metadata?.full_name || user.email || 'User')}</div>
            <div class="profile-menu-email">${escapeHtml(user.email || '')}</div>
          </div>
        </div>
        <div class="profile-menu-divider"></div>
        <button class="profile-menu-item" onclick="auth.openSettings()">
          <i class="fas fa-cog"></i> Account settings
        </button>
        <button class="profile-menu-item" onclick="auth.openProfile()">
          <i class="fas fa-user"></i> Profile
        </button>
        <div class="profile-menu-divider"></div>
        <button class="profile-menu-item danger" onclick="auth.handleSignOut()">
          <i class="fas fa-sign-out-alt"></i> Sign out
        </button>
      `;
    } else {
      menu.innerHTML = `
        <div class="profile-menu-header">
          <div class="profile-menu-avatar">
            <i class="fas fa-user-circle"></i>
          </div>
          <div class="profile-menu-info">
            <div class="profile-menu-name">Not signed in</div>
            <div class="profile-menu-email">Create an account or sign in</div>
          </div>
        </div>
        <div class="profile-menu-divider"></div>
        <button class="profile-menu-item" onclick="auth.openModal()">
          <i class="fas fa-sign-in-alt"></i> Sign in
        </button>
        <button class="profile-menu-item" onclick="auth.switchTab('signup')">
          <i class="fas fa-user-plus"></i> Create account
        </button>
      `;
    }

    // Position menu below the profile button
    const btn = document.getElementById('user-profile-btn');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.right = Math.max(0, window.innerWidth - rect.right - 8) + 'px';
    }

    menu.classList.toggle('hidden');
  }

  function openModal() {
    // Check config before opening modal
    if (!checkSupabaseConfig()) {
      return;
    }
    // Close profile menu if open
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');
    modal.classList.remove('hidden');
    renderForm();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  function openSettings() {
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');
    closeModal();
    // Navigate to settings
    if (typeof router !== 'undefined' && router.initialized) {
      router.navigate('settings');
    }
  }

  function openProfile() {
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');
    closeModal();
  }

  function switchTab(tab) {
    currentTab = tab;
    renderForm();
    document.querySelectorAll('.auth-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
  }

  function renderForm() {
    if (currentTab === 'login') {
      formContainer.innerHTML = `
        <div class="input-field">
          <input type="email" id="login-email" placeholder="Email" required>
          <label for="login-email">Email</label>
        </div>
        <div class="input-field">
          <input type="password" id="login-password" placeholder="Password" required>
          <label for="login-password">Password</label>
        </div>
        <button class="btn btn-primary w-full" onclick="auth.handleLogin()">Sign in</button>
        <p class="auth-help" style="text-align:center; margin-top:var(--space-2);">Don't have an account? <span style="cursor:pointer; color:var(--color-primary);" onclick="auth.switchTab('signup')">Create one</span></p>
        <p class="auth-help" style="text-align:center; margin-top:var(--space-1); cursor:pointer; color:var(--color-text-variant);" onclick="auth.handleReset()">Forgot password?</p>
      `;
    } else {
      formContainer.innerHTML = `
        <div class="input-field">
          <input type="email" id="signup-email" placeholder="Email" required>
          <label for="signup-email">Email</label>
        </div>
        <div class="input-field">
          <input type="password" id="signup-password" placeholder="Password" required>
          <label for="signup-password">Password (min 6 chars)</label>
        </div>
        <div class="input-field">
          <input type="text" id="signup-name" placeholder="Full name">
          <label for="signup-name">Full name</label>
        </div>
        <button class="btn btn-primary w-full" onclick="auth.handleSignup()">Create account</button>
        <p class="auth-help" style="text-align:center; margin-top:var(--space-2);">Already have an account? <span style="cursor:pointer; color:var(--color-primary);" onclick="auth.switchTab('login')">Sign in</span></p>
      `;
    }
  }

  async function handleLogin() {
    if (!checkSupabaseConfig()) return;
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    if (!email || !password) {
      ui.toast('Please enter email and password', 'error');
      return;
    }
    ui.setLoading(true);
    interactiveSignIn = true;
    try {
      const { data, error } = await CORPUS_SUPABASE.signIn(email, password);
      if (error) {
        ui.toast(error.message || 'Login failed', 'error');
        return;
      }

      // CRITICAL: Require an active session — not just a user object.
      // If email confirmation or MFA is required, data.session will be null.
      if (data && data.session && data.session.user) {
        state.setUser(data.session.user);
        state.setAuthReady(true);
        ui.toast('Welcome back!', 'success');
        closeModal();
        // Navigate to dashboard only if router is initialized
        if (typeof router !== 'undefined' && router.initialized) {
          router.navigate('dashboard');
        }
        interactiveSignIn = false;
        updateProfileUI();
      } else if (data && data.user) {
        interactiveSignIn = false;
        // User exists but no active session — likely email confirmation required
        ui.toast('Account requires email confirmation. Please check your inbox before signing in.', 'info', 10000);
      } else {
        interactiveSignIn = false;
        ui.toast('Login failed: no session returned', 'error');
      }
    } catch (err) {
      ui.toast(err.message || 'Login failed', 'error');
    } finally {
      interactiveSignIn = false;
      ui.setLoading(false);
    }
  }

  async function handleSignup() {
    if (!checkSupabaseConfig()) return;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const name = document.getElementById('signup-name').value;
    if (!email || !password) {
      ui.toast('Please enter email and password', 'error');
      return;
    }
    if (password.length < 6) {
      ui.toast('Password must be at least 6 characters', 'error');
      return;
    }
    ui.setLoading(true);
    interactiveSignIn = true;
    try {
      const { data, error } = await CORPUS_SUPABASE.signUp(email, password, { full_name: name });
      if (error) {
        ui.toast(error.message || 'Signup failed', 'error');
        return;
      }

      // Only set user if Supabase returned an active session.
      // If email confirmation is required, data.session will be null.
      if (data && data.session && data.session.user) {
        state.setUser(data.session.user);
        state.setAuthReady(true);
        ui.toast('Account created and signed in!', 'success');
        closeModal();
        if (typeof router !== 'undefined' && router.initialized) {
          router.navigate('dashboard');
        }
        interactiveSignIn = false;
        updateProfileUI();
      } else {
        // Email confirmation required — do NOT pretend the user is signed in
        interactiveSignIn = false;
        ui.toast('Account created! Please check your email to confirm your address before signing in.', 'info', 10000);
        closeModal();
        updateProfileUI();
      }
    } catch (err) {
      ui.toast(err.message || 'Signup failed', 'error');
    } finally {
      ui.setLoading(false);
    }
  }

  async function handleReset() {
    if (!checkSupabaseConfig()) return;
    const email = prompt('Enter your email to reset password:');
    if (!email) return;
    ui.setLoading(true);
    try {
      await CORPUS_SUPABASE.resetPassword(email);
      ui.toast('Password reset email sent', 'success');
    } catch (err) {
      ui.toast(err.message || 'Reset failed', 'error');
    } finally {
      ui.setLoading(false);
    }
  }

  async function handleSignOut() {
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');
    try {
      await CORPUS_SUPABASE.signOut();
    } catch (err) {
      ui.toast(err.message || 'Sign out failed', 'error');
    }
  }

  // Expose
  return {
    init,
    openModal,
    closeModal,
    switchTab,
    handleLogin,
    handleSignup,
    handleReset,
    handleSignOut,
    openSettings,
    openProfile,
    toggleProfileMenu,
    updateProfileUI,
    checkSupabaseConfig,
  };
})();

// Alias for UI
window.ui = window.ui || {};
window.ui.closeAuth = () => auth.closeModal();
window.ui.showOffline = () => {
  const b = document.getElementById('offline-banner');
  if (b) b.classList.remove('hidden');
};
window.ui.hideOffline = () => {
  const b = document.getElementById('offline-banner');
  if (b) b.classList.add('hidden');
};
window.ui.setLoading = (loading) => {
  document.body.classList.toggle('loading', loading);
};

// Helper
function escapeHtml(text) {
  if (text == null) return '';
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}