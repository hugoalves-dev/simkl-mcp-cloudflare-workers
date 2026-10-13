import { SimklApiError, type SimklClient } from '../api/client.js';
import { normalizeSimklId } from './identity.js';
import {
  isRecord, jsonBytes, MEDIA_TYPES, STATUSES_BY_MEDIA, MAX_ROW_JSON_BYTES, MAX_PENDING_ITEM_BYTES,
  type LibraryCandidate, type LibraryItemRow, type MediaType,
} from './types.js';

export async function fetchInitialLibrary(client: SimklClient, accessToken: string, knownActivities?: Record<string, unknown>): Promise<LibraryCandidate> {
  const activities = knownActivities ?? await client.request<unknown>('/sync/activities', { method: 'GET', token: accessToken });
  if (!isRecord(activities) || typeof activities.all !== 'string' || !Number.isFinite(Date.parse(activities.all))) {
    throw new Error('Invalid Simkl activities snapshot');
  }

  const items = new Map<string, LibraryItemRow>();
  let pendingBytes = 0;
  function append(response: unknown, mediaType: MediaType): void {
    // Simkl omits all media keys for an empty filtered result.
    if (isRecord(response) && Object.keys(response).length === 0) return;
    if (!isRecord(response) || !Array.isArray(response[mediaType])) {
      throw new Error('Invalid Simkl library response');
    }
    const mediaKey = mediaType === 'movies' ? 'movie' : 'show';
    for (const item of response[mediaType]) {
      const media = isRecord(item) ? item[mediaKey] : undefined;
      const ids = isRecord(media) ? media.ids : undefined;
      const simklId = isRecord(ids) ? normalizeSimklId(ids.simkl) : undefined;
      if (!simklId) throw new Error('Invalid Simkl library item identity');
      const itemJson = JSON.stringify(item);
      const bytes = jsonBytes(itemJson);
      if (bytes > MAX_ROW_JSON_BYTES) throw new Error('Library item too large');
      const key = `${mediaType}:${simklId}`;
      const prior = items.get(key);
      if (prior) {
        if (prior.itemJson !== itemJson) throw new Error('Conflicting Simkl library item');
        continue;
      }
      pendingBytes += bytes;
      if (pendingBytes > MAX_PENDING_ITEM_BYTES) throw new Error('Library initialization too large');
      items.set(key, { mediaType, simklId, itemJson });
    }
  }

  async function pull(path: string, mediaType: MediaType): Promise<void> {
    let page = 1, pageCount = 1;
    do {
      const response = await client.requestPaginated<unknown>(path, {
        method: 'GET', token: accessToken, responseProfile: 'library',
        pagination: { page, limit: 100, requireComplete: true },
      });
      append(response.data, mediaType);
      if (response.pagination) {
        if (response.pagination.page !== page || (page > 1 && response.pagination.pageCount !== pageCount)) throw new Error('Invalid Simkl library pagination');
        pageCount = response.pagination.pageCount;
      } else if (page > 1) throw new Error('Missing Simkl library pagination');
      page++;
    } while (page <= pageCount);
  }
  for (const mediaType of MEDIA_TYPES) {
    try {
      await pull(`/sync/all-items/${mediaType}`, mediaType);
    } catch (error) {
      if (!(error instanceof SimklApiError) || error.statusCode !== 400 || error.upstreamCode !== 'max_items') throw error;
      for (const status of STATUSES_BY_MEDIA[mediaType]) await pull(`/sync/all-items/${mediaType}/${status}`, mediaType);
    }
  }
  return { activities, items: [...items.values()] };
}
