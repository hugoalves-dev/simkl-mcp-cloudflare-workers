import { SimklApiError } from '../api/client.js';
import type { MediaType } from './types.js';

/** Per-sync correlation, independent of the Cloudflare invocation's $metadata.traceId. */
export interface LibrarySyncRun {
  readonly syncId: string;
  requests: number;
}

export type SyncPhase = 'initial' | 'incremental';
export type SyncOperation = 'activities' | 'baseline' | 'delta' | 'ratings' | 'membership';
export type SyncQueryMode = 'none' | 'date_from' | 'full_ids';

export function createLibrarySyncRun(): LibrarySyncRun {
  return { syncId: crypto.randomUUID(), requests: 0 };
}

/**
 * Only emit bounded, explicit diagnostic fields. Never serialize an exception,
 * upstream body, URL, token, query string, or a library record into Workers Logs.
 */
export function logLibrarySync(
  run: LibrarySyncRun,
  event: 'upstream_request' | 'activities_gate' | 'route' | 'snapshot_ready' | 'snapshot_committed' | 'sync_failed',
  fields: {
    phase: SyncPhase;
    operation?: SyncOperation;
    outcome?: string;
    media?: MediaType;
    status?: string;
    queryMode?: SyncQueryMode;
    requestNo?: number;
    durationMs?: number;
    rows?: number;
    requests?: number;
    reason?: string;
  },
): void {
  console.info(JSON.stringify({
    component: 'simkl_library_sync',
    event,
    syncId: run.syncId,
    ...fields,
  }));
}

function sanitizedReason(error: unknown): string {
  if (error instanceof SimklApiError) {
    if (error.statusCode === 400 && error.upstreamCode === 'max_items') return 'max_items';
    if (error.statusCode === 429) return 'rate_limited';
    if (error.statusCode === 200) return 'response_limit_or_parse';
    return 'upstream_http';
  }
  if (error instanceof Error && error.name === 'LibrarySyncLimitError') return 'partition_exhausted';
  return 'validation_or_network';
}

/** Records precisely one attempt, including failed/oversized/malformed responses. */
export async function observeLibrarySyncRequest<T>(
  run: LibrarySyncRun,
  fields: {
    phase: SyncPhase;
    operation: SyncOperation;
    media?: MediaType;
    status?: string;
    queryMode: SyncQueryMode;
  },
  request: () => Promise<T>,
  rowCount?: (response: T) => number,
): Promise<T> {
  const requestNo = ++run.requests;
  const startedAt = performance.now();
  try {
    const result = await request();
    logLibrarySync(run, 'upstream_request', {
      ...fields,
      outcome: 'success',
      requestNo,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(rowCount ? { rows: rowCount(result) } : {}),
    });
    return result;
  } catch (error) {
    logLibrarySync(run, 'upstream_request', {
      ...fields,
      outcome: 'failed',
      reason: sanitizedReason(error),
      requestNo,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
    throw error;
  }
}
