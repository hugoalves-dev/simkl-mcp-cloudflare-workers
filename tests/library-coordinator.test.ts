import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { CachedLibrary } from '../src/library/coordinator';
import type { LibrarySnapshot } from '../src/library/types';
const original = globalThis.fetch; afterEach(() => { globalThis.fetch = original; });
const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'id' });
function setup(wait = async (_ms: number) => {}) {
  let saved: any; let failSave = false; let now = 300_000;
  const store = { async load() { return structuredClone(saved); }, async save(value: any) { if (failSave) throw new Error('storage failure'); saved = structuredClone(value); } };
  const cache = new CachedLibrary(store, client, 300, () => now, wait);
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

test('write retries only exact per-second rate_limit once after one second', async () => {
  const waits: number[] = [], s = setup(async ms => { waits.push(ms); });
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return attempts === 1 ? Response.json({ error: 'rate_limit' }, { status: 429 }) : Response.json({ added: {} });
  }) as typeof fetch;
  await (s.cache as any).write('secret-token', '/sync/history', { method: 'POST', body: { movies: [{ ids: { simkl: 1 } }] } });
  expect(attempts).toBe(2); expect(waits).toEqual([1000]); expect(s.saved()).toBeUndefined();
});

test('a second rate_limit ends the write after exactly two attempts', async () => {
  const waits: number[] = [], s = setup(async ms => { waits.push(ms); }); let attempts = 0;
  globalThis.fetch = (async () => { attempts++; return Response.json({ error: 'rate_limit' }, { status: 429 }); }) as typeof fetch;
  await expect((s.cache as any).write('token', '/sync/history', { method: 'POST', body: {} })).rejects.toBeDefined();
  expect(attempts).toBe(2); expect(waits).toEqual([1000]);
});

test('write does not retry daily limits or ambiguous network failures', async () => {
  for (const failure of [Response.json({ error: 'user_limit_exceeded' }, { status: 429 }), new Error('network')]) {
    const waits: number[] = [], s = setup(async ms => { waits.push(ms); }); let attempts = 0;
    globalThis.fetch = (async () => { attempts++; if (failure instanceof Error) throw failure; return failure; }) as typeof fetch;
    await expect((s.cache as any).write('secret-token', '/sync/history', { method: 'POST', body: {} })).rejects.toBeDefined();
    expect(attempts).toBe(1); expect(waits).toEqual([]);
  }
});

test('successful write and forced-refresh persistence finish before the next queued read', async () => {
  const s = setup();
  upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token');
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  let writeStarted = false;
  globalThis.fetch = (async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/sync/history') { writeStarted = true; await barrier; return Response.json({ added: {} }); }
    if (path === '/sync/activities') return Response.json({ all: '2026-10-02T00:00:00Z' });
    const media = new URL(String(input)).pathname.split('/')[3];
    if (media === 'shows') return Response.json({ shows: items.shows });
    return Response.json({ [media]: [] });
  }) as typeof fetch;
  const write = (s.cache as any).write('secret-token', '/sync/history', { method: 'POST', body: {} });
  while (!writeStarted) await Promise.resolve();
  const read = s.cache.read('token');
  finish();
  await Promise.all([write, read]);
  expect(s.saved().forceCheck).toBe(false);
  expect(s.saved().activities.all).toBe('2026-10-02T00:00:00Z');
});

test('same account writes serialize and a different account coordinator stays independent', async () => {
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const order: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? '{}'));
    const id = payload.movies?.[0]?.ids?.simkl ?? payload.shows?.[0]?.ids?.simkl;
    order.push(String(id));
    if (id === 1) await barrier;
    return Response.json({});
  }) as typeof fetch;
  const one = setup(), other = setup();
  const first = (one.cache as any).write('token', '/sync/history', { method: 'POST', body: { movies: [{ ids: { simkl: 1 } }] } });
  const second = (one.cache as any).write('token', '/sync/ratings', { method: 'POST', body: { movies: [{ ids: { simkl: 2 } }] } });
  const independent = (other.cache as any).write('token', '/sync/history', { method: 'POST', body: { shows: [{ ids: { simkl: 3 } }] } });
  await Promise.resolve();
  expect([...order].sort()).toEqual(['1', '3']);
  finish(); await Promise.all([first, second, independent]);
  expect(order).toEqual(['1', '3', '2']);
});

test('write persistence failure reports success without repeating upstream write', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('token'); s.fail(true); let attempts = 0;
  globalThis.fetch = (async () => { attempts++; return Response.json({ added: {} }); }) as typeof fetch;
  await expect((s.cache as any).write('token', '/sync/history', { method: 'POST', body: {} })).rejects.toThrow('Upstream write succeeded, but library cache invalidation failed');
  s.fail(false);
  expect(attempts).toBe(1); const reads = upstream([{ all: '2026-10-02T00:00:00Z' }]); await s.cache.read('token'); expect(reads()).toBe(1);
});

test('successful write persists forced-refresh intent without persisting the access token', async () => {
  const s = setup(); upstream([activities, items, { movies: [] }, { anime: [] }]); await s.cache.read('secret-write-token');
  globalThis.fetch = (async () => Response.json({ added: {} })) as typeof fetch;
  await (s.cache as any).write('secret-write-token', '/sync/history', { method: 'POST', body: { movies: [] } });
  expect(s.saved().forceCheck).toBe(true);
  expect(JSON.stringify(s.saved())).not.toContain('secret-write-token');
});


test('coordinator saves only freshness for unchanged activities, invalidation and successful writes', async () => {
  const snapshot = {
    version: 1 as const,
    items: { shows: [{ status: 'watching', show: { ids: { simkl: 1 } } }], movies: [], anime: [] },
    activities,
    checkedAt: 1,
    forceCheck: false,
  };
  let saved: LibrarySnapshot = structuredClone(snapshot);
  let itemSnapshots = 0, freshnessWrites = 0;
  const store = {
    async load() { return structuredClone(saved); },
    async save(value: LibrarySnapshot) { itemSnapshots++; saved = structuredClone(value); },
    async saveFreshness(value: { checkedAt: number; forceCheck: boolean }) {
      freshnessWrites++;
      saved = { ...saved, checkedAt: value.checkedAt, forceCheck: value.forceCheck };
    },
  };
  const cache = new CachedLibrary(store, client, 300, () => 400_000);
  await cache.invalidate();
  expect(saved.forceCheck).toBe(true);
  upstream([activities]);
  await cache.read('token');
  expect(saved.forceCheck).toBe(false);
  expect(saved.checkedAt).toBe(400_000);
  upstream([{ added: {} }]);
  await cache.write('token', '/sync/history', { body: {} });
  expect(saved.forceCheck).toBe(true);
  expect(itemSnapshots).toBe(0);
  expect(freshnessWrites).toBe(3);
});
