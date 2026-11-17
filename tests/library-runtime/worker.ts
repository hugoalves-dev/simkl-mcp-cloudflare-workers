import { SimklLibraryCache } from '../../src/library/cache';
import { decodeRpcError } from '../../src/api/rpc-errors';
import { customListErrorResult } from '../../src/api/custom-lists';
export { SimklLibraryCache };
export default {
  async fetch(request: Request, env: { SIMKL_LIBRARY_CACHE: DurableObjectNamespace<SimklLibraryCache> }) {
    const userId = new URL(request.url).searchParams.get('user') ?? '42';
    const object = env.SIMKL_LIBRARY_CACHE.get(env.SIMKL_LIBRARY_CACHE.idFromName(`simkl-library:v1:${userId}`));
    if (new URL(request.url).searchParams.get('settings') === '1') {
      return Response.json({ settings: await object.getSettings('fixture-operation-token') });
    }
    if (new URL(request.url).searchParams.get('invalidate-settings') === '1') {
      await object.invalidateSettings('fixture-operation-token');
      return Response.json({ ok: true });
    }
    const list = new URL(request.url).searchParams.get('list');
    if (list) {
      // Exercise the real RPC boundary: errors arrive as plain Errors here.
      try { return Response.json({ data: (await object.customListRequest('fixture-operation-token', `/lists/${list}`, { method: 'GET' })).data }); }
      catch (error) {
        const decoded = decodeRpcError(error) as { name?: string; statusCode?: number; upstreamCode?: string };
        return Response.json({ name: decoded?.name, statusCode: decoded?.statusCode, upstreamCode: decoded?.upstreamCode, text: customListErrorResult(decoded, false).content[0].text });
      }
    }
    if (new URL(request.url).searchParams.get('stats') === '1') {
      return Response.json({ stats: await object.getStats('fixture-operation-token', userId) });
    }
    const result = await object.ensureInitialized('fixture-operation-token');
    return Response.json({ ...result, items: await object.readItems() });
  },
};
