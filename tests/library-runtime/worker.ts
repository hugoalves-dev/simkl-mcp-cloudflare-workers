import { SimklLibraryCache } from '../../src/library/cache';
export { SimklLibraryCache };
export default {
  async fetch(request: Request, env: { SIMKL_LIBRARY_CACHE: DurableObjectNamespace<SimklLibraryCache> }) {
    const userId = new URL(request.url).searchParams.get('user') ?? '42';
    const object = env.SIMKL_LIBRARY_CACHE.get(env.SIMKL_LIBRARY_CACHE.idFromName(`simkl-library:v1:${userId}`));
    const result = await object.ensureInitialized('fixture-operation-token');
    if (new URL(request.url).searchParams.get('stats') === '1') {
      return Response.json({ ...result, stats: await object.getStats('fixture-operation-token', userId) });
    }
    return Response.json({ ...result, items: await object.readItems() });
  },
};
