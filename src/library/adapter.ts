import { SimklApiError, type RequestOptions, type SimklResponseHeaders, type SimklClient } from '../api/client';
import { normalizeSimklId } from './identity';
import { decodeRpcError } from '../api/rpc-errors.js';
import { CustomListCooldownError, CustomListScopeError, type CustomListRequestOptions, type CustomListResponse } from '../api/custom-lists.js';
type SimklAuthProps = { simklToken: string; simklUserId?: string; simklScope?: string };
import type { SimklLibraryCache } from './cache';
import type { LibraryItems } from './types';
import type { RewatchRow } from './rewatches.js';
import { LibrarySyncLimitError, LibraryWriteInvalidationError, SimklAuthRequiredError } from './errors';
export interface LibraryAdapter {
  read(force?: boolean): Promise<LibraryItems>;
  refresh(): Promise<{ status: 'refreshed' | 'suppressed'; retryAfterSeconds?: number }>;
  readRewatches(): Promise<RewatchRow[]>;
  invalidate(): Promise<void>;
  getStats(): Promise<Record<string, unknown>>;
  getSettings(expectedToken?: string): Promise<Record<string, unknown>>;
  invalidateSettings(expectedToken?: string): Promise<void>;
  write(path: string, options: Omit<RequestOptions, 'token' | 'method'> & { method: 'POST' }, token?: string): Promise<unknown>;
  accountId(): Promise<string>;
  customListRequest(path: string, options: CustomListRequestOptions): Promise<CustomListResponse>;
}

/**
 * Only a known AUTH V2 read-only grant (`media:read` without `media:write`) is
 * refused locally. Unknown or V1 (`public`) scopes are left for Simkl to judge.
 */
export function hasMediaWriteScope(scope: unknown): boolean {
  if (typeof scope !== 'string') return true;
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  return !scopes.includes('media:read') || scopes.includes('media:write');
}
export const verifiedAccountId = normalizeSimklId;
function restoreRpcError(rpcError: unknown): unknown {
  const error = decodeRpcError(rpcError);
  if (error instanceof SimklApiError || error instanceof LibrarySyncLimitError || error instanceof CustomListCooldownError) return error;
  if (!error || typeof error !== 'object') return error;
  const remote = error as Record<string, unknown>;
  if (remote.name === 'LibrarySyncLimitError'
    && (remote.phase === 'initial' || remote.phase === 'incremental')
    && ['baseline', 'delta', 'ratings', 'membership'].includes(String(remote.operation))
    && ['shows', 'movies', 'anime'].includes(String(remote.media))
    && (remote.status === undefined || ['watching', 'plantowatch', 'hold', 'completed', 'dropped'].includes(String(remote.status)))) {
    return new LibrarySyncLimitError(
      remote.phase, remote.operation as 'baseline' | 'delta' | 'ratings' | 'membership',
      remote.media as 'shows' | 'movies' | 'anime', remote.status as string | undefined,
    );
  }
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
  return new SimklApiError('Simkl request failed', status, JSON.stringify({ error: code }), headers, remote.writeMayHaveSucceeded === true);
}
export function createLibraryAdapter(env: { SIMKL_LIBRARY_CACHE: DurableObjectNamespace<SimklLibraryCache> }, client: SimklClient, getProps: () => SimklAuthProps | undefined): LibraryAdapter {
  let memo: { token: string; promise: Promise<string> } | undefined;
  async function stub() {
    const props = getProps();
    const token = props?.simklToken;
    if (!token) throw new SimklAuthRequiredError();
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
  function restoreRemoteError(rpcError: unknown): never {
    const error = decodeRpcError(rpcError);
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
        throw new SimklApiError('Simkl request failed', status, JSON.stringify({ error: code }), headers, remote.writeMayHaveSucceeded === true);
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
    async refresh() {
      const { object, token } = await stub();
      try { return await object.refreshLibrary(token); }
      catch (error) { throw restoreRpcError(error); }
    },
    async readRewatches() {
      const { object, token } = await stub();
      try { return await object.readRewatches(token); }
      catch (error) { throw restoreRpcError(error); }
    },
    async invalidate() {
      const { object } = await stub();
      try { await object.invalidate(); }
      catch (error) { throw restoreRpcError(error); }
    },
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
    async accountId() {
      return (await stub()).userId;
    },
    async customListRequest(path, options) {
      if (options.method !== 'GET' && !hasMediaWriteScope(getProps()?.simklScope)) throw new CustomListScopeError();
      const { object, token } = await stub();
      try { return await object.customListRequest(token, path, options); }
      catch (error) { throw decodeRpcError(error); }
    },
    async write(path, options, expectedToken) {
      const { object, token } = await stub();
      if (expectedToken !== undefined && token !== expectedToken) throw new Error('Simkl account token changed during write authorization; retry the operation');
      try { return await object.write(token, path, options); }
      catch (error) { return restoreRemoteError(error); }
    },
  };
}
