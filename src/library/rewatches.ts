import { SimklApiError, type SimklClient } from '../api/client.js';
import { simklItemUrl } from '../format/media.js';
import { normalizeSimklId } from './identity.js';
import {
  isRecord, jsonBytes, LIBRARY_STATUSES, MEDIA_TYPES, MAX_PENDING_ITEM_BYTES,
  MAX_ROW_JSON_BYTES, STATUSES_BY_MEDIA, type Activities, type MediaType,
} from './types.js';

export interface RewatchRow {
  mediaType: MediaType;
  simklId: string;
  rewatchId: number;
  itemJson: string;
}

export interface RewatchSnapshot {
  activities: Activities;
  stale: boolean;
  rows: RewatchRow[];
}

const bucketByType: Record<MediaType, 'tv_shows' | 'movies' | 'anime'> = {
  shows: 'tv_shows', movies: 'movies', anime: 'anime',
};

function identity(row: RewatchRow): string {
  return JSON.stringify([row.mediaType, row.simklId, row.rewatchId]);
}

function parseRows(response: unknown): RewatchRow[] {
  if (response === null) return [];
  if (!isRecord(response) || Object.keys(response).some(key => !MEDIA_TYPES.includes(key as MediaType))) {
    throw new Error('Invalid Simkl rewatch response');
  }
  const rows: RewatchRow[] = [];
  for (const mediaType of MEDIA_TYPES) {
    const group = response[mediaType];
    if (group === undefined) continue;
    if (!Array.isArray(group)) throw new Error('Invalid Simkl rewatch category');
    for (const value of group) {
      if (!isRecord(value)) throw new Error('Invalid Simkl rewatch item');
      if (value.is_rewatch !== true) continue; // Canonical rows belong to the library cache.
      const media = value.movie ?? value.show ?? value.anime;
      const ids = isRecord(media) ? media.ids : null;
      const simklId = isRecord(ids) ? normalizeSimklId(ids.simkl) : undefined;
      const rewatchId = value.rewatch_id;
      if (!simklId || !Number.isSafeInteger(rewatchId) || (rewatchId as number) <= 0) {
        throw new Error('Invalid Simkl rewatch session identity');
      }
      if (!['active', 'completed', 'closed'].includes(String(value.rewatch_status))) {
        throw new Error('Invalid Simkl rewatch session status');
      }
      const itemJson = JSON.stringify(value);
      if (jsonBytes(itemJson) > MAX_ROW_JSON_BYTES) throw new Error('Simkl rewatch session too large');
      rows.push({ mediaType, simklId, rewatchId: rewatchId as number, itemJson });
    }
  }
  return rows;
}

function collectUnique(rows: RewatchRow[]): RewatchRow[] {
  const map = new Map<string, RewatchRow>();
  let totalBytes = 0;
  for (const row of rows) {
    const key = identity(row);
    const existing = map.get(key);
    if (existing && existing.itemJson !== row.itemJson) throw new Error('Conflicting Simkl rewatch session');
    if (existing) continue;
    totalBytes += jsonBytes(row.itemJson);
    if (totalBytes > MAX_PENDING_ITEM_BYTES) throw new Error('Simkl rewatch snapshot too large');
    map.set(key, row);
  }
  return [...map.values()];
}

/**
 * One filtered read per scope. Split on Simkl's max_items response or our
 * bounded response limit; never truncate a session or silently advance a cursor.
 */
async function fetchSessions(client: SimklClient, token: string, dateFrom?: string): Promise<RewatchRow[]> {
  const query = {
    allow_rewatch: 'yes', extended: 'full', episode_watched_at: 'yes',
    ...(dateFrom ? { date_from: dateFrom } : {}),
  };
  async function request(path: string): Promise<RewatchRow[]> {
    return parseRows(await client.request(path, { method: 'GET', token, query, responseProfile: 'library' }));
  }
  function shouldSplit(error: unknown): boolean {
    return error instanceof SimklApiError
      && (error.upstreamCode === 'max_items' || /response too large/i.test(error.message));
  }
  try {
    return collectUnique(await request('/sync/all-items'));
  } catch (error) {
    if (!shouldSplit(error)) throw error;
  }
  const result: RewatchRow[] = [];
  for (const type of MEDIA_TYPES) {
    try {
      result.push(...await request(`/sync/all-items/${type}`));
    } catch (error) {
      if (!shouldSplit(error)) throw error;
      for (const status of STATUSES_BY_MEDIA[type]) {
        result.push(...await request(`/sync/all-items/${type}/${status}`));
      }
    }
  }
  return collectUnique(result);
}

function bucketChanged(previous: Activities, current: Activities, field: string): boolean {
  return MEDIA_TYPES.some(type => {
    const key = bucketByType[type];
    const next = current[key]?.[field];
    return next !== undefined && next !== previous[key]?.[field];
  });
}

export async function refreshRewatches(
  client: SimklClient, token: string, previous: RewatchSnapshot | undefined, activities: Activities,
): Promise<RewatchSnapshot> {
  if (activities.all === null) {
    if (previous?.activities.all !== null) return { rows: [], activities, stale: false };
    return previous?.stale ? { ...previous, activities, stale: false } : previous ?? { rows: [], activities, stale: false };
  }
  if (previous?.activities.all && Date.parse(activities.all) < Date.parse(previous.activities.all)) {
    throw new Error('Simkl rewatch activity watermark regressed');
  }
  if (previous && !previous.stale && previous.activities.all === activities.all) return previous;

  const needsBaseline = !previous || previous.activities.all === null;
  const removed = previous && bucketChanged(previous.activities, activities, 'removed_from_list');
  const changed = previous && LIBRARY_STATUSES.some(status => bucketChanged(previous.activities, activities, status));
  // An in-app write invalidates cached sessions. Prefer the delta when the
  // activity bucket moved; reconcile fully only if there is no safe cursor.
  const staleWithoutDelta = previous?.stale && !changed;

  let rows: RewatchRow[];
  if (needsBaseline || removed || staleWithoutDelta) {
    // Deletions have no tombstones. Full replacement also removes stale sessions.
    rows = await fetchSessions(client, token);
  } else if (changed) {
    const delta = await fetchSessions(client, token, previous.activities.all ?? undefined);
    const combined = new Map(previous.rows.map(row => [identity(row), row]));
    for (const row of delta) combined.set(identity(row), row);
    rows = collectUnique([...combined.values()]);
  } else {
    rows = previous.rows;
  }
  return { rows, activities, stale: false };
}

export function selectRewatches(rows: RewatchRow[], args: { mediaType: 'all' | MediaType; status: string }): string[] {
  if (!['all', ...MEDIA_TYPES].includes(args.mediaType)) throw new Error('invalid rewatch media type');
  if (!LIBRARY_STATUSES.includes(args.status as typeof LIBRARY_STATUSES[number])) throw new Error('invalid watch status');
  return rows
    .filter(row => args.mediaType === 'all' || args.mediaType === row.mediaType)
    .map(row => ({ row, item: JSON.parse(row.itemJson) as Record<string, unknown> }))
    .filter(({ item }) => item.status === args.status)
    .map(({ row, item }) => {
      const media = (item.movie || item.show || item.anime) as Record<string, unknown>;
      const ids = media.ids as Record<string, unknown>;
      const name = typeof media.title === 'string' ? media.title : 'unknown';
      const year = typeof media.year === 'number' ? media.year : 'N/A';
      const url = simklItemUrl(row.mediaType === 'shows' ? 'tv' : row.mediaType, row.simklId, typeof ids.slug === 'string' ? ids.slug : undefined);
      const watched = item.watched_episodes_count;
      const total = item.total_episodes_count;
      const progress = typeof watched === 'number' && typeof total === 'number'
        ? `${watched}/${total}` : row.mediaType === 'movies' ? 'movie' : 'unavailable';
      return `${name} (${year}) | rewatch_id: ${row.rewatchId} | status: ${item.rewatch_status} | list: ${item.status} | progress: ${progress} | Simkl: <${url}>`;
    });
}
