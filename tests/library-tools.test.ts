import { expect, test } from 'bun:test';
import { selectWatchlist, watchlistResourceContents } from '../src/library/watchlist';
import { registerTools } from '../generated/tools';
const items = { shows: [{ status: 'watching', show: { title: 'Title', year: 2020, ids: { simkl: 1 } }, added_to_watchlist_at: '2026-10-01T00:00:00Z' }], movies: [], anime: [] };
test('selects type and status without changing items', () => {
  expect(selectWatchlist(items, { type: 'shows', status: 'watching' })).toEqual({ shows: items.shows });
  expect(selectWatchlist(items, { type: 'shows', status: 'completed' })).toEqual({ shows: [] });
  expect(selectWatchlist(items, {})).toEqual(items);
});
for (const args of [{ extended: 'ids_only' }, { extended: 'full_anime_seasons' }, { date_from: '2020-01-01' }, { memos: 'yes' }, { episode_watched_at: 'yes' }, { type: 'bad' }, { status: 'bad' }]) test('rejects unsupported watchlist query '+JSON.stringify(args), () => {
  expect(() => selectWatchlist(items, args)).toThrow();
});
test('resource output preserves text formatting and empty message', () => {
  expect(watchlistResourceContents('simkl://watchlist/shows/watching', 'shows', 'watching', items).contents[0].text).toBe('0: [SIMKL #1] - Title (2020) - added on 2026-10-01');
  expect(watchlistResourceContents('simkl://watchlist/shows/completed', 'shows', 'completed', items).contents[0].text).toBe('no shows with status completed');
});
function tools(client: any, hooks?: any) {
  const callbacks = new Map<string, (args: any) => Promise<any>>();
  registerTools({ registerTool(name: string, _: unknown, callback: any) { callbacks.set(name, callback); } } as any, client, () => 'token', hooks);
  return callbacks;
}
test('watchlist hook preserves JSON format without raw API call', async () => {
  const callbacks = tools({ request() { throw new Error('raw watchlist called'); } }, { getWatchlist: async (args: any) => selectWatchlist(items, args) });
  const result = await callbacks.get('simkl_get_watchlist')!({ type: 'shows', status: 'watching' });
  expect(JSON.parse(result.content[0].text)).toEqual({ shows: items.shows });
});
for (const name of ['simkl_start_watching', 'simkl_pause_watching', 'simkl_add_to_watchlist', 'simkl_mark_watched', 'simkl_remove_from_history', 'simkl_add_rating', 'simkl_remove_rating']) test(name+' awaits successful invalidation', async () => {
  const order: string[] = []; const callbacks = tools({ async request() { order.push('write'); return {}; } }, { async afterLibraryWrite() { order.push('invalidate'); } });
  await callbacks.get(name)!({}); expect(order).toEqual(['write', 'invalidate']);
});
test('failed writes do not invalidate', async () => {
  let invalidations = 0; const callbacks = tools({ async request() { throw new Error('upstream failed'); } }, { async afterLibraryWrite() { invalidations++; } });
  expect((await callbacks.get('simkl_add_rating')!({})).isError).toBe(true); expect(invalidations).toBe(0);
});
test('invalidation failure reports possible upstream success', async () => {
  const callbacks = tools({ async request() { return {}; } }, { async afterLibraryWrite() { throw new Error('failed'); } });
  expect((await callbacks.get('simkl_add_rating')!({})).content[0].text).toContain('Upstream write succeeded, but library cache invalidation failed');
});
test('catalog reads never invalidate and callers without hooks are compatible', async () => {
  let invalidations = 0; const client = { async request() { return { shows: [] }; } };
  const callbacks = tools(client, { async afterLibraryWrite() { invalidations++; } });
  await callbacks.get('simkl_get_show_by_id')!({ id: '1' }); expect(invalidations).toBe(0);
  const without = tools(client); expect(JSON.parse((await without.get('simkl_get_watchlist')!({ type: 'shows', status: 'watching' })).content[0].text)).toEqual({ shows: [] });
});
