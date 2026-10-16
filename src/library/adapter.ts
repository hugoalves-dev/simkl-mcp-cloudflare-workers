import { SimklApiError, type RequestOptions, type SimklResponseHeaders, type SimklClient } from '../api/client';
import { normalizeSimklId } from './identity';
type SimklAuthProps = { simklToken: string; simklUserId?: string };
import type { SimklLibraryCache } from './cache';
import type { LibraryItems } from './types';
import { LibraryWriteInvalidationError } from './errors';
export interface LibraryAdapter {
  read(force?: boolean): Promise<LibraryItems>;
  invalidate(): Promise<void>;
  getStats(): Promise<Record<string, unknown>>;
  getSettings(expectedToken?: string): Promise<Record<string, unknown>>;
  invalidateSettings(expectedToken?: string): Promise<void>;
  write(path: string, options: Omit<RequestOptions, 'token' | 'method'> & { method: 'POST' }, token?: string): Promise<unknown>;
}
export const verifiedAccountId = normalizeSimklId;
function restoreRpcError(error: unknown): unknown {
  if (error instanceof SimklApiError) return error;
  if (!error || typeof error !== 'object') return error;
  const remote = error as Record<string, unknown>;
  const status = remote.statusCode;
  if (remote.name !== 'SimklApiError' || typeof status !== 'number' || !Number.isInteger(status)
    || !(status === 0 || (status >= 100 && status <= 599))) return error;
  const headers: SimklResponseHeaders = {};
  if (remote.headers && typeof remote.headers === 'object') {
    const values = remote.headers as Record<string, unknown>;
    for (const key of ['rateLimitLimit', 'rateLimitRemaining', 'retryAfter', 'lastModified'] as const) {
      if (typeof values[key] === 'string') headers[key] = values[key];
    }
  }
  const code = typeof remote.upstreamCode === 'string' ? remote.upstreamCode : '';
  return new SimklApiError('Simkl request failed', status, JSON.stringify({ error: code }), headers);
}
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
    return { object: env.SIMKL_LIBRARY_CACHE.get(env.SIMKL_LIBRARY_CACHE.idFromName(`simkl-library:v1:${userId}`)), token, userId };
  }
  function restoreRemoteError(error: unknown): never {
    if (error instanceof SimklApiError || error instanceof LibraryWriteInvalidationError) throw error;
    if (error && typeof error === 'object') {
      const remote = error as Record<string, unknown>;
      if (remote.name === 'LibraryWriteInvalidationError') throw new LibraryWriteInvalidationError();
      const status = remote.statusCode;
      if (remote.name === 'SimklApiError' && typeof status === 'number' && Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599))) {
        const headers: SimklResponseHeaders = {};
        if (remote.headers && typeof remote.headers === 'object') {
          const values = remote.headers as Record<string, unknown>;
          for (const key of ['rateLimitLimit', 'rateLimitRemaining', 'retryAfter', 'lastModified'] as const) {
            if (typeof values[key] === 'string') headers[key] = values[key];
          }
        }
        const code = typeof remote.upstreamCode === 'string' ? remote.upstreamCode : '';
        throw new SimklApiError('Simkl request failed', status, JSON.stringify({ error: code }), headers);
      }
    }
    throw error;
  }
  return {
    async read(force = false) {
      const { object, token } = await stub();
      try { return await object.read(token, force); }
      catch (error) { throw restoreRpcError(error); }
    },
    async invalidate() { const { object } = await stub(); await object.invalidate(); },
    async getStats() {
      const { object, token, userId } = await stub();
      try { return await object.getStats(token, userId); }
      catch (error) { throw restoreRpcError(error); }
    },
    async getSettings(expectedToken) {
      const { object, token } = await stub();
      if (expectedToken !== undefined && token !== expectedToken) throw new Error('Simkl account token changed during rewatch authorization; retry the operation');
      try { return await object.getSettings(token); }
      catch (error) { throw restoreRpcError(error); }
    },
    async invalidateSettings(expectedToken) {
      const { object, token } = await stub();
      if (expectedToken !== undefined && token !== expectedToken) throw new Error('Simkl account token changed during rewatch authorization; retry the operation');
      try { await object.invalidateSettings(token); }
      catch (error) { throw restoreRpcError(error); }
    },
    async write(path, options, expectedToken) {
      const { object, token } = await stub();
      if (expectedToken !== undefined && token !== expectedToken) throw new Error('Simkl account token changed during write authorization; retry the operation');
      try { return await object.write(token, path, options); }
      catch (error) { return restoreRemoteError(error); }
    },
  };
}
