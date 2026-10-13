import { DurableObject } from 'cloudflare:workers';
import { SimklClient } from '../api/client.js';
import { LibraryStore } from './store.js';
import { CachedLibrary } from './coordinator';
import { parseLibraryCacheTtlSeconds } from './refresh';
import { fetchInitialLibrary } from './sync.js';
import type { LibraryInitialization, LibraryItemRow } from './types.js';

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

  constructor(ctx: DurableObjectState, env: LibraryCacheEnv) {
    super(ctx, env);
    this.store = new LibraryStore(ctx.storage);
    this.client = new SimklClient({ baseUrl: env.SIMKL_API_BASE_URL || 'https://api.simkl.com', clientId: env.SIMKL_CLIENT_ID });
    this.library = new CachedLibrary({
      load: async () => this.store.loadSnapshot(),
      save: async snapshot => { this.store.saveSnapshot(snapshot); },
    }, this.client, parseLibraryCacheTtlSeconds(env.SIMKL_LIBRARY_CACHE_TTL_SECONDS));
  }

  async ensureInitialized(accessToken: string): Promise<LibraryInitialization> {
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
    return this.store.commit(candidate);
  }

  async read(accessToken: string, force = false) {
    const initialized = this.store.getInitialization() !== null;
    await this.ensureInitialized(accessToken);
    return this.library.read(accessToken, force && initialized);
  }

  invalidate() { return this.library.invalidate(); }

  async readItems(): Promise<LibraryItemRow[]> {
    if (!this.store.getInitialization()) throw new Error('Library cache is not initialized');
    return this.store.readItems();
  }
}
