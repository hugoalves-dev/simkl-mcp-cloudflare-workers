import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
let SimklMCP: typeof import('../src/mcp-agent').SimklMCP;
beforeAll(async () => {
  mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, RpcTarget: class {}, exports: {}, env: {} }));
  mock.module('cloudflare:email', () => ({ EmailMessage: class {} }));
  ({ SimklMCP } = await import('../src/mcp-agent'));
});
async function setup(readError?: Error) {
  const tools = new Map<string, any>(), resources = new Map<string, any>(), calls: unknown[] = [];
  const items = { shows: [{ status: 'watching', show: { ids: { simkl: 1 }, title: 'Title', year: 2020 }, added_to_watchlist_at: '2026-10-01T00:00:00Z' }], anime: [], movies: [] };
  const agent = Object.create(SimklMCP.prototype);
  Object.defineProperty(agent, 'env', { value: { SIMKL_CLIENT_ID: 'id', SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async read(token: string, force: boolean) { calls.push({ token, force }); if (readError) throw readError; return items; }, async invalidate() { calls.push('invalidate'); } }) } } });
  Object.defineProperty(agent, 'props', { value: { simklToken: 'token', simklUserId: '42' } });
  Object.defineProperty(agent, 'server', { value: {
    registerTool(name: string, _: unknown, callback: any) { tools.set(name, callback); },
    registerResource(name: string, _: unknown, __: unknown, callback: any) { resources.set(name, callback); },
  } });
  await agent.init();
  return { tools, resources, calls };
}
test('MCP force refresh tool forwards force to authenticated cache', async () => {
  const s = await setup(); const result = await s.tools.get('simkl_refresh_library')({});
  expect(s.calls).toEqual([{ token: 'token', force: true }]); expect(result.content[0].text).toBe('Simkl library refreshed');
});
test('MCP resource and watchlist tool both route through cache', async () => {
  globalThis.fetch = (async () => { throw new Error('unexpected raw request'); }) as typeof fetch;
  const s = await setup();
  const tool = await s.tools.get('simkl_get_watchlist')({ type: 'shows', status: 'watching' });
  const resource = await s.resources.get('watchlist')(new URL('simkl://watchlist/shows/watching'), { type: 'shows', status: 'watching' });
  expect(tool.content[0].text).toBe('Title (2020) | status: watching | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/tv/1>');
  expect(resource.contents[0].text).toBe(tool.content[0].text); expect(s.calls).toHaveLength(2);
});
test('actual MCP mutation integration invalidates the same verified cache', async () => {
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  const s = await setup(); await s.tools.get('simkl_add_rating')({}); expect(s.calls).toEqual(['invalidate']);
});
for (const name of ['simkl_start_rewatch', 'simkl_update_rewatch', 'simkl_stop_watching']) test(name+' also invalidates after successful manual mutation', async () => {
  globalThis.fetch = (async input => new URL(String(input)).pathname === '/users/settings' ? Response.json({ account: { type: 'pro' } }) : Response.json({ action: 'scrobble', rewatch_id: 1 })) as typeof fetch;
  const s = await setup();
  const args = name === 'simkl_stop_watching' ? { body: { progress: 95 } } : { mediaType: 'movies', ids: { simkl: 1 }, rewatch_id: 1 };
  const result = await s.tools.get(name)(args);
  expect(result.isError).not.toBe(true); expect(s.calls).toEqual(['invalidate']);
});

for (const name of ['simkl_get_watchlist', 'simkl_refresh_library']) test(name+' retains quota guidance for Worker RPC failures', async () => {
  const rpcError = Object.assign(new Error('sensitive upstream response'), { name: 'SimklApiError', statusCode: 429, upstreamCode: 'user_limit_exceeded', headers: { retryAfter: '3600', rateLimitRemaining: '0' } });
  const s = await setup(rpcError); const result = await s.tools.get(name)({ type: 'shows', status: 'watching' });
  expect(result.isError).toBe(true); expect(result.content[0].text).toContain('daily'); expect(result.content[0].text).toContain('Retry-After: 3600'); expect(result.content[0].text).not.toContain('sensitive');
});
