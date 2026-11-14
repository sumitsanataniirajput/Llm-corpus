// Client-side validation. This is for fast feedback only — the database and the
// server functions validate everything again and are the source of truth.

export const rules = {
  required: (v) => (v === null || v === undefined || String(v).trim() === '' ? 'This field is required' : null),
  email: (v) => (!v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'Enter a valid e-mail address'),
  phone: (v) => (!v || /^[6-9]\d{9}$/.test(String(v).replace(/[\s-]/g, '').replace(/^(\+91|91)(?=\d{10}$)/, '')) ? null : 'Enter a 10-digit Indian mobile number'),
  pincode: (v) => (!v || /^[1-9]\d{5}$/.test(v) ? null : 'Enter a 6-digit PIN code'),
  vehicleReg: (v) => (!v || /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(String(v).toUpperCase().replace(/[\s-]/g, '')) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(String(v).toUpperCase().replace(/[\s-]/g, '')) ? null : 'Enter a valid registration number, e.g. UP32AB1234'),
  last4: (v) => (!v || /^\d{4}$/.test(v) ? null : 'Enter exactly the last 4 digits'),
  panMasked: (v) => (!v || /^[A-Z*X]{5}[\d*X]{4}[A-Z*X]$/i.test(v) ? null : 'Enter the PAN in masked form, e.g. ABCDE****F'),
  money: (v) => (!v || /^\d{1,10}(\.\d{1,2})?$/.test(String(v).replace(/[₹,\s]/g, '')) ? null : 'Enter an amount such as 120 or 120.50'),
  integer: (v) => (v === '' || v === null || v === undefined || /^-?\d+$/.test(String(v)) ? null : 'Enter a whole number'),
  decimal: (v) => (v === '' || v === null || v === undefined || /^-?\d+(\.\d+)?$/.test(String(v)) ? null : 'Enter a number'),
  lat: (v) => (v === '' || v === null || v === undefined || (Number(v) >= -90 && Number(v) <= 90) ? null : 'Latitude must be between -90 and 90'),
  lng: (v) => (v === '' || v === null || v === undefined || (Number(v) >= -180 && Number(v) <= 180) ? null : 'Longitude must be between -180 and 180'),
  cidr: (v) => (!v || /^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[12]\d|3[0-2]))?$/.test(v) || /^[0-9a-f:]+(\/\d{1,3})?$/i.test(v) ? null : 'Enter an IP address or range, e.g. 203.0.113.0/24'),
  couponCode: (v) => (!v || /^[A-Z0-9]{3,20}$/.test(String(v).toUpperCase()) ? null : '3–20 letters or digits, no spaces'),
  password: (v) => (!v || (v.length >= 10 && /[A-Za-z]/.test(v) && /\d/.test(v)) ? null : 'At least 10 characters with a letter and a number'),
  minLen: (n) => (v) => (!v || String(v).trim().length >= n ? null : `At least ${n} characters`),
  maxLen: (n) => (v) => (!v || String(v).length <= n ? null : `At most ${n} characters`),
  min: (n) => (v) => (v === '' || v === null || v === undefined || Number(v) >= n ? null : `Must be ${n} or more`),
  max: (n) => (v) => (v === '' || v === null || v === undefined || Number(v) <= n ? null : `Must be ${n} or less`),
  notPast: (v) => (!v || new Date(v).getTime() >= Date.now() - 86400000 ? null : 'Date cannot be in the past'),
};

/** Normalise an Indian mobile number to 10 digits. */
export const normalisePhone = (v) => String(v ?? '').replace(/[\s-]/g, '').replace(/^(\+91|91)(?=\d{10}$)/, '');

/**
 * Validate values against field definitions ({name, required, rules: [fn]}).
 * Returns { ok, errors: {name: message} }.
 */
export function validate(fields, values) {
  const errors = {};
  for (const f of fields) {
    if (!f.name || f.type === 'section') continue;
    if (typeof f.showIf === 'function' && !f.showIf(values)) continue;
    const v = values[f.name];
    const checks = [...(f.required ? [rules.required] : []), ...(f.rules ?? [])];
    for (const check of checks) { const msg = check(v, values); if (msg) { errors[f.name] = msg; break; } }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Allowed uploads: images and PDF only, size-limited. Returns an error message or null. */
export function validateFile(file, { maxMb = 10, types = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] } = {}) {
  if (!file) return 'Choose a file';
  if (!types.includes(file.type)) return 'Only JPG, PNG, WebP or PDF files are allowed';
  if (file.size > maxMb * 1024 * 1024) return `File is larger than ${maxMb} MB`;
  if (file.size === 0) return 'File is empty';
  return null;
}
