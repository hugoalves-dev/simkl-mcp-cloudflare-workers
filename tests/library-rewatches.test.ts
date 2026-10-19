import { expect, test } from 'bun:test';
import { SimklApiError, type SimklClient } from '../src/api/client';
import { refreshRewatches, selectRewatches, type RewatchRow } from '../src/library/rewatches';
import { LibraryStore } from '../src/library/store';
import { sqliteStorage } from './helpers/library-storage';
import type { Activities } from '../src/library/types';

const t0 = '2026-10-01T12:00:00Z';
const t1 = '2026-10-02T12:00:00Z';
const t2 = '2026-10-03T12:00:00Z';
const activity = (all: string | null, updates: Record<string, unknown> = {}): Activities => ({
  all, tv_shows: { watching: t0, completed: t0, removed_from_list: t0, ...updates },
});
const session = (rewatchId: number, watched: number, options: Record<string, unknown> = {}) => ({
  status: 'watching', is_rewatch: true, rewatch_id: rewatchId, rewatch_status: 'active',
  watched_episodes_count: watched, total_episodes_count: 73,
  show: { title: 'Game of Thrones', year: 2011, ids: { simkl: 17465, slug: 'game-of-thrones' } },
  ...options,
});
const canonical = { show: { ids: { simkl: 17465 } }, status: 'completed', watched_episodes_count: 73 };
function mockClient(respond: (path: string, options: any) => unknown) {
  const requests: Array<{ path: string; options: any }> = [];
  const client = { async request(path: string, options: any) { requests.push({ path, options }); return respond(path, options); } } as SimklClient;
  return { client, requests };
}

test('initial baseline excludes canonical items, captures multiple sessions and preserves full progress', async () => {
  const { client, requests } = mockClient(() => ({ shows: [canonical, session(7, 4), session(8, 11)] }));
  const snapshot = await refreshRewatches(client, 'test-token', undefined, activity(t0));
  expect(snapshot.rows.map(row => row.rewatchId)).toEqual([7, 8]);
  expect(snapshot.rows.map(row => JSON.parse(row.itemJson).watched_episodes_count)).toEqual([4, 11]);
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toBe('/sync/all-items');
  expect(requests[0].options.query).toEqual({
    allow_rewatch: 'yes', extended: 'full', episode_watched_at: 'yes',
  });
  expect(requests[0].options.responseProfile).toBe('library');
  const output = selectRewatches(snapshot.rows, { mediaType: 'shows', status: 'watching' });
  expect(output).toHaveLength(2);
  expect(output[0]).toContain('rewatch_id: 7 | status: active | list: watching | progress: 4/73');
  expect(output[0]).toContain('https://simkl.com/tv/17465/game-of-thrones');
  expect(await refreshRewatches(client, 'test-token', snapshot, activity(t0))).toBe(snapshot);
  expect(requests).toHaveLength(1);
});

test('status bucket moves use saved all for delta and merge sessions by composite key', async () => {
  const { client, requests } = mockClient((_path, opts) =>
    opts.query.date_from ? { shows: [session(7, 5, { rewatch_status: 'closed' })] } :
    { shows: [session(7, 4), session(8, 11)] });
  const previous = await refreshRewatches(client, 'test-token', undefined, activity(t0));
  const updated = await refreshRewatches(client, 'test-token', previous, activity(t1, { watching: t1 }));
  expect(requests).toHaveLength(2);
  expect(requests[1].options.query.date_from).toBe(t0);
  expect(updated.rows).toHaveLength(2);
  expect(JSON.parse(updated.rows.find(row => row.rewatchId === 7)!.itemJson).watched_episodes_count).toBe(5);
  expect(JSON.parse(updated.rows.find(row => row.rewatchId === 8)!.itemJson).watched_episodes_count).toBe(11);
  await refreshRewatches(client, 'test-token', updated, activity(t2, { watching: t1 }));
  expect(requests).toHaveLength(2); // Non-list activity never triggers a session pull.
});

test('deletion activity triggers full replacement, not an unsafe delta', async () => {
  const { client, requests } = mockClient((_path, opts) =>
    opts.query.date_from ? (() => { throw new Error('unexpected delta'); })() :
    requests.length === 1 ? { shows: [session(7, 4), session(8, 11)] } : { shows: [session(8, 11)] });
  const previous = await refreshRewatches(client, 'token', undefined, activity(t0));
  const updated = await refreshRewatches(client, 'token', previous, activity(t1, { removed_from_list: t1 }));
  expect(updated.rows.map(row => row.rewatchId)).toEqual([8]);
  expect(requests[1].options.query.date_from).toBeUndefined();
});

test('null new-account activity stays empty, then performs initial baseline after first write', async () => {
  const { client, requests } = mockClient(() => ({ movies: [{
    status: 'completed', is_rewatch: true, rewatch_id: 2, rewatch_status: 'completed',
    movie: { title: 'Example', ids: { simkl: 42 } },
  }] }));
  const empty = await refreshRewatches(client, 'token', undefined, activity(null));
  expect(empty.rows).toEqual([]);
  expect(requests).toHaveLength(0);
  const first = await refreshRewatches(client, 'token', empty, activity(t1));
  expect(first.rows).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(selectRewatches(first.rows, { mediaType: 'movies', status: 'completed' })[0]).toContain('rewatch_id: 2');
});

test('forced stale session snapshot re-fetches even if activities have not advanced', async () => {
  const { client, requests } = mockClient(() => ({ shows: [session(7, requests.length)] }));
  const first = await refreshRewatches(client, 'token', undefined, activity(t0));
  const next = await refreshRewatches(client, 'token', { ...first, stale: true }, activity(t0));
  expect(requests).toHaveLength(2);
  expect(JSON.parse(next.rows[0].itemJson).watched_episodes_count).toBe(2);
});

test('max_items splits baseline into type scopes without losing session identities', async () => {
  const { client, requests } = mockClient((path) => {
    if (path === '/sync/all-items') throw new SimklApiError('Simkl max items', 400, '{"error":"max_items"}');
    return path === '/sync/all-items/shows' ? { shows: [session(7, 1), session(8, 2)] } : {};
  });
  const result = await refreshRewatches(client, 'token', undefined, activity(t0));
  expect(result.rows).toHaveLength(2);
  expect(requests.map(request => request.path)).toEqual(['/sync/all-items', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
});

test('invalid response or failed delta does not overwrite a saved watermark or rows', async () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  const good = mockClient(() => ({ shows: [session(7, 4)] }));
  const snapshot = await refreshRewatches(good.client, 'token', undefined, activity(t0));
  store.saveRewatches(snapshot);
  const bad = mockClient(() => ({ shows: [session(7, 9), { ...session(8, 3), rewatch_id: -1 }] }));
  await expect(refreshRewatches(bad.client, 'token', store.loadRewatches(), activity(t1, { watching: t1 }))).rejects.toThrow(/identity/);
  expect(store.loadRewatches()).toEqual(snapshot);
  db.close();
});

test('SQLite stores canonical and rewatch rows independently; writes and watermark rollback together', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit({ activities: activity(t0), items: [{
    mediaType: 'shows', simklId: '17465', itemJson: JSON.stringify(canonical),
  }] });
  const initial: RewatchRow[] = [7, 8].map(id => ({
    mediaType: 'shows', simklId: '17465', rewatchId: id, itemJson: JSON.stringify(session(id, 2)),
  }));
  store.saveRewatches({ activities: activity(t0), stale: false, rows: initial });
  expect(store.readItems()).toHaveLength(1);
  expect(store.loadRewatches()?.rows).toHaveLength(2);
  store.invalidateRewatches();
  expect(store.loadRewatches()?.stale).toBe(true);
  db.exec("CREATE TRIGGER fail BEFORE INSERT ON rewatch_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(() => store.saveRewatches({
    activities: activity(t1), stale: false,
    rows: [...initial, { mediaType: 'shows', simklId: '17465', rewatchId: 9, itemJson: JSON.stringify(session(9, 1)) }],
  })).toThrow('injected');
  expect(store.loadRewatches()?.activities.all).toBe(t0);
  expect(store.loadRewatches()?.rows).toHaveLength(2);
  expect(store.readItems()).toHaveLength(1);
  db.close();
});
