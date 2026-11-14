// Application entry point: checks configuration, handles sign-in, builds the shell
// (sidebar, top bar, search, notifications) and starts the router.
import { sb, configProblem, config, rpc, toAppError } from './js/supabase-client.js';
import * as auth from './js/auth.js';
import { NAV, can, getAccess, me, setting } from './js/permissions.js';
import { startRouter, onRoute, navigate } from './js/router.js';
import { initNotifications, onEmergencyCount } from './js/notifications.js';
import { toast, showError, withBusy } from './js/components.js';
import { refreshChartTheme } from './js/charts.js';
import { esc, initials, debounce } from './js/utilities.js';
import { rules } from './js/validation.js';

const $ = (s) => document.querySelector(s);
const show = (el, on = true) => { el.hidden = !on; };

// ---------- configuration check ----------
const PROBLEMS = {
  missing: ['Configuration file missing', `<p>The file <code>js/config.js</code> was not found.</p><ol><li>Open the <code>js</code> folder.</li><li>Make a copy of <code>config.example.js</code> and name it <code>config.js</code>.</li><li>Paste your Supabase Project URL and anon public key into it.</li><li>Reload this page.</li></ol>`],
  placeholder: ['Configuration not filled in', `<p><code>js/config.js</code> still contains the example values.</p><ol><li>Supabase Dashboard › Project Settings › API.</li><li>Copy <b>Project URL</b> into <code>SUPABASE_URL</code>.</li><li>Copy the <b>anon public</b> key into <code>SUPABASE_ANON_KEY</code>.</li><li>Save and reload.</li></ol>`],
  bad_url: ['Supabase URL looks wrong', '<p><code>SUPABASE_URL</code> must look like <code>https://abcdefgh.supabase.co</code>.</p>'],
  service_key: ['Unsafe key detected — the console will not start', '<p>The key in <code>js/config.js</code> is a <b>service_role / secret</b> key. That key bypasses all security and must never be placed in a website.</p><ol><li>Replace it with the <b>anon public</b> key.</li><li>In Supabase, <b>rotate</b> the exposed secret key immediately (Project Settings › API).</li></ol>'],
  sdk: ['A required library did not load', '<p>The Supabase library could not be downloaded. Check your internet connection or any content blocker, then reload.</p>'],
};
function bootMessage(title, html, spinner = false) { show($('#boot-screen')); show($('#boot-spinner'), spinner); $('#boot-title').textContent = title; $('#boot-message').innerHTML = html; }

// ---------- theme ----------
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('rms.theme', theme); } catch { /* private mode */ }
  const icon = $('#theme-toggle i'); if (icon) icon.className = `fa-solid ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121a2b' : '#2563eb');
  refreshChartTheme();
  window.dispatchEvent(new CustomEvent('rms:theme', { detail: theme }));
}

// ---------- auth screens ----------
const forms = ['#login-form', '#mfa-form', '#mfa-enrol-form', '#recovery-form'];
const showForm = (id) => { show($('#boot-screen'), false); show($('#app'), false); show($('#auth-screen')); forms.forEach((f) => show($(f), f === id)); $(`${id} input`)?.focus(); };
const setError = (id, msg) => { const e = $(id); e.textContent = msg ?? ''; show(e, !!msg); };
let pendingFactor = null, enrolFactor = null;

async function handleStep(result) {
  if (result.step === 'mfa') { pendingFactor = result.factorId; showForm('#mfa-form'); return; }
  if (result.step === 'enrol') {
    showForm('#mfa-enrol-form');
    const e = await auth.enrolMfaStart(); enrolFactor = e.factorId;
    $('#mfa-enrol-qr').innerHTML = `<img alt="QR code for your authenticator app" src="${esc(e.qr)}">`; $('#mfa-enrol-secret').textContent = e.secret;
    return;
  }
  startApp();
}
function wireAuth() {
  $('#toggle-password').onclick = () => { const i = $('#login-password'); const on = i.type === 'password'; i.type = on ? 'text' : 'password'; $('#toggle-password i').className = `fa-regular ${on ? 'fa-eye-slash' : 'fa-eye'}`; };
  $('#login-form').addEventListener('submit', (ev) => { ev.preventDefault(); withBusy($('#login-submit'), async () => {
    setError('#login-error');
    const email = $('#login-email').value.trim(), password = $('#login-password').value;
    if (rules.required(email) || rules.email(email)) { setError('#login-error', 'Enter your work e-mail address.'); return; }
    if (!password) { setError('#login-error', 'Enter your password.'); return; }
    try { await handleStep(await auth.signIn(email, password)); $('#login-password').value = ''; }
    catch (e) { setError('#login-error', toAppError(e).message); }
  }); });
  $('#forgot-password').onclick = async () => {
    const r = await window.Swal.fire({ title: 'Reset password', input: 'email', inputLabel: 'Your work e-mail', inputValue: $('#login-email').value, showCancelButton: true, confirmButtonText: 'Send reset link' });
    if (!r.isConfirmed || !r.value) return;
    try { await auth.requestPasswordReset(r.value); } catch (e) { toast('error', toAppError(e).message); return; }
    window.Swal.fire({ icon: 'info', title: 'Check your e-mail', text: 'If a staff account exists for that address, a reset link has been sent. The link works once and expires.' });
  };
  $('#mfa-form').addEventListener('submit', (ev) => { ev.preventDefault(); withBusy($('#mfa-form button[type=submit]'), async () => {
    setError('#mfa-error');
    try { await handleStep(await auth.verifyMfa(pendingFactor, $('#mfa-code').value)); } catch (e) { setError('#mfa-error', toAppError(e).message); $('#mfa-code').value = ''; $('#mfa-code').focus(); }
  }); });
  $('#mfa-enrol-form').addEventListener('submit', (ev) => { ev.preventDefault(); withBusy($('#mfa-enrol-form button[type=submit]'), async () => {
    setError('#mfa-enrol-error');
    try { await auth.enrolMfaVerify(enrolFactor, $('#mfa-enrol-code').value); await handleStep(await auth.continueSession()); } catch (e) { setError('#mfa-enrol-error', toAppError(e).message); }
  }); });
  $('#mfa-cancel').onclick = () => auth.signOut();
  $('#mfa-enrol-cancel').onclick = () => auth.signOut();
  $('#recovery-form').addEventListener('submit', (ev) => { ev.preventDefault(); withBusy($('#recovery-form button[type=submit]'), async () => {
    setError('#recovery-error');
    const a = $('#recovery-password').value, b = $('#recovery-password2').value;
    const bad = rules.required(a) || rules.password(a) || (a !== b ? 'The two passwords do not match.' : null);
    if (bad) { setError('#recovery-error', bad); return; }
    try { await auth.setNewPassword(a); toast('success', 'Password saved.'); history.replaceState(null, '', location.pathname); await handleStep(await auth.continueSession()); }
    catch (e) { setError('#recovery-error', toAppError(e).message); }
  }); });
}

// ---------- shell ----------
let started = false;
function buildNav() {
  const items = []; let pendingGroup = null;
  for (const n of NAV) {
    if (n.group) { pendingGroup = n.group; continue; }
    if (!can(n.perm)) continue;
    if (pendingGroup) { items.push(`<div class="nav-group">${esc(pendingGroup)}</div>`); pendingGroup = null; }
    items.push(`<a class="nav-item" href="#/${n.id}" data-route="${n.id}" title="${esc(n.label)}"><i class="fa-solid ${n.icon}"></i><span>${esc(n.label)}</span>${n.badge ? `<b class="nav-badge" data-badge="${n.badge}" hidden></b>` : ''}</a>`);
  }
  $('#nav').innerHTML = items.join('');
  const bottom = NAV.filter((n) => n.id && n.bottom && can(n.perm)).slice(0, 4);
  $('#bottom-nav').innerHTML = bottom.map((n) => `<a href="#/${n.id}" data-route="${n.id}"><i class="fa-solid ${n.icon}"></i>${esc(n.label.split(' ')[0])}</a>`).join('')
    + '<a href="#" data-more><i class="fa-solid fa-ellipsis"></i>More</a>';
}
function applyBranding() {
  const name = setting('brand.app_name', 'Ride Manager') || 'Ride Manager';
  document.querySelectorAll('[data-brand-name]').forEach((e) => { e.textContent = name; });
  const logo = setting('brand.logo_url', '');
  if (logo && /^https:\/\//.test(logo)) $('#brand-logo').innerHTML = `<img src="${esc(logo)}" alt="">`;
  const color = setting('brand.primary_color', '');
  if (/^#[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== '#2563eb' && document.documentElement.getAttribute('data-theme') !== 'dark') document.documentElement.style.setProperty('--primary', color);
  const ann = [setting('system.maintenance_mode', false) ? 'Maintenance mode is ON — the Driver and Customer apps show a maintenance notice.' : '', setting('system.global_announcement', '')].filter(Boolean).join('  •  ');
  $('#announcement-bar').textContent = ann; show($('#announcement-bar'), !!ann);
  const env = String(config.ENVIRONMENT || '').toLowerCase();
  if (env && env !== 'production') { $('#env-badge').textContent = `${env.toUpperCase()} ENVIRONMENT`; show($('#env-badge')); }
}
function wireShell() {
  const app = $('#app');
  if (localStorage.getItem('rms.sidebar') === 'collapsed') app.classList.add('collapsed');
  $('#sidebar-collapse').onclick = () => { app.classList.toggle('collapsed'); localStorage.setItem('rms.sidebar', app.classList.contains('collapsed') ? 'collapsed' : 'open'); window.dispatchEvent(new Event('resize')); };
  const closeMenu = () => { app.classList.remove('menu-open'); show($('#sidebar-backdrop'), false); };
  $('#menu-toggle').onclick = () => { app.classList.add('menu-open'); show($('#sidebar-backdrop')); };
  $('#sidebar-backdrop').onclick = closeMenu;
  $('#bottom-nav').addEventListener('click', (e) => { if (e.target.closest('[data-more]')) { e.preventDefault(); $('#menu-toggle').click(); } });
  $('#theme-toggle').onclick = () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  onRoute((def) => { closeMenu(); document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === def.id)); });

  // profile menu
  const staff = me();
  $('#profile-name').textContent = staff.full_name; $('#profile-role').textContent = getAccess().role.name; $('#profile-avatar').textContent = initials(staff.full_name);
  const pp = $('#profile-panel');
  $('#profile-toggle').onclick = (e) => { e.stopPropagation(); pp.hidden = !pp.hidden; };
  document.addEventListener('click', (e) => { if (!pp.hidden && !pp.contains(e.target)) pp.hidden = true; });
  pp.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]'); if (e.target.closest('a')) pp.hidden = true; if (!b) return;
    pp.hidden = true;
    if (b.dataset.action === 'logout') { auth.signOut(); return; }
    try { await rpc('staff_attendance', { p_action: b.dataset.action === 'attendance-in' ? 'check_in' : 'check_out' }); toast('success', b.dataset.action === 'attendance-in' ? 'Checked in.' : 'Checked out.'); }
    catch (err) { showError(err); }
  });

  // global search
  const input = $('#global-search-input'), box = $('#global-search-results');
  const ICON = { booking: 'fa-route', driver: 'fa-id-card', customer: 'fa-user', vehicle: 'fa-car-side', staff: 'fa-user-shield', ticket: 'fa-life-ring' };
  const PAGE = { booking: 'rides', driver: 'drivers', customer: 'customers', vehicle: 'vehicles', staff: 'staff', ticket: 'support' };
  let seq = 0;
  const run = debounce(async () => {
    const q = input.value.trim(); const mine = ++seq;
    if (q.length < 2) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '<div class="state" style="padding:16px"><div class="spinner" style="margin:0 auto"></div></div>';
    try {
      const hits = await rpc('global_search', { p_query: q }); if (mine !== seq) return;
      box.innerHTML = hits?.length ? hits.map((h) => `<a class="search-hit" href="#/${PAGE[h.type] ?? 'dashboard'}?id=${encodeURIComponent(h.id)}"><i class="fa-solid ${ICON[h.type] ?? 'fa-circle'}"></i><span><strong>${esc(h.title)}</strong><small>${esc(h.subtitle ?? '')}</small></span></a>`).join('')
        : '<div class="state" style="padding:18px"><p style="margin:0">No results in the records you are allowed to see.</p></div>';
    } catch (e) { if (mine === seq) box.innerHTML = `<div class="state error" style="padding:18px"><p style="margin:0">${esc(toAppError(e).message)}</p></div>`; }
  }, 300);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { box.hidden = true; input.blur(); } if (e.key === 'Enter') { const first = box.querySelector('.search-hit'); if (first) { location.hash = first.getAttribute('href'); box.hidden = true; input.value = ''; } } });
  box.addEventListener('click', (e) => { if (e.target.closest('.search-hit')) { box.hidden = true; input.value = ''; } });
  document.addEventListener('click', (e) => { if (!$('#global-search').contains(e.target)) box.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '') && !document.querySelector('.modal-backdrop')) { e.preventDefault(); input.focus(); } });

  // realtime + network status
  const conn = $('#connection-status');
  const setConn = (cls, text) => { conn.className = `conn ${cls}`; conn.querySelector('span').textContent = text; conn.title = `Realtime: ${text}`; };
  initNotifications({ toggle: $('#notif-toggle'), panelEl: $('#notif-panel'), count: $('#notif-count'), emergency: $('#emergency-bar'),
    onStatus: (s) => { if (s === 'SUBSCRIBED') setConn('ok', 'Live'); else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setConn('bad', 'Realtime off'); else if (s === 'CLOSED') setConn('warn', 'Reconnecting'); } });
  window.addEventListener('offline', () => { setConn('bad', 'Offline'); toast('warning', 'You are offline. Data on screen may be out of date.'); });
  window.addEventListener('online', () => { setConn('warn', 'Reconnecting'); toast('success', 'Back online.'); navigate(location.hash.replace(/^#\//, '').split('?')[0]); });
  onEmergencyCount((n) => document.querySelectorAll('[data-badge="emergencies"]').forEach((b) => { b.textContent = n; b.hidden = !n; }));
  window.addEventListener('rms:session-expired', () => auth.signOut('Your session has expired. Please sign in again.'), { once: true });
}

function startApp() {
  if (started) return; started = true;
  show($('#auth-screen'), false); show($('#boot-screen'), false); show($('#app'));
  buildNav(); applyBranding(); wireShell();
  startRouter($('#content'));
}

// ---------- boot ----------
async function boot() {
  setTheme(document.documentElement.getAttribute('data-theme') || 'light');
  const problem = configProblem();
  if (problem) { const [t, h] = PROBLEMS[problem]; bootMessage(t, h); return; }
  if (!window.Chart || !window.Swal) { bootMessage(...PROBLEMS.sdk); return; }
  bootMessage('Starting…', '', true);
  wireAuth();

  const reason = sessionStorage.getItem('rms.signout_reason');
  if (reason) { sessionStorage.removeItem('rms.signout_reason'); setTimeout(() => setError('#login-error', reason), 0); }

  let recovering = /type=recovery/.test(location.hash) || /type=invite/.test(location.hash);
  auth.onAuthChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; showForm('#recovery-form'); }
    if (event === 'SIGNED_OUT' && started) location.reload();
  });
  try {
    const { data } = await sb.auth.getSession();
    if (recovering && data?.session) { showForm('#recovery-form'); return; }
    if (!data?.session) { showForm('#login-form'); return; }
    await handleStep(await auth.continueSession());
  } catch (e) {
    showForm('#login-form'); setError('#login-error', toAppError(e).message);
  }
}
window.addEventListener('unhandledrejection', (e) => { const m = String(e.reason?.message ?? e.reason ?? ''); if (m && !/AbortError|ResizeObserver/.test(m)) rpc('log_client_error', { p_source: 'web', p_level: 'error', p_message: m.slice(0, 500), p_context: { route: location.hash } }).catch(() => {}); });
boot();
