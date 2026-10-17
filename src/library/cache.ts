import { DurableObject } from 'cloudflare:workers';
import { SimklClient } from '../api/client.js';
import { LibraryStore } from './store.js';
import { CachedLibrary } from './coordinator';
import { parseLibraryCacheTtlSeconds } from './refresh';
import { fetchInitialLibrary } from './sync.js';
import { refreshUserProfile, refreshUserSettings } from './profile.js';
import { normalizeSimklId } from './identity.js';
import type { LibraryInitialization, LibraryItemRow } from './types.js';
import type { RequestOptions } from '../api/client.js';

export interface LibraryCacheEnv {
  SIMKL_CLIENT_ID: string;
  SIMKL_API_BASE_URL?: string;
  SIMKL_LIBRARY_CACHE_TTL_SECONDS?: string;
}

/** One object per verified account, independent of MCP session lifetime. */
export class SimklLibraryCache extends DurableObject<LibraryCacheEnv> {
  private readonly store: LibraryStore;
  private readonly client: SimklClient;
  private readonly library: CachedLibrary;
  private initialization?: Promise<LibraryInitialization>;
  private queue: Promise<unknown> = Promise.resolve();
  private queuedOperations = 0;

  constructor(ctx: DurableObjectState, env: LibraryCacheEnv) {
    super(ctx, env);
    this.store = new LibraryStore(ctx.storage);
    this.client = new SimklClient({ baseUrl: env.SIMKL_API_BASE_URL || 'https://api.simkl.com', clientId: env.SIMKL_CLIENT_ID });
    this.library = new CachedLibrary({
      load: async () => this.store.loadSnapshot(),
      save: async snapshot => { this.store.saveSnapshot(snapshot); },
      saveFreshness: async freshness => { this.store.saveFreshness(freshness); },
    }, this.client, parseLibraryCacheTtlSeconds(env.SIMKL_LIBRARY_CACHE_TTL_SECONDS));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    this.queuedOperations++;
    const run = async () => {
      try { return await operation(); }
      finally { this.queuedOperations--; }
    };
    const result = this.queuedOperations === 1 ? run() : previous.then(run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  ensureInitialized(accessToken: string): Promise<LibraryInitialization> {
    if (this.initialization) return this.initialization;
    return this.enqueue(() => this.ensureInitializedInternal(accessToken));
  }

  private async ensureInitializedInternal(accessToken: string): Promise<LibraryInitialization> {
    const completed = this.store.getInitialization();
    if (completed) return completed;
    if (!this.initialization) {
      if (!accessToken) throw new Error('Simkl authentication required');
      this.initialization = this.initialize(accessToken).finally(() => { this.initialization = undefined; });
    }
    return this.initialization;
  }

  private async initialize(accessToken: string): Promise<LibraryInitialization> {
    // Token belongs only to this operation; never assign it to object or storage state.
    const candidate = await fetchInitialLibrary(this.client, accessToken);
    const completion = this.store.commit(candidate);
    await this.library.completeInitialization();
    return completion;
  }

  read(accessToken: string, force = false) {
    return this.enqueue(async () => {
      const initialized = this.store.getInitialization() !== null;
      await this.ensureInitializedInternal(accessToken);
      return this.library.read(accessToken, force && initialized);
    });
  }

  invalidate() { return this.enqueue(() => this.library.invalidate()); }

  write(accessToken: string, endpoint: string, options: Omit<RequestOptions, 'token' | 'method'> & { method: 'POST' }) {
    return this.enqueue(() => this.library.write(accessToken, endpoint, options));
  }

  readItems(): Promise<LibraryItemRow[]> {
    return this.enqueue(async () => {
      if (!this.store.getInitialization()) throw new Error('Library cache is not initialized');
      return this.store.readItems();
    });
  }

  getStats(accessToken: string, simklUserId: string): Promise<Record<string, unknown>> {
    const userId = normalizeSimklId(simklUserId);
    if (!accessToken) return Promise.reject(new Error('Simkl authentication required'));
    if (!userId) return Promise.reject(new Error('Invalid verified Simkl account ID'));
    return this.enqueue(() => this.library.withExclusive(async () => {
      const previous = this.store.loadProfile();
      const librarySnapshot = this.store.loadActivitySnapshot();
      const result = await refreshUserProfile(this.client, accessToken, userId, previous, librarySnapshot, {
        ttlSeconds: parseLibraryCacheTtlSeconds(this.env.SIMKL_LIBRARY_CACHE_TTL_SECONDS),
        now: Date.now(),
      });
      if (JSON.stringify(previous) !== JSON.stringify(result.snapshot)) this.store.saveProfile(result.snapshot);
      return result.stats;
    }));
  }
  
  /** Reuses the persisted per-account profile without reading the user's statistics. */
  getSettings(accessToken: string): Promise<Record<string, unknown>> {
    if (!accessToken) return Promise.reject(new Error('Simkl authentication required'));
    return this.enqueue(() => this.library.withExclusive(async () => {
      const previous = this.store.loadProfile();
      const result = await refreshUserSettings(this.client, accessToken, previous, this.store.loadActivitySnapshot(), {
        ttlSeconds: parseLibraryCacheTtlSeconds(this.env.SIMKL_LIBRARY_CACHE_TTL_SECONDS),
        now: Date.now(),
      });
      if (JSON.stringify(previous) !== JSON.stringify(result.snapshot)) this.store.saveProfile(result.snapshot);
      // Cloudflare correlates these credential-free events using $metadata.traceId.
      console.info(JSON.stringify({
        component: 'simkl_user_profile',
        event: result.settingsRefreshed ? 'settings_refreshed' : 'settings_cache_hit',
        activitySource: result.activitySource,
      }));
      return result.settings;
    }));
  }

  /** A pro_required upstream response invalidates settings, not the persisted session/library. */
  invalidateSettings(accessToken: string): Promise<void> {
    if (!accessToken) return Promise.reject(new Error('Simkl authentication required'));
    return this.enqueue(() => this.library.withExclusive(async () => {
      const previous = this.store.loadProfile();
      if (!previous?.settings) return;
      const { settings: _settings, settingsActivity: _settingsActivity, ...snapshot } = previous;
      this.store.saveProfile(snapshot);
      console.info(JSON.stringify({ component: 'simkl_user_profile', event: 'settings_invalidated', reason: 'pro_required' }));
    }));
  }

}
