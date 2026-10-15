import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { CachedLibrary } from '../src/library/coordinator';
import { LibraryStore } from '../src/library/store';
import { fetchInitialLibrary } from '../src/library/sync';
import { sqliteStorage } from './helpers/library-storage';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const stamp = '2026-10-14T12:00:00Z';
const empty = { shows: [], movies: [], anime: [] };
const show = { status: 'watching', show: { ids: { simkl: 42 }, title: 'First show' } };
const client = () => new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
function upstream(responses: unknown[]) {
  const calls: URL[] = [];
  globalThis.fetch = (async input => {
    calls.push(new URL(String(input)));
    if (!responses.length) throw new Error('Unexpected upstream request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return Response.json(response);
  }) as typeof fetch;
  return calls;
}
function fixture() {
  const adapter = sqliteStorage();
  let now = 0;
  const store = () => new LibraryStore(adapter.storage);
  const cache = () => new CachedLibrary({
    load: async () => store().loadSnapshot(),
    save: async snapshot => store().saveSnapshot(snapshot),
    saveFreshness: async freshness => store().saveFreshness(freshness),
  }, client(), 300, () => now);
  return { adapter, store, cache, advance: () => { now += 300_000; } };
}

test('initial null activity produces an empty candidate without media pulls', async () => {
  const calls = upstream([{ all: null }]);
  expect(await fetchInitialLibrary(client(), 'token')).toEqual({ activities: { all: null }, items: [] });
  expect(calls.map(url => url.pathname)).toEqual(['/sync/activities']);
});

test('first empty read persists and repeated/restarted reads only check activities after TTL', async () => {
  const f = fixture();
  try {
    const calls = upstream([{ all: null }, { all: null }, { all: null }]);
    const cache = f.cache();
    expect(await cache.read('token')).toEqual(empty);
    expect(f.store().getInitialization()).toEqual({ initialized: true, itemCount: 0 });
    expect(f.store().loadActivitySnapshot()?.activities.all).toBeNull();
    expect(await cache.read('token')).toEqual(empty);
    expect(calls).toHaveLength(1);
    f.advance();
    expect(await cache.read('token')).toEqual(empty);
    expect(await f.cache().read('token')).toEqual(empty);
    expect(calls).toHaveLength(2);
    f.advance();
    expect(await f.cache().read('token')).toEqual(empty);
    expect(calls.map(url => url.pathname)).toEqual(Array(3).fill('/sync/activities'));
  } finally { f.adapter.db.close(); }
});

test('first activity runs full sequential Phase 1 without date_from and persists its snapshot', async () => {
  const f = fixture();
  try {
    upstream([{ all: null }]);
    await f.cache().read('token');
    f.advance();
    // No category markers: a first activity must still pull the complete library.
    const calls = upstream([{ all: stamp }, { shows: [show] }, {}, {}]);
    expect(await f.cache().read('token')).toEqual({ ...empty, shows: [show] });
    expect(calls.map(url => url.pathname)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
    expect(calls.every(url => !url.searchParams.has('date_from'))).toBe(true);
    expect(f.store().loadSnapshot()?.activities.all).toBe(stamp);
    expect(await f.cache().read('token')).toEqual({ ...empty, shows: [show] });
    expect(calls).toHaveLength(4);
  } finally { f.adapter.db.close(); }
});

for (const failedType of ['shows', 'movies', 'anime']) {
  test(`failed first activity at ${failedType} retains the durable empty snapshot and retries Phase 1`, async () => {
    const f = fixture();
    try {
      upstream([{ all: null }]);
      await f.cache().read('token');
      const before = f.store().loadSnapshot();
      f.advance();
      const responses: unknown[] = [{ all: stamp }];
      for (const type of ['shows', 'movies', 'anime']) {
        responses.push(type === failedType ? new Error('transition failed') : type === 'shows' ? { shows: [show] } : {});
        if (type === failedType) break;
      }
      upstream(responses);
      await expect(f.cache().read('token')).rejects.toThrow('simkl api request failed');
      expect(f.store().loadSnapshot()).toEqual(before);
      const calls = upstream([{ all: stamp }, { shows: [show] }, {}, {}]);
      expect(await f.cache().read('token')).toEqual({ ...empty, shows: [show] });
      expect(calls.map(url => url.pathname)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
    } finally { f.adapter.db.close(); }
  });
}
