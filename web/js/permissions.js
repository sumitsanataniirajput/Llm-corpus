// What the signed-in staff member may see and do. This only hides controls for
// convenience — the database enforces every permission again on each request.

let access = { staff: null, role: null, permissions: [], settings: {}, session_timeout_min: 30 };
const set = new Set();

export function setAccess(a) {
  access = a || { staff: null, role: null, permissions: [], settings: {}, session_timeout_min: 30 };
  set.clear(); for (const p of access.permissions ?? []) set.add(p);
}
export const getAccess = () => access;
export const me = () => access.staff;
export const roleCode = () => access.role?.code ?? null;
export const setting = (key, fallback = null) => (access.settings && key in access.settings ? access.settings[key] : fallback);

/** can('drivers.view') or can('finance.view|drivers.view') = any of them. */
export function can(code) {
  if (!code) return true;
  return String(code).split('|').some((c) => set.has(c.trim()));
}

/** Remove elements the user may not use: <button data-perm="rides.cancel">. */
export function applyPermissions(root = document) {
  root.querySelectorAll('[data-perm]').forEach((el) => { if (!can(el.dataset.perm)) el.remove(); });
}

/** Navigation definition. `perm` decides visibility; `bottom` marks the mobile bottom bar. */
export const NAV = [
  { group: 'Operations' },
  { id: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', perm: 'dashboard.view', bottom: true },
  { id: 'live-tracking', label: 'Live Tracking', icon: 'fa-location-crosshairs', perm: 'tracking.view', bottom: true },
  { id: 'rides', label: 'Rides', icon: 'fa-route', perm: 'rides.view', bottom: true },
  { id: 'otp-verification', label: 'OTP Verification', icon: 'fa-key', perm: 'otp.view', bottom: true },
  { group: 'People & Fleet' },
  { id: 'drivers', label: 'Drivers', icon: 'fa-id-card', perm: 'drivers.view' },
  { id: 'vehicles', label: 'Vehicles', icon: 'fa-car-side', perm: 'vehicles.view' },
  { id: 'customers', label: 'Customers', icon: 'fa-users', perm: 'customers.view' },
  { group: 'Business' },
  { id: 'finance', label: 'Finance', icon: 'fa-indian-rupee-sign', perm: 'finance.view' },
  { id: 'pricing', label: 'Pricing', icon: 'fa-tags', perm: 'pricing.view' },
  { id: 'services', label: 'Services', icon: 'fa-layer-group', perm: 'services.view' },
  { id: 'marketing', label: 'Offers & Marketing', icon: 'fa-bullhorn', perm: 'marketing.view' },
  { id: 'analytics', label: 'Analytics & AI', icon: 'fa-chart-line', perm: 'analytics.view|ai.view' },
  { group: 'Care & Safety' },
  { id: 'support', label: 'Support & Safety', icon: 'fa-life-ring', perm: 'support.view|safety.view', badge: 'emergencies' },
  { id: 'notifications', label: 'Notifications', icon: 'fa-bell', perm: 'notifications.view|notifications.send' },
  { group: 'Administration' },
  { id: 'staff', label: 'Staff & Roles', icon: 'fa-user-shield', perm: 'staff.view' },
  { id: 'locations', label: 'Cities & Zones', icon: 'fa-map-location-dot', perm: 'locations.view' },
  { id: 'security', label: 'Security', icon: 'fa-shield-halved', perm: null },
  { id: 'settings', label: 'Settings', icon: 'fa-gear', perm: 'settings.view' },
];
export const routes = () => NAV.filter((n) => n.id);
export const firstAllowedRoute = () => routes().find((r) => can(r.perm))?.id ?? 'security';
