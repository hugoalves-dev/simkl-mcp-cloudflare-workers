import { expect, test } from 'bun:test';
import { SimklClient, SimklApiError } from '../src/api/client';
import { fetchInitialLibrary } from '../src/library/sync';
import documentedItems from './fixtures/library-items.json';

const activities = { all: '2026-10-09T12:00:00Z', shows: { rated_at: '2026-10-09T12:00:00Z' } };
const item = (media: string, id = 42, extra = {}) => ({ [media === 'movies' ? 'movie' : 'show']: { ids: { simkl: id }, title: 'Example' }, user_rating: 8, ...extra });
function setup(handle?: (path: string) => unknown | Promise<unknown>) {
  const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
  const calls: Array<{ path: string; options: any }> = [];
  let active = 0;
  let peak = 0;
  client.request = async (path, options) => {
    calls.push({ path, options }); active++; peak = Math.max(peak, active);
    try {
      await Promise.resolve();
      return (handle ? await handle(path) : path === '/sync/activities' ? activities : { [path.split('/')[3]]: [item(path.split('/')[3])] }) as any;
    } finally { active--; }
  };
  return { client, calls, peak: () => peak };
}

test('activities precede sequential non-extended media pulls, retaining all item fields', async () => {
  const { client, calls, peak } = setup();
  const candidate = await fetchInitialLibrary(client, 'token');
  expect(calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
  expect(peak()).toBe(1);
  for (const c of calls) { expect(c.options.token).toBe('token'); expect(c.options.query).toBeUndefined(); }
  expect(candidate.activities).toEqual(activities);
  expect(candidate.items).toHaveLength(3);
  expect(JSON.parse(candidate.items[0].itemJson)).toEqual(item('shows'));
});

test('400 max_items retries exactly the failed type with supported sequential statuses', async () => {
  const { client, calls, peak } = setup(path => {
    if (path === '/sync/activities') return activities;
    if (path === '/sync/all-items/movies') throw new SimklApiError('too many', 400, '{"error":"max_items"}');
    const media = path.split('/')[3];
    return { [media]: path.split('/')[4] ? [item(media, ['plantowatch', 'completed', 'dropped'].indexOf(path.split('/')[4]) + 1)] : [] };
  });
  const result = await fetchInitialLibrary(client, 'token');
  expect(calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', ...['plantowatch', 'completed', 'dropped'].map(s => `/sync/all-items/movies/${s}`), '/sync/all-items/anime']);
  expect(result.items).toHaveLength(3);
  expect(peak()).toBe(1);
});

test('does not split other statuses/errors or recursively split a failed status', async () => {
  for (const error of [new SimklApiError('bad', 400, '{"error":"bad"}'), new SimklApiError('bad', 429, '{"error":"max_items"}')]) {
    const { client, calls } = setup(path => { if (path === '/sync/activities') return activities; throw error; });
    await expect(fetchInitialLibrary(client, 'token')).rejects.toThrow('bad');
    expect(calls).toHaveLength(2);
  }
  const { client, calls } = setup(path => {
    if (path === '/sync/activities') return activities;
    throw new SimklApiError('too many', 400, '{"error":"max_items"}');
  });
  await expect(fetchInitialLibrary(client, 'token')).rejects.toThrow('too many');
  expect(calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/shows/watching']);
});

test('empty library succeeds while missing/malformed arrays and identities reject', async () => {
  const empty = setup(path => path === '/sync/activities' ? activities : { [path.split('/')[3]]: [] });
  expect((await fetchInitialLibrary(empty.client, 'token')).items).toEqual([]);
  for (const response of [{ unexpected: true }, { movies: [item('movies')] }, { shows: null }, { shows: [{}] }, { shows: [item('movies')] }, { shows: [item('shows', 0)] }, { shows: ['bad'] }]) {
    const { client } = setup(path => path === '/sync/activities' ? activities : response);
    await expect(fetchInitialLibrary(client, 'token')).rejects.toThrow('Invalid Simkl library');
  }
  for (const response of [null, [], {}, { all: '' }, { all: 'invalid' }]) {
    const { client } = setup(() => response);
    await expect(fetchInitialLibrary(client, 'token')).rejects.toThrow('Invalid Simkl activities');
  }
});

test('identical duplicates collapse, conflicting duplicates abort', async () => {
  const same = setup(path => path === '/sync/activities' ? activities : { [path.split('/')[3]]: [item(path.split('/')[3]), item(path.split('/')[3])] });
  expect((await fetchInitialLibrary(same.client, 'token')).items).toHaveLength(3);
  const conflict = setup(path => path === '/sync/activities' ? activities : { shows: [item('shows'), item('shows', 42, { user_rating: 9 })] });
  await expect(fetchInitialLibrary(conflict.client, 'token')).rejects.toThrow('Conflicting Simkl library item');
});

test('row and aggregate serialized byte limits fail without truncation', async () => {
  const oversized = setup(path => path === '/sync/activities' ? activities : { shows: [item('shows', 42, { extra: 'é'.repeat(1024 * 1024 / 2) })] });
  await expect(fetchInitialLibrary(oversized.client, 'token')).rejects.toThrow('Library item too large');
  const large = setup(path => path === '/sync/activities' ? activities : {
    [path.split('/')[3]]: Array.from({ length: 12 }, (_, id) => item(path.split('/')[3], id + 1, { extra: 'x'.repeat(950_000) })),
  });
  await expect(fetchInitialLibrary(large.client, 'token')).rejects.toThrow('Library initialization too large');
});

// Fixture extracted from checked-in Simkl OpenAPI: all_modifiers_inspection_only.
test('documented anime rows use show identity and retain the entire record', async () => {
  const { client } = setup(path => path === '/sync/activities' ? activities : { [path.split('/')[3]]: documentedItems[path.split('/')[3] as keyof typeof documentedItems] });
  const result = await fetchInitialLibrary(client, 'token');
  expect(result.items).toHaveLength(3);
  const anime = result.items.find(row => row.mediaType === 'anime')!;
  expect(anime.simklId).toBe(String(documentedItems.anime[0].show.ids.simkl));
  expect(JSON.parse(anime.itemJson)).toEqual(documentedItems.anime[0]);
});

test('documented empty filtered responses initialize and empty split buckets are valid', async () => {
  const empty = setup(path => path === '/sync/activities' ? activities : {});
  expect((await fetchInitialLibrary(empty.client, 'token')).items).toEqual([]);
  const split = setup(path => {
    if (path === '/sync/activities') return activities;
    if (path === '/sync/all-items/shows') throw new SimklApiError('split', 400, '{"error":"max_items"}');
    return path === '/sync/all-items/shows/plantowatch' ? { shows: [item('shows')] } : {};
  });
  expect((await fetchInitialLibrary(split.client, 'token')).items).toHaveLength(1);
});

test('movie max_items pulls only supported plantowatch/completed/dropped statuses', async () => {
  const statuses = ['plantowatch', 'completed', 'dropped'];
  const { client, calls } = setup(path => {
    if (path === '/sync/activities') return activities;
    if (path === '/sync/all-items/movies') throw new SimklApiError('split', 400, '{"error":"max_items"}');
    if (path.startsWith('/sync/all-items/movies/')) {
      const status = path.split('/')[4];
      if (!statuses.includes(status)) throw new SimklApiError('unsupported movie status', 400, '{}');
      return { movies: [item('movies', statuses.indexOf(status) + 1)] };
    }
    return { [path.split('/')[3]]: [] };
  });
  expect((await fetchInitialLibrary(client, 'token')).items).toHaveLength(3);
  expect(calls.filter(c => c.path.startsWith('/sync/all-items/movies/')).map(c => c.path)).toEqual(statuses.map(status => `/sync/all-items/movies/${status}`));
});
