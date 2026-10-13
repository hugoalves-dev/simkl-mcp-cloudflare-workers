import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory = await mkdtemp(join(tmpdir(), 'simkl-library-runtime-'));
const entry = `
import { SimklLibraryCache } from './src/library/cache';
import { SimklClient } from './src/api/client';
import { createLibraryAdapter } from './src/library/adapter';
import { selectWatchlist } from './src/library/watchlist';
import { registerTools } from './generated/tools';
import { toMcpErrorResult } from './src/api/errors';
export { SimklLibraryCache };
export default { async fetch(request, env) {
 const url = new URL(request.url), user = url.searchParams.get('user') || '42';
 const client = new SimklClient({ baseUrl: 'https://simkl.test', clientId: 'synthetic-id' });
 const adapter = createLibraryAdapter(env, client, () => ({ simklToken: 'synthetic-token', simklUserId: user }));
 if (url.pathname === '/quota-watchlist') {
   const callbacks = new Map();
   registerTools({ registerTool(name, _, callback) { callbacks.set(name, callback); } }, client, () => 'synthetic-token', { getWatchlist: async args => selectWatchlist(await adapter.read(), args) });
   return Response.json(await callbacks.get('simkl_get_watchlist')({ type: 'shows', status: 'completed' }));
 }
 if (url.pathname === '/quota-refresh') {
   try { await adapter.read(true); return Response.json({ content: [] }); }
   catch (error) { return Response.json(toMcpErrorResult(error)); }
 }
 const cache = env.SIMKL_LIBRARY_CACHE.get(env.SIMKL_LIBRARY_CACHE.idFromName('simkl-library:v1:' + user));
 if (url.pathname === '/invalidate') { await cache.invalidate(); return new Response('ok'); }
 try { return Response.json(await cache.read('synthetic-token', url.searchParams.has('force'))); }
 catch { return new Response('refresh failed', { status: 502 }); }
} };`;
const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
let mode = 'initial', calls = [];
const oldDate = '2026-10-01T00:00:00Z', newDate = '2026-10-02T00:00:00Z';
const item = status => ({ status, show: { ids: { simkl: 1 }, title: 'Title' } });
const config = {
 modules: true, script: result.outputFiles[0].text,
 compatibilityDate: '2026-10-01',
 durableObjects: { SIMKL_LIBRARY_CACHE: { className: 'SimklLibraryCache', useSQLite: true } },
 
 bindings: { SIMKL_CLIENT_ID: 'synthetic-id', SIMKL_API_BASE_URL: 'https://simkl.test', SIMKL_LIBRARY_CACHE_TTL_SECONDS: '300' },
 outboundService: async request => {
  const url = new URL(request.url); calls.push(url.pathname);
  if (mode === 'quota') return Response.json({ error: 'user_limit_exceeded', secret: 'sensitive-upstream-body' }, { status: 429, headers: { 'Retry-After': '3600', 'X-RateLimit-Remaining': '0' } });
  if (url.pathname === '/sync/activities') return Response.json({ all: mode === 'initial' ? oldDate : newDate, tv_shows: { completed: mode === 'initial' ? oldDate : newDate, rated_at: mode === 'fail' ? newDate : oldDate } });
  if (url.pathname.startsWith('/sync/all-items/')) return Response.json({ [url.pathname.split('/')[3]]: url.pathname.endsWith('/shows') ? [item('watching')] : [] });
  if (url.pathname === '/sync/all-items') return Response.json({ shows: [item(mode === 'initial' ? 'watching' : 'completed')] });
  if (url.pathname === '/sync/ratings' && mode === 'fail') return new Response('failed', { status: 503 });
  if (url.pathname === '/sync/ratings') return Response.json(null);
  throw new Error('unexpected endpoint');
 },
};
let mf;
try {
 mf = new Miniflare({ ...convertV4MiniflareOptions(config), resourcePersistencePath: directory });
 const read = async (query = '') => { const response = await mf.dispatchFetch('http://cache.test/read' + query); assert.equal(response.status, 200); return response.json(); };
 assert.equal((await read()).shows[0].status, 'watching'); assert.deepEqual(calls, ['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
 await read(); assert.equal(calls.length, 4);
 mode = 'fail'; assert.equal((await mf.dispatchFetch('http://cache.test/read?force')).status, 502);
 assert.equal((await mf.dispatchFetch('http://cache.test/read')).status, 502); // ordinary read retries even inside TTL
 mode = 'initial';
 assert.equal((await read()).shows[0].status, 'watching'); // old snapshot survived failed staged delta
 mode = 'fail'; assert.equal((await mf.dispatchFetch('http://cache.test/read?force')).status, 502);
 const beforeRestart = calls.length; mode = 'initial';
 await mf.dispose(); mf = new Miniflare({ ...convertV4MiniflareOptions(config), resourcePersistencePath: directory });
 assert.equal((await read()).shows[0].status, 'watching'); // real SQLite persisted across runtime reconstruction
 assert.equal(calls.length, beforeRestart + 1); // persisted force flag required activities check after restart
 mode = 'changed'; await mf.dispatchFetch('http://cache.test/invalidate');
 assert.equal((await read()).shows[0].status, 'completed');
 const count = calls.length; await read(); assert.equal(calls.length, count);
 await read('?user=43'); assert.equal(calls.length, count + 4); // independent user initializes
 mode = 'quota'; await mf.dispatchFetch('http://cache.test/invalidate');
 for (const path of ['/quota-watchlist', '/quota-refresh']) {
   const response = await mf.dispatchFetch('http://cache.test' + path); const result = await response.json();
   assert.equal(result.isError, true); assert.match(result.content[0].text, /AUTH V2 daily allowance/); assert.match(result.content[0].text, /Retry-After: 3600/); assert.equal(JSON.stringify(result).includes('sensitive-upstream-body'), false);
 }
 console.log('real Worker RPC / SQLite persistence / failed refresh / invalidation / user isolation: PASS');
} finally { if (mf) await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
