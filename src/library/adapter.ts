import type { SimklClient } from '../api/client';
import { normalizeSimklId } from './identity';
type SimklAuthProps = { simklToken: string; simklUserId?: string };
import type { SimklLibraryCache } from './cache';
import type { LibraryItems } from './types';
export interface LibraryAdapter {
  read(force?: boolean): Promise<LibraryItems>;
  invalidate(): Promise<void>;
}
export const verifiedAccountId = normalizeSimklId;
export function createLibraryAdapter(env: { SIMKL_LIBRARY_CACHE: DurableObjectNamespace<SimklLibraryCache> }, client: SimklClient, getProps: () => SimklAuthProps | undefined): LibraryAdapter {
  let memo: { token: string; promise: Promise<string> } | undefined;
  async function stub() {
    const props = getProps();
    const token = props?.simklToken;
    if (!token) throw new Error('Simkl authentication required');
    let userId = verifiedAccountId(props?.simklUserId);
    if (!userId) {
      if (!memo || memo.token !== token) {
        const promise = (async () => {
          const settings = await client.request<{ account?: { id?: unknown } }>('/users/settings', { method: 'GET', token });
          const id = verifiedAccountId(settings?.account?.id);
          if (!id) throw new Error('Unable to verify Simkl account for library cache');
          return id;
        })();
        const entry = { token, promise }; memo = entry;
        void promise.catch(() => { if (memo === entry) memo = undefined; });
      }
      userId = await memo.promise;
    }
    return { object: env.SIMKL_LIBRARY_CACHE.get(env.SIMKL_LIBRARY_CACHE.idFromName(`simkl-library:v1:${userId}`)), token };
  }
  return {
    async read(force = false) { const { object, token } = await stub(); return object.read(token, force); },
    async invalidate() { const { object } = await stub(); await object.invalidate(); },
  };
}
