// Hash router:  #/drivers?tab=queue&id=...   ->  pages/drivers.html + js/pages/drivers.js
// Each page module exports  init(container, ctx)  and may return a cleanup function
// (to stop timers / realtime subscriptions) that runs when the user leaves the page.
import { routes, can, firstAllowedRoute } from './permissions.js';
import { loadingState, errorState, emptyState } from './components.js';
import { destroyCharts } from './charts.js';
import { rpc } from './supabase-client.js';

const templates = new Map();
let cleanup = null, token = 0, container = null;
const listeners = new Set();

export function parseHash(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { route: path.split('/')[0] || '', params: Object.fromEntries(new URLSearchParams(query)) };
}
export function navigate(route, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString();
  const target = `#/${route}${q ? `?${q}` : ''}`;
  if (location.hash === target) render(); else location.hash = target;
}
/** Update the query string without re-rendering the page (e.g. remember the open tab). */
export function setParams(params) {
  const cur = parseHash(); const merged = { ...cur.params, ...params };
  const q = new URLSearchParams(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString();
  history.replaceState(null, '', `#/${cur.route}${q ? `?${q}` : ''}`);
}
export const onRoute = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function template(id) {
  if (!templates.has(id)) {
    const res = await fetch(`pages/${id}.html`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Page file pages/${id}.html is missing (HTTP ${res.status}). Upload every file listed in HOPEWEB-GUIDE.md.`);
    templates.set(id, await res.text());
  }
  return templates.get(id);
}

async function render() {
  const mine = ++token;
  const { route, params } = parseHash();
  const def = routes().find((r) => r.id === route);
  if (!def) { navigate(firstAllowedRoute()); return; }
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error('page cleanup', e); } }
  cleanup = null; destroyCharts(container);
  document.querySelectorAll('#modal-root > *').forEach((m) => m.remove());
  listeners.forEach((fn) => fn(def));
  document.title = `${def.label} · ${document.querySelector('[data-brand-name]')?.textContent ?? 'Ride Manager'}`;
  if (!can(def.perm)) {
    container.innerHTML = emptyState({ icon: 'fa-lock', title: 'You do not have access to this page', text: 'Ask an administrator if you need this permission. The attempt has not changed any data.' });
    return;
  }
  container.innerHTML = loadingState();
  try {
    const [html, mod] = await Promise.all([template(def.id), import(`./pages/${def.id}.js`)]);
    if (mine !== token) return;
    container.innerHTML = html;
    container.scrollTop = 0; window.scrollTo({ top: 0 });
    const c = await mod.init(container, { params, navigate, setParams });
    if (mine === token) cleanup = c; else if (typeof c === 'function') c();
  } catch (e) {
    if (mine !== token) return;
    console.error(e);
    container.innerHTML = errorState(e, true);
    container.querySelector('[data-retry]')?.addEventListener('click', render);
    rpc('log_client_error', { p_source: 'web', p_level: 'error', p_message: String(e?.message ?? e).slice(0, 500), p_context: { route: def.id } }).catch(() => {});
  }
}

export function startRouter(el) {
  container = el;
  window.addEventListener('hashchange', render);
  if (!parseHash().route) navigate(firstAllowedRoute()); else render();
}
