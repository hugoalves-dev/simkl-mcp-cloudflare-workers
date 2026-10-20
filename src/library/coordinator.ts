import { SimklApiError, type RequestOptions, type SimklClient } from '../api/client';
import type { LibraryItems, LibrarySnapshot } from './types';
import { refreshLibrary } from './refresh';
import { LibrarySyncLimitError, LibraryWriteInvalidationError } from './errors';
import { createLibrarySyncRun, logLibrarySync } from './sync-telemetry';

/** Cloudflare attaches $metadata.traceId to this console event in Workers Logs. */
function logCacheEvent(event: 'cache_hit' | 'activities_unchanged'): void {
  console.info(JSON.stringify({ component: 'simkl_library_cache', event }));
}
export interface LibraryStore {
  load(): Promise<LibrarySnapshot | undefined>;
  save(snapshot: LibrarySnapshot): Promise<void>;
  saveFreshness?(freshness: Pick<LibrarySnapshot, 'checkedAt' | 'forceCheck'>): Promise<void>;
}
/** Serializes network refresh and persistence, including cross-session invalidation. */
export class CachedLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  private retryRequired = false;
  constructor(private store: LibraryStore, private client: SimklClient, private ttlSeconds: number, private now: () => number = Date.now, private wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  /** Runs a related per-account cache operation through the same queue as reads, writes, and invalidations. */
  withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }
  read(token: string, force = false): Promise<LibraryItems> {
    return this.enqueue(async () => {
      const telemetry = createLibrarySyncRun();
      let syncPhase: 'initial' | 'incremental' = 'incremental';
      let retryPending = this.retryRequired;
      try {
        if (!token) throw new Error('Simkl authentication required');
        let previous = await this.store.load();
        syncPhase = !previous || previous.activities.all === null ? 'initial' : 'incremental';
        retryPending ||= previous?.forceCheck === true;
        const forceRefresh = force || this.retryRequired;
        // Persist retry/invalidation intent, never a manual force request:
        // explicit refreshes have their own durable one-minute reservation.
        if (this.retryRequired && previous && !previous.forceCheck) {
          if (previous.version !== 1) throw new Error('Unsupported library cache schema');
          previous = { ...previous, forceCheck: true };
          if (this.store.saveFreshness) await this.store.saveFreshness(previous);
          else await this.store.save(previous);
        }
        const snapshot = await refreshLibrary(this.client, token, previous, {
          ttlSeconds: this.ttlSeconds, now: this.now(), force: forceRefresh, telemetry,
        });
        if (snapshot === previous) {
          // The TTL shortcut served the persisted snapshot without an upstream check.
          if (previous) logCacheEvent('cache_hit');
        } else {
          const activitiesUnchanged = previous
            && JSON.stringify(snapshot.activities) === JSON.stringify(previous.activities);
          if (activitiesUnchanged && this.store.saveFreshness) {
            await this.store.saveFreshness(snapshot);
          } else {
            await this.store.save(snapshot);
          }
          // Only log after persistence succeeds; never report a failed refresh as successful.
          logLibrarySync(telemetry, 'snapshot_committed', {
            phase: !previous || previous.activities.all === null ? 'initial' : 'incremental',
            outcome: activitiesUnchanged ? 'freshness_saved' : 'saved',
            rows: Object.values(snapshot.items).reduce((sum, rows) => sum + rows.length, 0),
            requests: telemetry.requests,
          });
          if (activitiesUnchanged) logCacheEvent('activities_unchanged');
        }
        this.retryRequired = false;
        return snapshot.items;
      } catch (error) {
        logLibrarySync(telemetry, 'sync_failed', {
          phase: syncPhase,
          outcome: 'previous_snapshot_preserved',
          reason: error instanceof LibrarySyncLimitError ? 'partition_exhausted'
            : error instanceof SimklApiError && error.upstreamCode === 'max_items' ? 'max_items' : 'upstream_or_validation',
          requests: telemetry.requests,
        });
        // Failed manual checks must not turn into unbounded forced retries.
        // A pending mutation or failed ordinary read still requires retry.
        if (!force || retryPending) this.retryRequired = true;
        throw error;
      }
    });
  }

  invalidate(): Promise<void> {
    return this.enqueue(async () => {
      this.retryRequired = true;
      const previous = await this.store.load();
      if (previous) {
        if (previous.version !== 1) throw new Error('Unsupported library cache schema');
        if (this.store.saveFreshness) await this.store.saveFreshness({ ...previous, forceCheck: true });
        else await this.store.save({ ...previous, forceCheck: true });
      }
    });
  }

  completeInitialization(): Promise<void> {
    return this.enqueue(async () => { this.retryRequired = false; });
  }

  write<T = unknown>(token: string, endpoint: string, options: Omit<RequestOptions, 'method' | 'token'> & { method?: 'POST' } = {}): Promise<T> {
    return this.enqueue(async () => {
      const allowed = new Set(['/scrobble/start', '/scrobble/pause', '/scrobble/stop', '/sync/add-to-list', '/sync/history', '/sync/history/remove', '/sync/ratings', '/sync/ratings/remove']);
      if (!allowed.has(endpoint)) throw new Error('Unsupported Simkl write endpoint');
      if (!token) throw new Error('Simkl authentication required');
      const request = () => this.client.request<T>(endpoint, { ...options, method: 'POST', token, rateLimitRetry: false });
      let result: T;
      try {
        result = await request();
      } catch (error) {
        if (!(error instanceof SimklApiError)
          || (error.upstreamCode !== 'rate_limit' && error.upstreamCode !== 'write_lock')) throw error;
        await this.wait(1000);
        result = await request();
      }

      this.retryRequired = true;
      try {
        const previous = await this.store.load();
        if (previous) {
          if (previous.version !== 1) throw new Error('Unsupported library cache schema');
          if (!previous.forceCheck) {
            if (this.store.saveFreshness) await this.store.saveFreshness({ ...previous, forceCheck: true });
            else await this.store.save({ ...previous, forceCheck: true });
          }
        }
      } catch {
        // The upstream mutation is already successful. Preserve retry intent in
        // memory and report the cache failure without making the POST again.
        throw new LibraryWriteInvalidationError();
      }
      return result;
    });
  }
}
