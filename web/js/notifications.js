// In-app notification centre (Supabase Realtime) + optional browser push (FCM).
// Emergency notifications are visually and behaviourally different from ordinary ones.
import { sb, rpc, config, toAppError } from './supabase-client.js';
import { subscribe, countOf } from './api.js';
import { me, can } from './permissions.js';
import { esc, ago } from './utilities.js';
import { toast, emptyState } from './components.js';

const ICONS = { booking: 'fa-route', payment: 'fa-indian-rupee-sign', document: 'fa-file-circle-check', approval: 'fa-user-check', emergency: 'fa-triangle-exclamation', otp: 'fa-key', system: 'fa-gear', marketing: 'fa-bullhorn', support: 'fa-life-ring', tracking: 'fa-location-crosshairs' };
const PAGE_FOR = { booking: 'rides', payment: 'finance', document: 'drivers', approval: 'drivers', emergency: 'support', otp: 'otp-verification', support: 'support', tracking: 'live-tracking' };
let items = [], unsub = null, panel, countEl, emergencyBar;
const emergencyListeners = new Set();
export const onEmergencyCount = (fn) => { emergencyListeners.add(fn); return () => emergencyListeners.delete(fn); };

async function load() {
  const { data, error } = await sb.from('notifications').select('id,title,body,category,priority,read_at,created_at,data')
    .eq('recipient_staff_id', me().id).order('created_at', { ascending: false }).limit(40);
  if (error) throw toAppError(error);
  items = data ?? [];
  render();
}
function render() {
  const unread = items.filter((n) => !n.read_at).length;
  countEl.hidden = unread === 0; countEl.textContent = unread > 99 ? '99+' : String(unread);
  if (panel.hidden) return;
  panel.innerHTML = `<div class="notif-head"><strong>Notifications</strong><button class="btn btn-sm btn-ghost" data-read-all ${unread ? '' : 'disabled'}>Mark all read</button></div>
    <div class="notif-list">${items.length ? items.map((n) => `<a class="notif-item ${n.read_at ? '' : 'unread'} ${n.priority === 'emergency' ? 'emergency' : ''}" href="#/${esc(PAGE_FOR[n.category] ?? 'notifications')}" data-id="${esc(n.id)}">
      <span class="ico"><i class="fa-solid ${ICONS[n.category] ?? 'fa-bell'}"></i></span><span><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p><time>${esc(ago(n.created_at))}</time></span></a>`).join('')
    : emptyState({ icon: 'fa-bell-slash', title: 'No notifications', text: 'Alerts about rides, payments, documents and emergencies appear here.' })}</div>`;
}
async function markRead(ids = null) {
  try { await rpc('mark_notifications_read', ids ? { p_ids: ids } : {}); const now = new Date().toISOString(); items.forEach((n) => { if (!ids || ids.includes(n.id)) n.read_at ??= now; }); render(); }
  catch (e) { toast('error', toAppError(e).message); }
}

async function refreshEmergencies() {
  if (!can('safety.view')) return;
  try {
    const open = await countOf('safety_incidents', (q) => q.in('status', ['open', 'acknowledged']).in('severity', ['critical', 'high']));
    emergencyListeners.forEach((fn) => fn(open));
    emergencyBar.hidden = open === 0;
    if (open) emergencyBar.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${open} open emergency incident${open > 1 ? 's' : ''} need${open > 1 ? '' : 's'} attention</span><a href="#/support?tab=incidents">Open safety centre</a>`;
  } catch { /* the bar simply stays as it was */ }
}

export function initNotifications({ toggle, panelEl, count, emergency, onStatus }) {
  panel = panelEl; countEl = count; emergencyBar = emergency;
  toggle.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) render(); });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-read-all]')) { e.preventDefault(); markRead(); return; }
    const a = e.target.closest('[data-id]'); if (a) { markRead([a.dataset.id]); panel.hidden = true; }
  });
  document.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true; });
  load().catch((e) => console.warn('notifications', e.message));
  refreshEmergencies();
  const tables = [{ table: 'notifications', event: 'INSERT', filter: `recipient_staff_id=eq.${me().id}` }];
  if (can('safety.view')) tables.push({ table: 'safety_incidents' });
  unsub = subscribe('shell', tables, (p) => {
    if (p.table === 'safety_incidents') { refreshEmergencies(); return; }
    const n = p.new; items.unshift(n); items = items.slice(0, 40); render();
    if (n.priority === 'emergency') {
      window.Swal.fire({ icon: 'error', title: n.title, text: n.body, confirmButtonText: 'Open safety centre', showCancelButton: true, cancelButtonText: 'Dismiss', customClass: { confirmButton: 'danger' } })
        .then((r) => { if (r.isConfirmed) location.hash = '#/support?tab=incidents'; });
      try { navigator.vibrate?.([200, 100, 200]); } catch { /* not supported */ }
    } else toast(n.priority === 'high' ? 'warning' : 'info', `${n.title} — ${n.body}`);
  }, onStatus);
  return () => unsub?.();
}

// ---------- browser push (optional) ----------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushConfigured = () => !!(config.FIREBASE && config.FIREBASE.apiKey && config.FIREBASE_VAPID_KEY);
const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Could not load ${src}`)); document.head.appendChild(s); });
/** Ask permission and register this browser for push. Returns a status string. */
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';
  if (!pushConfigured()) return 'not_configured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  await loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
  await loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');
  const app = window.firebase.apps.length ? window.firebase.app() : window.firebase.initializeApp(config.FIREBASE);
  const reg = await navigator.serviceWorker.register(`firebase-messaging-sw.js?c=${encodeURIComponent(JSON.stringify(config.FIREBASE))}`);
  const token = await window.firebase.messaging(app).getToken({ vapidKey: config.FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) return 'failed';
  const { data: u } = await sb.auth.getUser();
  const { error } = await sb.from('device_tokens').upsert({ user_id: u.user.id, app: 'manager', platform: 'web', token, last_seen_at: new Date().toISOString() }, { onConflict: 'token' });
  if (error) throw toAppError(error);
  window.firebase.messaging(app).onMessage((m) => toast('info', `${m.notification?.title ?? 'Notification'} — ${m.notification?.body ?? ''}`));
  return 'enabled';
}
