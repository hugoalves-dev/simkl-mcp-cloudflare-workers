import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve Wrangler's tool dependencies without declaring unrelated production deps.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'],
});
const persist = await mkdtemp(join(tmpdir(), 'simkl-library-test-'));
const calls = [];
let active = 0;
let peak = 0;
let memo;
let failMemoDelta = false;
let lockOnce = true;
function runtime() {
  const options = convertV4MiniflareOptions({
    name: 'simkl-library-fixture',
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-01-01',
    durableObjects: { SIMKL_LIBRARY_CACHE: { className: 'SimklLibraryCache', useSQLite: true } },
    bindings: { SIMKL_CLIENT_ID: 'fixture-app', SIMKL_API_BASE_URL: 'https://fixture.simkl.invalid' },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://fixture.simkl.invalid');
      assert.equal(request.headers.get('Authorization'), 'Bearer fixture-operation-token');
      assert.equal(url.searchParams.has('extended'), false);
      calls.push(url.pathname); active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        if (url.pathname === '/users/47/stats') return Response.json({ error: 'user_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '120' } });
        if (url.pathname === '/sync/history/edit-memos') {
          const body = await request.json();
          const attempted = body.movies[0].memo;
          if (attempted.text === 'quota') {
            return Response.json({ error: 'user_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '120' } });
          }
          if (lockOnce) {
            lockOnce = false;
            return Response.json({ error: 'RATE_LIMIT' }, { status: 400 });
          }
          memo = attempted.text ? { text: attempted.text.trim(), is_private: attempted.is_private } : {};
          return Response.json({ updated: { movies: 1, shows: 0, statuses: [{ request: body.movies[0] }] },
            not_found: { movies: [], shows: [], episodes: [] }, errors: [] }, { status: 201 });
        }
        if (url.pathname === '/sync/all-items/movies' && url.searchParams.has('date_from')) {
          assert.equal(url.searchParams.get('date_from'), '2026-10-09T11:59:59.000Z');
          assert.equal(url.searchParams.get('memos'), 'yes');
          if (failMemoDelta) return new Response('read unavailable', { status: 429 });
          return Response.json({ movies: [{ movie: { title: 'Fixture', ids: { simkl: 42 } }, status: 'completed', memo }] });
        }
        if (url.pathname === '/sync/history') return new Response('upstream down', { status: 502 });
        if (url.pathname === '/lists/404') return Response.json({ error: 'url_failed', code: 404, message: 'List not found' }, { status: 404 });
        if (url.pathname === '/lists/429') return Response.json({ error: 'user_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '600' } });
        if (url.pathname === '/sync/activities') return Response.json({ all: '2026-10-09T12:00:00Z', settings: { all: '2026-10-09T12:00:00Z' } });
        if (url.pathname === '/users/settings') return Response.json({ account: { id: 42 }, timezone: 'UTC' });
        if (/^\/users\/\d+\/stats$/.test(url.pathname)) return Response.json({ total_mins: 120 });
        const media = url.pathname.split('/')[3];
        const key = media === 'movies' ? 'movie' : 'show';
        return Response.json({ [media]: [{ [key]: { title: 'Fixture', ids: { simkl: 42 } }, user_rating: 8 }] });
      } finally { active--; }
    },
  });
  // Miniflare 5's converter does not retain the old durableObjectsPersist option.
  options.resourcePersistencePath = persist;
  options.workers[0].dev.unsafeRegisterWorker = false;
  return new Miniflare(options);
}
let mf;
async function read(user = '42') {
  const response = await mf.dispatchFetch(`https://fixture.worker.invalid/?user=${user}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function stats(user = '42') {
  const response = await mf.dispatchFetch(`https://fixture.worker.invalid/?user=${user}&stats=1`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function settings(user = '42') {
  const response = await mf.dispatchFetch(`https://fixture.worker.invalid/?user=${user}&settings=1`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function invalidateSettings(user = '42') {
  const response = await mf.dispatchFetch(`https://fixture.worker.invalid/?user=${user}&invalidate-settings=1`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
try {
  mf = runtime();
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a.itemCount, 3); assert.deepEqual(a, b);
  assert.equal(peak, 1);
  assert.deepEqual(calls, ['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
  assert.equal(JSON.stringify(a).includes('fixture-operation-token'), false);
  for (const row of a.items) assert.equal(JSON.parse(row.itemJson).user_rating, 8);
  const profile = await stats();
  assert.deepEqual(profile.stats, { total_mins: 120 });
  assert.deepEqual(calls.slice(4), ['/users/settings', '/users/42/stats']);
  await stats();
  assert.equal(calls.length, 6, 'fresh profile should avoid repeat settings, stats, and activity requests');
  const uninitializedProfile = await stats('44');
  assert.deepEqual(uninitializedProfile.stats, { total_mins: 120 });
  assert.deepEqual(calls.slice(6), ['/sync/activities', '/users/settings', '/users/44/stats']);
  assert.equal(calls.some(path => path.startsWith('/sync/all-items/')), true);
  assert.equal(calls.filter(path => path.startsWith('/sync/all-items/')).length, 3, 'stats-only access must not initialize another user library');
  await read('43');
  assert.equal(calls.length, 13);
  await mf.dispose(); mf = runtime();
  assert.deepEqual(await read(), a);
  const reconstructedProfile = await stats();
  assert.deepEqual(reconstructedProfile.stats, { total_mins: 120 });
  assert.equal(calls.length, 13, 'reconstructed object must use persisted library and profile records');

  // Different RPC sessions share the same persisted account profile, no second settings GET.
  assert.deepEqual((await settings()).settings.account.id, 42);
  await settings();
  assert.equal(calls.length, 13, 'settings requests must reuse the cached profile after reconstruction');

  // A Simkl pro_required response clears settings only, preserving the library and stats.
  assert.deepEqual(await invalidateSettings(), { ok: true });
  await settings();
  assert.deepEqual(calls.slice(13), ['/users/settings'], 'invalidation must refresh settings without refetching activities or stats');
  assert.deepEqual(await read(), a);
  assert.deepEqual((await stats()).stats, { total_mins: 120 });
  assert.equal(calls.length, 14, 'settings invalidation must preserve library and stats cache');

  // An account with no library or statistics initialized needs only activities + settings.
  assert.deepEqual((await settings('45')).settings.account.id, 42);
  assert.deepEqual(calls.slice(14), ['/sync/activities', '/users/settings']);
  await settings('45');
  assert.equal(calls.length, 16);
  await mf.dispose(); mf = runtime();
  await settings('45');
  assert.equal(calls.length, 16, 'new session after restart must reuse settings-only profile without fetching statistics');
  // Workers RPC drops error classes and fields; list errors must still be recognizable.
  const listError = async id => (await mf.dispatchFetch(`https://fixture.worker.invalid/?user=46&list=${id}`)).json();
  assert.deepEqual(await listError(404), { name: 'SimklApiError', statusCode: 404, upstreamCode: 'url_failed', text: 'Simkl list not found.' });
  const quota = await listError(429);
  assert.equal(quota.upstreamCode, 'user_limit_exceeded');
  const paused = await listError(404);
  assert.equal(paused.name, 'CustomListCooldownError', 'quota cooldown must block the next list request across RPC');
  assert.match(paused.text, /paused for this account for about 600 more seconds/);
  assert.equal(calls.filter(path => path.startsWith('/lists/')).length, 2, 'no upstream request during the cooldown');
  // Library calls through the real adapter keep their Simkl error details across RPC.
  const probe = async (kind, user) => (await mf.dispatchFetch(`https://fixture.worker.invalid/?user=${user}&adapter=${kind}`)).json();
  const quotaStats = await probe('stats', '47');
  assert.equal(quotaStats.name, 'SimklApiError');
  assert.equal(quotaStats.upstreamCode, 'user_limit_exceeded');
  assert.match(quotaStats.text, /daily allowance[\s\S]*Retry-After: 120 seconds/);
  const ambiguousWrite = await probe('write', '48');
  assert.equal(ambiguousWrite.writeMayHaveSucceeded, true);
  assert.match(ambiguousWrite.text, /may have succeeded/);
  assert.equal(calls.filter(path => path === '/sync/history').length, 1, 'an ambiguous write must not be replayed');
  const edit = async text => (await mf.dispatchFetch(`https://fixture.worker.invalid/?edit-memo=${encodeURIComponent(text)}`)).json();
  const cachedItems = async () => (await mf.dispatchFetch('https://fixture.worker.invalid/?items')).json();
  const start = calls.length;
  assert.equal((await edit('  private memo  ')).updated.movies, 1);
  assert.deepEqual(calls.slice(start), ['/sync/history/edit-memos', '/sync/history/edit-memos', '/sync/activities', '/sync/all-items/movies']);
  assert.deepEqual((await cachedItems()).movies[0].memo, { text: 'private memo', is_private: true });

  const beforeQuota = calls.length;
  assert.match((await edit('quota')).content[0].text, /daily allowance[\s\S]*Retry-After: 120 seconds/);
  assert.deepEqual(calls.slice(beforeQuota), ['/sync/history/edit-memos']);

  failMemoDelta = true;
  assert.equal((await edit('')).cache_reconciliation, 'pending');
  await mf.dispose(); mf = runtime();
  failMemoDelta = false;
  const beforeRecovery = calls.length;
  assert.deepEqual((await cachedItems()).movies[0].memo, {});
  assert.deepEqual(calls.slice(beforeRecovery), ['/sync/activities', '/sync/all-items/movies']);
  console.log('PASS: Worker RPC, coalescing, per-user isolation, settings eligibility, and SQLite persistence after reconstruction');
} finally {
  if (mf) await mf.dispose();
  await rm(persist, { recursive: true, force: true });
}
