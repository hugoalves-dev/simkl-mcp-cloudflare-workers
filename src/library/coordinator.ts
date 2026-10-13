import type { SimklClient } from '../api/client';
import type { LibraryItems, LibrarySnapshot } from './types';
import { refreshLibrary } from './refresh';
export interface LibraryStore {
  load(): Promise<LibrarySnapshot | undefined>;
  save(snapshot: LibrarySnapshot): Promise<void>;
}
/** Serializes network refresh and persistence, including cross-session invalidation. */
export class CachedLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  private retryRequired = false;
  constructor(private store: LibraryStore, private client: SimklClient, private ttlSeconds: number, private now: () => number = Date.now) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  /** Runs a related cache operation in the same queue as library refreshes and invalidations. */
  withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }
  read(token: string, force = false): Promise<LibraryItems> {
    return this.enqueue(async () => {
      try {
        if (!token) throw new Error('Simkl authentication required');
        let previous = await this.store.load();
        const forceRefresh = force || this.retryRequired;
        // Persist retry intent before a forced attempt so failures and object
        // restarts cannot re-enter the TTL shortcut with stale library data.
        if (forceRefresh && previous && !previous.forceCheck) {
          if (previous.version !== 1) throw new Error('Unsupported library cache schema');
          previous = { ...previous, forceCheck: true };
          await this.store.save(previous);
        }
        const snapshot = await refreshLibrary(this.client, token, previous, { ttlSeconds: this.ttlSeconds, now: this.now(), force: forceRefresh });
        if (snapshot !== previous) await this.store.save(snapshot);
        this.retryRequired = false;
        return snapshot.items;
      } catch (error) {
        // Preserve retry intent in memory if storage itself could not save it.
        this.retryRequired = true;
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
        await this.store.save({ ...previous, forceCheck: true });
      }
    });
  }
}
