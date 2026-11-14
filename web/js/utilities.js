// Pure helpers: formatting, escaping, dates, CSV, money. No DOM state, no network.

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for safe insertion into HTML. Use for EVERY value that comes from the database. */
export const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => HTML_ESC[c]));
export const dash = (v) => (v === null || v === undefined || v === '' ? '—' : esc(v));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-IN');

/** Money is stored as integer paise. Formatting is the only place a decimal appears. */
export function money(paise, { compact = false } = {}) {
  if (paise === null || paise === undefined || paise === '') return '—';
  const p = typeof paise === 'bigint' ? paise : BigInt(Math.trunc(Number(paise)));
  const neg = p < 0n; const abs = neg ? -p : p;
  const rupees = Number(abs / 100n), frac = Number(abs % 100n);
  if (compact && rupees >= 100000) return `${neg ? '-' : ''}₹${(rupees / 100000).toFixed(rupees >= 10000000 ? 0 : 2)} L`;
  const s = frac === 0 && compact ? inr0.format(rupees) : inr.format(rupees + frac / 100);
  return neg ? `-${s}` : s;
}
/** "125.50" -> 12550 without floating-point maths. Returns null when the text is not a valid amount. */
export function rupeesToPaise(text) {
  const m = /^\s*(-?)(\d{1,10})(?:\.(\d{1,2}))?\s*$/.exec(String(text ?? '').replace(/[₹,]/g, ''));
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -v : v;
}
export const paiseToRupeesText = (p) => (p === null || p === undefined ? '' : (Math.trunc(Number(p)) / 100).toFixed(2));
export const number = (v) => (v === null || v === undefined || v === '' ? '—' : num.format(Number(v)));
export const km = (v) => (v === null || v === undefined || v === '' ? '—' : `${Number(v).toFixed(Number(v) < 10 ? 2 : 1)} km`);
export const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(d)}%`);
/** Basis points (10000 = 100% / 1.00x). */
export const bpToPct = (bp) => (bp === null || bp === undefined ? '—' : `${(Number(bp) / 100).toFixed(2).replace(/\.?0+$/, '')}%`);
export const bpToX = (bp) => (bp === null || bp === undefined ? '—' : `${(Number(bp) / 10000).toFixed(2)}×`);

const dt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const d = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const t = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
const valid = (v) => { if (!v) return null; const x = new Date(v); return Number.isNaN(x.getTime()) ? null : x; };
export const dateTime = (v) => { const x = valid(v); return x ? dt.format(x) : '—'; };
export const date = (v) => { const x = valid(typeof v === 'string' && v.length === 10 ? `${v}T00:00:00` : v); return x ? d.format(x) : '—'; };
export const time = (v) => { const x = valid(v); return x ? t.format(x) : '—'; };
export function ago(v, now = Date.now()) {
  const x = valid(v); if (!x) return '—';
  const s = Math.round((now - x.getTime()) / 1000);
  if (s < 0) return 'just now'; if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return d.format(x);
}
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(Number(seconds))); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s}s`;
}
export function daysUntil(dateStr) {
  const x = valid(typeof dateStr === 'string' && dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr); if (!x) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((x.getTime() - today.getTime()) / 86400000);
}
/** value for <input type="date"> in local time */
export const isoDate = (x = new Date()) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
export const toLocalInput = (v) => { const x = valid(v); if (!x) return ''; return `${isoDate(x)}T${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };

/** Named date ranges used by dashboards. Returns ISO strings {from, to}. */
export function rangeFor(preset, customFrom, customTo) {
  const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now.getTime() + 60000);
  switch (preset) {
    case 'today': break;
    case 'yesterday': { const e = new Date(start); start.setDate(start.getDate() - 1); return { from: start.toISOString(), to: e.toISOString() }; }
    case 'week': start.setDate(start.getDate() - 6); break;
    case 'month': start.setDate(start.getDate() - 29); break;
    case 'quarter': start.setDate(start.getDate() - 89); break;
    case 'year': start.setDate(start.getDate() - 364); break;
    case 'custom': {
      const f = valid(`${customFrom}T00:00:00`), tt = valid(`${customTo}T23:59:59`);
      if (f && tt && f <= tt) return { from: f.toISOString(), to: new Date(tt.getTime() + 1000).toISOString() };
      break;
    }
    default: break;
  }
  return { from: start.toISOString(), to: end.toISOString() };
}
export const bucketFor = (from, to) => { const days = (new Date(to) - new Date(from)) / 86400000; return days <= 2 ? 'hour' : days <= 92 ? 'day' : days <= 400 ? 'week' : 'month'; };

export const titleCase = (s) => String(s ?? '').replace(/[_-]+/g, ' ').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bOtp\b/g, 'OTP').replace(/\bSos\b/g, 'SOS').replace(/\bRc\b/g, 'RC').replace(/\bPan\b/g, 'PAN').replace(/\bGst\b/g, 'GST').replace(/\bUpi\b/g, 'UPI').replace(/\bSms\b/g, 'SMS').replace(/\bAi\b/g, 'AI').replace(/\bIp\b/g, 'IP').replace(/\bApi\b/g, 'API').replace(/\bPuc\b/g, 'PUC');
export const initials = (name) => String(name ?? '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
export const maskPhone = (p) => { const s = String(p ?? ''); return s.length < 4 ? s : `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`; };

export function debounce(fn, ms = 300) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }
/** Random key that makes a money action safe to retry (the server ignores a repeated key). */
export const idempotencyKey = (prefix) => `${prefix}:${crypto.randomUUID()}`;

/** RFC-4180 CSV. Cells starting with = + - @ are prefixed so spreadsheets never run them as formulas. */
export function toCsv(columns, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}
export function download(filename, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Excel opens an HTML table saved as .xls; values are escaped and typed as text. */
export function toExcelHtml(title, columns, rows) {
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${columns.map((c) => `<td style="mso-number-format:'\\@'">${esc(typeof c.value === 'function' ? c.value(r) : r[c.key])}</td>`).join('')}</tr>`).join('');
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}
/** Parses CSV text (quotes, commas and newlines inside quotes supported) into objects keyed by header. */
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
/** Google encoded polyline -> [{lat, lng}] */
export function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
