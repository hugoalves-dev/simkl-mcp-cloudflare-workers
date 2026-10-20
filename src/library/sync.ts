import type { SimklClient } from '../api/client.js';
import { LibrarySyncLimitError } from './errors.js';
import {
  createLibrarySyncRun, logLibrarySync, observeLibrarySyncRequest,
  type LibrarySyncRun,
} from './sync-telemetry.js';
import { isMaxItems, logSyncPartition } from './partitions.js';
import { normalizeSimklId } from './identity.js';
import {
  isRecord, jsonBytes, MEDIA_TYPES, STATUSES_BY_MEDIA, MAX_ROW_JSON_BYTES, MAX_PENDING_ITEM_BYTES,
  type LibraryCandidate, type LibraryItemRow, type MediaType,
} from './types.js';

export async function fetchInitialLibrary(client: SimklClient, accessToken: string, knownActivities?: Record<string, unknown>, run?: LibrarySyncRun): Promise<LibraryCandidate> {
  const telemetry = run ?? createLibrarySyncRun();
  const activities = knownActivities ?? await observeLibrarySyncRequest(
    telemetry, { phase: 'initial', operation: 'activities', queryMode: 'none' },
    () => client.request<unknown>('/sync/activities', { method: 'GET', token: accessToken }),
  );
  if (!isRecord(activities) || (activities.all !== null && (typeof activities.all !== 'string' || !Number.isFinite(Date.parse(activities.all))))) {
    throw new Error('Invalid Simkl activities snapshot');
  }

  if (activities.all === null) {
    logLibrarySync(telemetry, 'snapshot_ready', { phase: 'initial', outcome: 'empty', rows: 0, requests: telemetry.requests });
    return { activities, items: [] };
  }

  const items = new Map<string, LibraryItemRow>();
  let pendingBytes = 0;
  function append(response: unknown, mediaType: MediaType): void {
    // Current Simkl uses {}; older client IDs may receive null for emptiness.
    if (response === null || (isRecord(response) && Object.keys(response).length === 0)) return;
    if (isRecord(response) && Object.keys(response).some(key => !MEDIA_TYPES.includes(key as MediaType))) throw new Error('Invalid Simkl library response');
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

  let fallbackActive = false;
  async function pull(path: string, mediaType: MediaType): Promise<void> {
    // Pace fallback requests without slowing the normal initial sync.
    if (fallbackActive) await new Promise<void>(resolve => setTimeout(resolve, 125));
    // /sync/all-items returns the entire filtered library without pagination.
    await observeLibrarySyncRequest(
      telemetry,
      { phase: 'initial', operation: 'baseline', media: mediaType, status: path.split('/')[4], queryMode: 'none' },
      async () => {
        const response = await client.request<unknown>(path, {
          method: 'GET', token: accessToken, responseProfile: 'library',
        });
        append(response, mediaType);
        return response;
      },
      response => isRecord(response) && Array.isArray(response[mediaType]) ? response[mediaType].length : 0,
    );
  }
  for (const mediaType of MEDIA_TYPES) {
    try {
      await pull(`/sync/all-items/${mediaType}`, mediaType);
    } catch (error) {
      if (!isMaxItems(error)) throw error;
      fallbackActive = true;
      logSyncPartition('initial', 'baseline', 'type', 'max_items', mediaType, undefined, undefined, telemetry);
      for (const status of STATUSES_BY_MEDIA[mediaType]) {
        try {
          await pull(`/sync/all-items/${mediaType}/${status}`, mediaType);
        } catch (statusError) {
          if (!isMaxItems(statusError)) throw statusError;
          logSyncPartition('initial', 'baseline', 'status', 'unrecoverable', mediaType, status, undefined, telemetry);
          throw new LibrarySyncLimitError('initial', 'baseline', mediaType, status);
        }
      }
      logSyncPartition('initial', 'baseline', 'type', 'success', mediaType, undefined, undefined, telemetry);
    }
  }
  logLibrarySync(telemetry, 'snapshot_ready', {
    phase: 'initial', outcome: 'ready', rows: items.size, requests: telemetry.requests,
  });
  return { activities, items: [...items.values()] };
}
