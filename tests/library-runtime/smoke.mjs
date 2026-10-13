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
        if (url.pathname === '/sync/activities') return Response.json({ all: '2026-10-09T12:00:00Z', settings: { all: '2026-10-09T12:00:00Z' } });
        if (url.pathname === '/users/settings') return Response.json({ account: { id: 42 }, timezone: 'UTC' });
        if (url.pathname === '/users/42/stats') return Response.json({ total_mins: 120 });
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
  await read('43');
  assert.equal(calls.length, 10);
  await mf.dispose(); mf = runtime();
  assert.deepEqual(await read(), a);
  const reconstructedProfile = await stats();
  assert.deepEqual(reconstructedProfile.stats, { total_mins: 120 });
  assert.equal(calls.length, 10, 'reconstructed object must use persisted library and profile records');
  console.log('PASS: Worker RPC, coalescing, per-user isolation, profile caching, and SQLite persistence after runtime reconstruction');
} finally {
  if (mf) await mf.dispose();
  await rm(persist, { recursive: true, force: true });
}
