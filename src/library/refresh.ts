import type { SimklClient, RequestOptions } from '../api/client';
import { MEDIA_TYPES, type Activities, type LibraryItem, type LibraryItems, type LibrarySnapshot } from './types';
import { fetchInitialLibrary } from './sync';
import { normalizeSimklId } from './identity';

export function parseLibraryCacheTtlSeconds(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return 300;
  const seconds = Number(value.trim());
  return seconds > 0 && Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1000) ? seconds : 300;
}
const empty = (): LibraryItems => ({ shows: [], movies: [], anime: [] });
const statuses = ['watching', 'plantowatch', 'hold', 'completed', 'dropped'];
export function libraryItemId(item: LibraryItem): string {
  const id = (item.show || item.movie || item.anime)?.ids?.simkl;
  const normalized = normalizeSimklId(id);
  if (!normalized) throw new Error('Invalid Simkl library item ID');
  return normalized;
}
function validateItems(value: unknown): LibraryItems {
  if (value === null) return empty();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Simkl library response');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !MEDIA_TYPES.includes(key as typeof MEDIA_TYPES[number]))) throw new Error('Invalid Simkl library categories');
  const result = empty();
  for (const type of MEDIA_TYPES) {
    if (!(type in record)) continue;
    if (!Array.isArray(record[type])) throw new Error('Invalid Simkl library category');
    for (const item of record[type]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Simkl library item');
      libraryItemId(item);
      if (item.status !== undefined && !statuses.includes(item.status)) throw new Error('Invalid Simkl library status');
      if (item.user_rating !== undefined && item.user_rating !== null && (!Number.isInteger(item.user_rating) || item.user_rating < 1 || item.user_rating > 10)) throw new Error('Invalid Simkl user rating');
      result[type].push(item);
    }
  }
  return result;
}
function validateActivities(value: unknown): Activities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Simkl activities');
  const data = value as Activities;
  if (data.all !== null && (typeof data.all !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(data.all) || !Number.isFinite(Date.parse(data.all)))) throw new Error('Invalid Simkl activity watermark');
  for (const category of ['tv_shows', 'movies', 'anime'] as const) {
    const bucket = data[category];
    if (bucket === undefined) continue;
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('Invalid Simkl activity category');
    for (const field of [...statuses, 'removed_from_list', 'rated_at']) {
      const stamp = bucket[field];
      if (stamp !== undefined && stamp !== null && (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)))) throw new Error('Invalid Simkl activity timestamp');
    }
  }
  return data;
}
async function fetchItems(client: SimklClient, endpoint: string, options: RequestOptions): Promise<LibraryItems> {
  const response = await client.request<unknown>(endpoint, { ...options, responseProfile: 'library' });
  return validateItems(response);
}
function merge(items: LibraryItems, updates: LibraryItems): void {
  for (const type of MEDIA_TYPES) {
    const map = new Map(items[type].map(item => [libraryItemId(item), item]));
    for (const update of updates[type]) {
      const id = libraryItemId(update), old = map.get(id);
      const merged = { ...old, ...update };
      for (const field of ['show', 'movie', 'anime'] as const) {
        if (old?.[field] && update[field]) merged[field] = { ...old[field], ...update[field], ids: { ...old[field].ids, ...update[field].ids } };
      }
      if (!merged.status) throw new Error('Missing Simkl library item status');
      map.set(id, merged);
    }
    items[type] = [...map.values()];
  }
}
export async function refreshLibrary(client: SimklClient, token: string, previous: LibrarySnapshot | undefined, options: { ttlSeconds: number; now: number; force?: boolean }): Promise<LibrarySnapshot> {
  if (previous && previous.version !== 1) throw new Error('Unsupported library cache schema');
  if (previous && !previous.forceCheck && !options.force && options.now >= previous.checkedAt && options.now - previous.checkedAt < options.ttlSeconds * 1000) return previous;
  const activities = validateActivities(await client.request('/sync/activities', { method: 'GET', token }));
  if (previous && activities.all !== null && previous.activities.all !== null && Date.parse(activities.all) < Date.parse(previous.activities.all)) throw new Error('Simkl activity watermark regressed');
  const items = previous && previous.activities.all !== null && activities.all !== null ? structuredClone(previous.items) : empty();
  // A null watermark has no date_from baseline; the first activity needs Phase 1.
  if (!previous || previous.activities.all === null) {
    const initial = await fetchInitialLibrary(client, token, activities);
    for (const row of initial.items) items[row.mediaType].push(JSON.parse(row.itemJson));
  } else if (activities.all !== null && activities.all !== previous.activities.all) {
    const changed = (fields: string[]) => (['tv_shows', 'movies', 'anime'] as const).some(category => fields.some(field => {
      const next = activities[category]?.[field];
      // Missing categories do not imply a change; Simkl may omit unused buckets.
      return next !== undefined && next !== previous.activities[category]?.[field];
    }));
    const query = { date_from: previous.activities.all };
    if (changed(statuses)) merge(items, await fetchItems(client, '/sync/all-items', { method: 'GET', token, query }));
    // Official synchronization guide documents GET /sync/ratings for reads;
    // POST /sync/ratings is the add-rating mutation, despite the blueprint typo.
    if (changed(['rated_at'])) merge(items, await fetchItems(client, '/sync/ratings', { method: 'GET', token, query }));
    if (changed(['removed_from_list'])) {
      const membership = await fetchItems(client, '/sync/all-items', { method: 'GET', token, query: { extended: 'simkl_ids_only' } });
      for (const type of MEDIA_TYPES) {
        const ids = new Set(membership[type].map(libraryItemId));
        items[type] = items[type].filter(item => ids.has(libraryItemId(item)));
      }
    }
  }
  return { version: 1, items, activities, checkedAt: options.now, forceCheck: false };
}
