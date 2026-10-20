import { SimklApiError, type RequestOptions, type SimklClient } from '../api/client.js';
import { LibrarySyncLimitError } from './errors.js';
import { normalizeSimklId } from './identity.js';
import {
  isRecord, jsonBytes, MAX_PENDING_ITEM_BYTES, MAX_ROW_JSON_BYTES,
  MEDIA_TYPES, STATUSES_BY_MEDIA, type LibraryItem, type LibraryItems, type MediaType,
} from './types.js';

export type SyncOperation = 'delta' | 'ratings' | 'membership';
export type SyncPhase = 'initial' | 'incremental';

export function isMaxItems(error: unknown): error is SimklApiError {
  return error instanceof SimklApiError && error.statusCode === 400 && error.upstreamCode === 'max_items';
}

/** Workers Logs attaches $metadata.traceId to these events. No URLs, IDs, tokens or payloads. */
export function logSyncPartition(
  phase: SyncPhase,
  operation: SyncOperation | 'baseline',
  stage: 'all' | 'type' | 'status',
  outcome: 'max_items' | 'success' | 'failed' | 'unrecoverable',
  media?: MediaType,
  status?: string,
  attempts?: number,
): void {
  console.info(JSON.stringify({
    component: 'simkl_library_sync',
    event: 'partition_fallback',
    phase, operation, stage, outcome,
    ...(media ? { media } : {}),
    ...(status ? { status } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    upstreamCode: outcome === 'max_items' || outcome === 'unrecoverable' ? 'max_items' : undefined,
  }));
}

function identity(item: LibraryItem, media: MediaType): string {
  const payload = media === 'movies' ? item.movie : item.show ?? item.anime;
  const id = isRecord(payload) && isRecord(payload.ids) ? normalizeSimklId(payload.ids.simkl) : undefined;
  if (!id) throw new Error('Invalid Simkl library partition identity');
  return id;
}

const empty = (): LibraryItems => ({ shows: [], movies: [], anime: [] });

/**
 * One all-type GET in the normal case. On confirmed 400 max_items only,
 * retry documented partitions sequentially: types, then statuses.
 * Ratings cannot be further split by rating (null removals would disappear).
 */
export async function fetchPartitionedLibrary(
  client: SimklClient,
  token: string,
  operation: SyncOperation,
  query: RequestOptions['query'],
  validate: (response: unknown) => LibraryItems,
): Promise<LibraryItems> {
  const path = operation === 'ratings' ? '/sync/ratings' : '/sync/all-items';
  let attempts = 0;
  let fallbackActive = false;
  const request = async (media?: MediaType, status?: string): Promise<LibraryItems> => {
    // Pace only fallback requests (8/sec ceiling per object) to respect Simkl's 10 GET/sec limit.
    if (fallbackActive) await new Promise<void>(resolve => setTimeout(resolve, 125));
    attempts++;
    const suffix = media ? `/${media}${status ? `/${status}` : ''}` : '';
    const response = await client.request<unknown>(path + suffix, {
      method: 'GET', token, query, responseProfile: 'library',
    });
    const result = validate(response);
    if (media) {
      for (const other of MEDIA_TYPES) {
        if (other !== media && result[other].length > 0) throw new Error('Unexpected Simkl library partition media');
      }
      if (status && operation === 'delta') {
        for (const item of result[media]) {
          if (item.status !== status) throw new Error('Invalid Simkl library partition status');
        }
      }
    }
    return result;
  };
  const combined = empty();
  const keys = new Map<string, string>();
  let pendingBytes = 0;
  const append = (result: LibraryItems): void => {
    for (const media of MEDIA_TYPES) {
      for (const item of result[media]) {
        const id = identity(item, media);
        const key = `${media}:${id}`;
        const json = JSON.stringify(item);
        if (keys.has(key)) throw new Error('Duplicate Simkl library partition item');
        const bytes = jsonBytes(json);
        if (bytes > MAX_ROW_JSON_BYTES) throw new Error('Library item too large');
        pendingBytes += bytes;
        if (pendingBytes > MAX_PENDING_ITEM_BYTES) throw new Error('Library synchronization too large');
        keys.set(key, json);
        combined[media].push(item);
      }
    }
  };

  // Keep the efficient one-request path; a non-max_items failure is never retried as a split.
  try {
    append(await request());
    return combined;
  } catch (error) {
    if (!isMaxItems(error)) throw error;
    fallbackActive = true;
    logSyncPartition('incremental', operation, 'all', 'max_items', undefined, undefined, attempts);
  }

  try {
    for (const media of MEDIA_TYPES) {
      try {
        append(await request(media));
      } catch (error) {
        if (!isMaxItems(error)) throw error;
        logSyncPartition('incremental', operation, 'type', 'max_items', media, undefined, attempts);
        if (operation === 'ratings') {
          // /sync/ratings/{type}/{rating} would drop user_rating:null removals.
          logSyncPartition('incremental', operation, 'type', 'unrecoverable', media, undefined, attempts);
          throw new LibrarySyncLimitError('incremental', operation, media);
        }
        for (const status of STATUSES_BY_MEDIA[media]) {
          try {
            append(await request(media, status));
          } catch (statusError) {
            if (!isMaxItems(statusError)) throw statusError;
            // No documented, lossless split beyond one type/status.
            logSyncPartition('incremental', operation, 'status', 'unrecoverable', media, status, attempts);
            throw new LibrarySyncLimitError('incremental', operation, media, status);
          }
        }
      }
    }
    logSyncPartition('incremental', operation, 'all', 'success', undefined, undefined, attempts);
    return combined;
  } catch (error) {
    logSyncPartition('incremental', operation, 'all', 'failed', undefined, undefined, attempts);
    throw error;
  }
}
