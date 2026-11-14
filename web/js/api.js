// Data access layer. Pages never build raw queries: they call these helpers, which add
// paging, search, error handling and small caches for reference data.
import { sb, rpc, unwrap, toAppError, AppError } from './supabase-client.js';

/** Characters that have meaning inside a PostgREST filter string are removed from user search text. */
const cleanSearch = (s) => String(s ?? '').replace(/[,()%*\\"']/g, ' ').trim().slice(0, 80);

/**
 * Paged list.
 *  list('drivers', { select, search, searchColumns:['full_name','phone'], filters:{status:'approved'},
 *                    order:'created_at', ascending:false, page:1, pageSize:25, apply:(q)=>q.gte(...) })
 * -> { rows, count }
 */
export async function list(table, { select = '*', search = '', searchColumns = [], filters = {}, order = 'created_at', ascending = false,
  page = 1, pageSize = 25, apply = null, count = 'exact' } = {}) {
  let q = sb.from(table).select(select, { count });
  for (const [k, v] of Object.entries(filters)) {
    if (v === '' || v === null || v === undefined) continue;
    if (Array.isArray(v)) q = q.in(k, v); else if (v === '__null__') q = q.is(k, null); else if (v === '__notnull__') q = q.not(k, 'is', null); else q = q.eq(k, v);
  }
  const term = cleanSearch(search);
  if (term && searchColumns.length) q = q.or(searchColumns.map((c) => `${c}.ilike.%${term}%`).join(','));
  if (apply) q = apply(q) ?? q;
  if (order) q = q.order(order, { ascending, nullsFirst: false });
  const from = (page - 1) * pageSize;
  q = q.range(from, from + pageSize - 1);
  const { data, error, count: total } = await q;
  if (error) throw toAppError(error);
  return { rows: data ?? [], count: total ?? (data?.length ?? 0) };
}

/** Fetch every matching row in chunks (for exports). Stops at `max` rows. */
export async function listAll(table, opts = {}, max = 10000) {
  const out = []; const pageSize = 1000;
  for (let page = 1; out.length < max; page++) {
    const { rows } = await list(table, { ...opts, page, pageSize, count: 'planned' });
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out.slice(0, max);
}

export const getOne = async (table, id, select = '*', key = 'id') => unwrap(sb.from(table).select(select).eq(key, id).maybeSingle());
export const insert = async (table, values, select = '*') => unwrap(sb.from(table).insert(values).select(select).single());
export async function update(table, id, values, key = 'id') {
  const data = await unwrap(sb.from(table).update(values).eq(key, id).select());
  if (!data || data.length === 0) throw new AppError('PERMISSION_DENIED', 'Nothing was changed. You may not have permission to edit this record.');
  return data[0];
}
export async function remove(table, id, key = 'id') {
  const data = await unwrap(sb.from(table).delete().eq(key, id).select());
  if (!data || data.length === 0) throw new AppError('PERMISSION_DENIED', 'Nothing was deleted. You may not have permission, or the record is in use.');
  return true;
}
export const select = async (table, columns = '*', build = (q) => q) => unwrap(build(sb.from(table).select(columns)));
export const countOf = async (table, build = (q) => q) => { const { count, error } = await build(sb.from(table).select('*', { count: 'exact', head: true })); if (error) throw toAppError(error); return count ?? 0; };
export { rpc };

// ---------- reference data (cached for the session, refreshed on demand) ----------
const cache = new Map();
async function cached(key, loader, force = false) {
  if (force || !cache.has(key)) cache.set(key, loader().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}
export const invalidate = (key) => (key ? cache.delete(key) : cache.clear());
export const cities = (force) => cached('cities', () => select('cities', 'id,name,state,is_active,center_lat,center_lng,timezone', (q) => q.order('name')), force);
export const categories = (force) => cached('categories', () => select('vehicle_categories', 'id,code,name,capacity,icon,is_active,sort_order', (q) => q.order('sort_order')), force);
export const roles = (force) => cached('roles', () => select('roles', 'id,code,name,description,rank,is_system', (q) => q.order('rank')), force);
export const branches = (force) => cached('branches', () => select('branches', 'id,name,code,city_id,is_active', (q) => q.order('name')), force);
export const staffList = (force) => cached('staff', () => select('staff_accounts', 'id,full_name,employee_code,status,role_id', (q) => q.order('full_name')), force);
export const asOptions = (rows, label = 'name', value = 'id') => (rows ?? []).map((r) => ({ value: r[value], label: typeof label === 'function' ? label(r) : r[label] }));
export const nameMap = (rows, label = 'name') => Object.fromEntries((rows ?? []).map((r) => [r.id, r[label]]));

// ---------- storage (private buckets, short-lived signed URLs) ----------
export async function uploadFile(bucket, folder, file) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const path = `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' });
  if (error) {
    if (/bucket not found/i.test(error.message)) throw new AppError('STORAGE_NOT_CONFIGURED', `Storage bucket "${bucket}" does not exist. Run the migrations on Supabase (see SETUP.md).`);
    throw toAppError(error);
  }
  return path;
}
/** Signed URL valid for 2 minutes — enough to view a document, useless if copied later. */
export async function signedUrl(bucket, path, seconds = 120) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, seconds);
  if (error) throw toAppError(error);
  return data.signedUrl;
}
export const publicUrl = (bucket, path) => sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;

// ---------- realtime ----------
/**
 * Subscribe to row changes. Returns an unsubscribe function.
 * RLS applies: a staff member only receives rows they are allowed to read.
 */
export function subscribe(name, tables, onChange, onStatus) {
  const channel = sb.channel(`${name}:${crypto.randomUUID().slice(0, 8)}`);
  for (const t of tables) {
    const spec = typeof t === 'string' ? { table: t } : t;
    channel.on('postgres_changes', { event: spec.event ?? '*', schema: 'public', table: spec.table, ...(spec.filter ? { filter: spec.filter } : {}) },
      (payload) => { try { onChange(payload); } catch (e) { console.error('realtime handler', e); } });
  }
  channel.subscribe((status) => onStatus?.(status));
  return () => { sb.removeChannel(channel); };
}
