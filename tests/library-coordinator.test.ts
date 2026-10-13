import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { CachedLibrary } from '../src/library/coordinator';
const original = globalThis.fetch; afterEach(() => { globalThis.fetch = original; });
const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'id' });
function setup() {
  let saved: any; let failSave = false; let now = 300_000;
  const store = { async load() { return structuredClone(saved); }, async save(value: any) { if (failSave) throw new Error('storage failure'); saved = structuredClone(value); } };
  const cache = new CachedLibrary(store, client, 300, () => now);
  return { cache, store, saved: () => saved, fail: (value: boolean) => { failSave = value; }, now: (value: number) => { now = value; } };
}
function upstream(responses: unknown[]) {
  let count = 0;
  globalThis.fetch = (async () => { count++; const data = responses.shift(); if (data instanceof Error) throw data; return Response.json(data); }) as typeof fetch;
  return () => count;
}
const activities = { all: '2026-10-01T00:00:00Z' };
const items = { shows: [{ status: 'watching', show: { ids: { simkl: 1 }, title: 'Title' } }] };
test('persists atomically and reconstruction serves inside TTL without credentials', async () => {
  const { cache, store, saved } = setup(), count = upstream([activities, items, { movies: [] }, { anime: [] }]);
  await cache.read('secret'); expect(saved().items.shows).toEqual(items.shows); expect(JSON.stringify(saved())).not.toContain('secret');
  const reconstructed = new CachedLibrary(store, client, 300, () => 300_001);
  await reconstructed.read('secret'); expect(count()).toBe(4);
});
test('failed storage leaves previous snapshot and queue recovers', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token'); const old = structuredClone(s.saved());
  s.fail(true); upstream([{ all: '2026-10-02T00:00:00Z', tv_shows: { completed: '2026-10-02T00:00:00Z' } }, { shows: [{ ...items.shows[0], status: 'completed' }] }]);
  await expect(s.cache.read('token', true)).rejects.toThrow('storage failure'); expect(s.saved()).toEqual(old);
  s.fail(false); const count = upstream([activities]); await s.cache.read('token', true); expect(count()).toBe(1);
});
test('concurrent reads share refresh and invalidation queued during refresh survives', async () => {
  const s = setup(); let resolve!: () => void; const barrier = new Promise<void>(r => { resolve = r; }); let count = 0;
  globalThis.fetch = (async input => { count++; if (count === 1) { await barrier; return Response.json(activities); } const type = new URL(String(input)).pathname.split('/')[3]; return Response.json(type === 'shows' ? items : { [type]: [] }); }) as typeof fetch;
  const first = s.cache.read('token'); const second = s.cache.read('token'); const invalidation = s.cache.invalidate();
  resolve(); await Promise.all([first, second, invalidation]); expect(count).toBe(4); expect(s.saved().forceCheck).toBe(true);
  const calls = upstream([activities]); await s.cache.read('token'); expect(calls()).toBe(1); expect(s.saved().forceCheck).toBe(false);
});
test('failed upstream leaves snapshot and immediately retries same watermark', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token'); s.now(600_000);
  const old = structuredClone(s.saved()); upstream([new Error('upstream')]); await expect(s.cache.read('token')).rejects.toThrow(); expect(s.saved()).toEqual(old);
  const count = upstream([activities]); await s.cache.read('token'); expect(count()).toBe(1);
});
test('unsupported schema rejects', async () => {
  const s = setup(); await s.store.save({ version: 2 }); await expect(s.cache.read('token')).rejects.toThrow('schema');
});
test('invalidation before initialization remains a safe no-op', async () => {
  const s = setup(); await s.cache.invalidate(); expect(s.saved()).toBeUndefined();
  const count = upstream([activities, {}, {}, {}]); await s.cache.read('token'); expect(count()).toBe(4);
});
test('failed forced refresh inside TTL persists retry flag for ordinary reads and restart', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token');
  upstream([new Error('failed forced refresh')]); await expect(s.cache.read('token', true)).rejects.toThrow();
  expect(s.saved().activities).toEqual(activities); expect(s.saved().items.shows).toEqual(items.shows);
  expect(s.saved().forceCheck).toBe(true);
  const reconstructed = new CachedLibrary(s.store, client, 300, () => 300_001);
  const count = upstream([activities]); await reconstructed.read('token'); expect(count()).toBe(1); expect(s.saved().forceCheck).toBe(false);
});
test('storage failure while persisting force intent does not throttle the next ordinary read', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token');
  s.fail(true); await expect(s.cache.read('token', true)).rejects.toThrow('storage failure');
  s.fail(false); const count = upstream([activities]); await s.cache.read('token'); expect(count()).toBe(1);
});
test('failed post-write invalidation still forces the next read in the current object', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token');
  s.fail(true); await expect(s.cache.invalidate()).rejects.toThrow('storage failure');
  s.fail(false); const count = upstream([activities]); await s.cache.read('token'); expect(count()).toBe(1);
});
test('exclusive profile operations share the library refresh and invalidation queue', async () => {
  const s = setup();
  expect(typeof s.cache.withExclusive).toBe('function');
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = s.cache.withExclusive(async () => { events.push('first-start'); await barrier; events.push('first-end'); });
  const second = s.cache.withExclusive(async () => { events.push('second'); });
  await Promise.resolve();
  expect(events).toEqual(['first-start']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first-start', 'first-end', 'second']);
});
