import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { parseLibraryCacheTtlSeconds, refreshLibrary } from '../src/library/refresh';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const oldDate = '2026-10-01T00:00:00Z', newDate = '2026-10-02T00:00:00Z';
const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'id' });
const item = (id = 1, status = 'watching') => ({ status, show: { title: 'Title', ids: { simkl: id } }, user_rating: 8 });
const previous = () => ({ version: 1 as const, items: { shows: [item()], movies: [], anime: [] }, activities: { all: oldDate, tv_shows: { watching: oldDate } }, checkedAt: 0, forceCheck: false });
function upstream(responses: unknown[]) {
  const calls: { url: URL; method: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: new URL(String(url)), method: init!.method! });
    const data = responses.shift();
    if (data instanceof Error) throw data;
    if (data instanceof Response) return data;
    return Response.json(data);
  }) as typeof fetch;
  return calls;
}
const opts = { ttlSeconds: 300, now: 300_000 };
for (const value of [undefined, null, '', ' ', '0', '-1', '1.5', '1e3', 'abc', true, '9007199254740991']) {
  test(`TTL defaults for ${String(value)}`, () => expect(parseLibraryCacheTtlSeconds(value)).toBe(300));
}
test('TTL accepts trimmed positive integer', () => { expect(parseLibraryCacheTtlSeconds(' 900 ')).toBe(900); expect(parseLibraryCacheTtlSeconds('60')).toBe(60); });
test('initializes after activities with no ratings call', async () => {
  const calls = upstream([{ all: oldDate }, { shows: [item()] }, { movies: [] }, { anime: [] }]);
  const result = await refreshLibrary(client, 'token', undefined, opts);
  expect(result.items.shows).toEqual([item()]); expect(calls.map(c => c.url.pathname)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
  expect(calls[0].method).toBe('GET');
});
test('unchanged all checks activities only', async () => {
  const calls = upstream([{ all: oldDate }]);
  const result = await refreshLibrary(client, 'token', previous(), opts);
  expect(calls).toHaveLength(1); expect(result.checkedAt).toBe(opts.now); expect(result.items).toEqual(previous().items);
});
for (const category of ['tv_shows', 'movies', 'anime']) for (const bucket of ['watching', 'plantowatch', 'hold', 'completed', 'dropped']) {
  test(`${category}.${bucket} fetches one all-type delta`, async () => {
    const calls = upstream([{ all: newDate, [category]: { [bucket]: newDate } }, { shows: [item(1, 'completed')] }]);
    const result = await refreshLibrary(client, 'token', previous(), opts);
    expect(calls[1].url.pathname).toBe('/sync/all-items'); expect(calls[1].url.searchParams.get('date_from')).toBe(oldDate);
    expect(calls).toHaveLength(2); expect(result.items.shows[0].status).toBe('completed');
  });
}
test('combines status changes in one delta', async () => {
  const calls = upstream([{ all: newDate, tv_shows: { watching: newDate, completed: newDate }, movies: { completed: newDate } }, null]);
  await refreshLibrary(client, 'token', previous(), opts); expect(calls).toHaveLength(2);
});
test('removes missing items using full membership without date_from', async () => {
  const calls = upstream([{ all: newDate, tv_shows: { watching: oldDate, removed_from_list: newDate } }, null]);
  const result = await refreshLibrary(client, 'token', previous(), opts);
  expect(result.items.shows).toEqual([]); expect(calls[1].url.searchParams.get('extended')).toBe('simkl_ids_only'); expect(calls[1].url.searchParams.has('date_from')).toBe(false);
});
test('ratings null is deletion, preserves metadata, adds auto-list entries', async () => {
  const calls = upstream([{ all: newDate, tv_shows: { watching: oldDate, rated_at: newDate } }, { shows: [{ show: { ids: { simkl: 1 } }, user_rating: null }, item(2, 'completed')] }]);
  const result = await refreshLibrary(client, 'token', previous(), opts);
  expect(calls[1].url.pathname).toBe('/sync/ratings'); expect(calls[1].method).toBe('GET'); expect(calls[1].url.searchParams.get('date_from')).toBe(oldDate);
  expect(result.items.shows[0].user_rating).toBeNull(); expect(result.items.shows[0].show?.title).toBe('Title'); expect(result.items.shows[1].status).toBe('completed');
});
test('ignored buckets cause no item calls', async () => {
  const calls = upstream([{ all: newDate, tv_shows: { watching: oldDate, playback: newDate }, custom_lists: { all: newDate }, settings: { all: newDate } }]);
  await refreshLibrary(client, 'token', previous(), opts); expect(calls).toHaveLength(1);
});
test('throttles before boundary and forced check bypasses throttle', async () => {
  const calls = upstream([{ all: oldDate }]);
  await refreshLibrary(client, 'token', previous(), { ...opts, now: 299_999 }); expect(calls).toHaveLength(0);
  await refreshLibrary(client, 'token', previous(), { ...opts, now: 1, force: true }); expect(calls).toHaveLength(1);
});
test('failed later delta leaves old snapshot for immediate retry', async () => {
  const before = previous(), saved = structuredClone(before);
  const changed = { all: newDate, tv_shows: { watching: newDate, rated_at: newDate } };
  upstream([changed, { shows: [item(1, 'completed')] }, new Error('failure')]);
  await expect(refreshLibrary(client, 'token', before, opts)).rejects.toThrow(); expect(before).toEqual(saved);
  const calls = upstream([changed, null, null]); await refreshLibrary(client, 'token', before, opts); expect(calls[1].url.searchParams.get('date_from')).toBe(oldDate);
});
for (const activities of [{}, { all: 'bad' }, { all: '2026-09-01T00:00:00Z' }]) test('rejects invalid or backwards activities '+JSON.stringify(activities), async () => {
  upstream([activities]); await expect(refreshLibrary(client, 'token', previous(), opts)).rejects.toThrow();
});
test('documented empty objects initialize an empty library', async () => {
  upstream([{ all: oldDate }, {}, {}, {}]); expect((await refreshLibrary(client, 'token', undefined, opts)).items).toEqual({ shows: [], movies: [], anime: [] });
});
test('delta, ratings and membership each use one unpaginated request in order', async () => {
  const updates = Array.from({ length: 101 }, (_, id) => item(id + 1, 'completed'));
  const calls = upstream([
    { all: newDate, tv_shows: { completed: newDate, rated_at: newDate, removed_from_list: newDate } },
    { shows: updates },
    { shows: [{ show: { ids: { simkl: 1 } }, user_rating: null }] },
    { shows: updates.map(entry => ({ show: { ids: entry.show.ids } })) },
  ]);
  const result = await refreshLibrary(client, 'token', previous(), opts);
  expect(result.items.shows).toHaveLength(101);
  expect(result.items.shows[0].status).toBe('completed');
  expect(result.items.shows[0].user_rating).toBeNull();
  expect(calls.map(call => call.url.pathname)).toEqual(['/sync/activities', '/sync/all-items', '/sync/ratings', '/sync/all-items']);
  expect([...calls[1].url.searchParams].filter(([key]) => !['client_id', 'app-name', 'app-version'].includes(key))).toEqual([['date_from', oldDate]]);
  expect([...calls[2].url.searchParams].filter(([key]) => !['client_id', 'app-name', 'app-version'].includes(key))).toEqual([['date_from', oldDate]]);
  expect([...calls[3].url.searchParams].filter(([key]) => !['client_id', 'app-name', 'app-version'].includes(key))).toEqual([['extended', 'simkl_ids_only']]);
});
test('malformed delta cannot change previous snapshot', async () => {
  const before = previous(), saved = structuredClone(before);
  upstream([{ all: newDate, tv_shows: { watching: newDate } }, { shows: 'broken' }]);
  await expect(refreshLibrary(client, 'token', before, opts)).rejects.toThrow(); expect(before).toEqual(saved);
});
test('malformed membership is not empty', async () => {
  upstream([{ all: newDate, tv_shows: { watching: oldDate, removed_from_list: newDate } }, { error: 'broken' }]);
  await expect(refreshLibrary(client, 'token', previous(), opts)).rejects.toThrow();
});
test('unsupported stored schema rejects even inside TTL', async () => {
  await expect(refreshLibrary(client, 'token', { ...previous(), version: 2 } as any, { ...opts, now: 1 })).rejects.toThrow();
});
test('documented empty object membership removes every cached item', async () => {
  upstream([{ all: newDate, tv_shows: { watching: oldDate, removed_from_list: newDate } }, {}]);
  expect((await refreshLibrary(client, 'token', previous(), opts)).items.shows).toEqual([]);
});
test('malformed membership after a valid delta preserves the entire previous snapshot', async () => {
  const before = previous(), saved = structuredClone(before);
  upstream([
    { all: newDate, tv_shows: { watching: newDate, removed_from_list: newDate } },
    { shows: [item(2, 'completed')] },
    { shows: [{ show: { ids: { simkl: 0 } } }] },
  ]);
  await expect(refreshLibrary(client, 'token', before, opts)).rejects.toThrow(); expect(before).toEqual(saved);
});
test('mixed unknown and recognized membership keys cannot clear the cache', async () => {
  const before = previous(), saved = structuredClone(before);
  upstream([{ all: newDate, tv_shows: { watching: oldDate, removed_from_list: newDate } }, { shows: [], error: 'partial upstream error' }]);
  await expect(refreshLibrary(client, 'token', before, opts)).rejects.toThrow(); expect(before).toEqual(saved);
});
