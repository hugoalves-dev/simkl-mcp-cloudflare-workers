import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
let SimklMCP: typeof import('../src/mcp-agent').SimklMCP;
beforeAll(async () => {
  mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, RpcTarget: class {}, exports: {}, env: {} }));
  mock.module('cloudflare:email', () => ({ EmailMessage: class {} }));
  ({ SimklMCP } = await import('../src/mcp-agent'));
});
async function setup(readError?: Error, refreshResult: { status: 'refreshed' | 'suppressed'; retryAfterSeconds?: number } = { status: 'refreshed' }) {
  const tools = new Map<string, any>(), resources = new Map<string, any>(), calls: unknown[] = [];
  const items = { shows: [{ status: 'watching', show: { ids: { simkl: 1 }, title: 'Title', year: 2020 }, added_to_watchlist_at: '2026-10-01T00:00:00Z' }], anime: [], movies: [] };
  const agent = Object.create(SimklMCP.prototype);
  Object.defineProperty(agent, 'env', { value: { SIMKL_CLIENT_ID: 'id', SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async read(token: string, force: boolean) { calls.push({ token, force }); if (readError) throw readError; return items; }, async refreshLibrary(token: string) { calls.push({ token, manualRefresh: true }); if (readError) throw readError; return refreshResult; }, async invalidate() { calls.push('invalidate'); }, async getSettings() { return { account: { type: 'pro' } }; }, async invalidateSettings() {}, async write(token: string, path: string, options: any) { calls.push({ write: path, token, options }); return path === '/scrobble/stop' ? { action: 'scrobble', rewatch_id: 1 } : {}; } }) } } });
  Object.defineProperty(agent, 'props', { value: { simklToken: 'token', simklUserId: '42' } });
  Object.defineProperty(agent, 'server', { value: {
    registerTool(name: string, _: unknown, callback: any) { tools.set(name, callback); },
    registerResource(name: string, _: unknown, __: unknown, callback: any) { resources.set(name, callback); },
  } });
  await agent.init();
  return { tools, resources, calls };
}
test('MCP refresh tool uses the per-account cooldown RPC', async () => {
  const s = await setup(); const result = await s.tools.get('simkl_refresh_library')({});
  expect(s.calls).toEqual([{ token: 'token', manualRefresh: true }]);
  expect(result.content[0].text).toBe('Simkl library refreshed');
});
test('MCP refresh tool clearly reports cooldown without claiming an upstream check happened', async () => {
  const s = await setup(undefined, { status: 'suppressed', retryAfterSeconds: 31 });
  const result = await s.tools.get('simkl_refresh_library')({});
  expect(result.isError).not.toBe(true);
  expect(result.content[0].text).toContain('skipped');
  expect(result.content[0].text).toContain('31 seconds');
  expect(result.content[0].text).not.toContain('library refreshed');
});
test('MCP resource and watchlist tool both route through cache', async () => {
  globalThis.fetch = (async () => { throw new Error('unexpected raw request'); }) as typeof fetch;
  const s = await setup();
  const tool = await s.tools.get('simkl_get_watchlist')({ type: 'shows', status: 'watching' });
  const resource = await s.resources.get('watchlist')(new URL('simkl://watchlist/shows/watching'), { type: 'shows', status: 'watching' });
  expect(tool.content[0].text).toBe('Title (2020) | status: watching | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/tv/1>');
  expect(resource.contents[0].text).toBe(tool.content[0].text); expect(s.calls).toHaveLength(2);
});
test('actual MCP mutation integration routes writes through the same verified cache account', async () => {
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  const s = await setup(); await s.tools.get('simkl_add_rating')({}); expect((s.calls[0] as any).write).toBe('/sync/ratings');
});
for (const name of ['simkl_start_rewatch', 'simkl_update_rewatch', 'simkl_stop_watching']) test(name+' routes successful manual mutations through the shared writer', async () => {
  globalThis.fetch = (async () => { throw new Error('rewatch should use cached settings, not raw Simkl requests'); }) as typeof fetch;
  const s = await setup();
  const args = name === 'simkl_stop_watching' ? { body: { progress: 95 } } : { mediaType: 'movies', ids: { simkl: 1 }, rewatch_id: 1 };
  const result = await s.tools.get(name)(args);
  expect(result.isError).not.toBe(true); expect((s.calls[0] as any).write).toBe(name === 'simkl_stop_watching' ? '/scrobble/stop' : '/sync/history');
});

for (const name of ['simkl_get_watchlist', 'simkl_refresh_library']) test(name+' retains quota guidance for Worker RPC failures', async () => {
  const rpcError = Object.assign(new Error('sensitive upstream response'), { name: 'SimklApiError', statusCode: 429, upstreamCode: 'user_limit_exceeded', headers: { retryAfter: '3600', rateLimitRemaining: '0' } });
  const s = await setup(rpcError); const result = await s.tools.get(name)({ type: 'shows', status: 'watching' });
  expect(result.isError).toBe(true); expect(result.content[0].text).toContain('daily'); expect(result.content[0].text).toContain('Retry-After: 3600'); expect(result.content[0].text).not.toContain('sensitive');
});
