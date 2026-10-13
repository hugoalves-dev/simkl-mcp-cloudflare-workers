import { expect, test } from 'bun:test';
import { selectWatchlist, watchlistResourceContents } from '../src/library/watchlist';
import { registerTools } from '../generated/tools';
const items = { shows: [{ status: 'watching', show: { title: 'Title', year: 2020, ids: { simkl: 1 } }, added_to_watchlist_at: '2026-10-01T00:00:00Z' }], movies: [], anime: [] };
test('selects type and status without changing items', () => {
  expect(selectWatchlist(items, { type: 'shows', status: 'watching' })).toEqual([
    'Title (2020) | status: watching | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/tv/1>'
  ]);
  expect(selectWatchlist(items, { type: 'shows', status: 'completed' })).toEqual([]);
  expect(selectWatchlist(items, {})).toHaveLength(1);
});
test('filters watchlist by title and paginates after filtering', () => {
  const library = { ...items, shows: [
    { status: 'watching', show: { title: 'Blue Planet', year: 2001, ids: { simkl: 1 } }, watched_episodes_count: 2, total_episodes_count: 8, next_to_watch: 'S01E03', user_rating: 9 },
    { status: 'completed', show: { title: 'Planet Earth', year: 2006, ids: { simkl: 2 } } },
    { status: 'watching', show: { title: 'Planet Ocean', year: 2010, ids: { simkl: 3 } } },
  ] };
  expect(selectWatchlist(library, { title: 'planet', status: 'watching', offset: 1, limit: 1 })).toEqual([
    'Planet Ocean (2010) | status: watching | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/tv/3>'
  ]);
});
test('formats compact item details and handles absent optional fields', () => {
  const library = { shows: [
    { status: 'watching', show: { title: 'Blue Planet', year: 2001, ids: { simkl: 1, slug: 'blue-planet' } }, watched_episodes_count: 2, total_episodes_count: 8, next_to_watch: 'S01E03', user_rating: 9 },
    { show: { ids: { simkl: 2 } } },
  ], movies: [], anime: [] };
  expect(selectWatchlist(library, { type: 'shows' })).toEqual([
    'Blue Planet (2001) | status: watching | progress: 2/8 | next episode: S01E03 | rating: 9/10 | Simkl: <https://simkl.com/tv/1/blue-planet>',
    'unknown (N/A) | status: unknown | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/tv/2>',
  ]);
});
test('builds Simkl links for movies and anime', () => {
  const library = {
    shows: [],
    movies: [{ movie: { title: 'Film', ids: { simkl: 2 } } }],
    anime: [{ anime: { title: 'Series', ids: { simkl: 3 } } }],
  };
  expect(selectWatchlist(library, {})).toEqual([
    'Film (N/A) | status: unknown | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/movies/2>',
    'Series (N/A) | status: unknown | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/anime/3>',
  ]);
});
test('rejects invalid pagination values', () => {
  expect(() => selectWatchlist(items, { limit: 0 })).toThrow();
  expect(() => selectWatchlist(items, { offset: -1 })).toThrow();
});
for (const args of [{ extended: 'ids_only' }, { extended: 'full_anime_seasons' }, { date_from: '2020-01-01' }, { memos: 'yes' }, { episode_watched_at: 'yes' }, { type: 'bad' }, { status: 'bad' }]) test('rejects unsupported watchlist query '+JSON.stringify(args), () => {
  expect(() => selectWatchlist(items, args)).toThrow();
});
test('resource output uses the same compact item format and empty message', () => {
  const detailed = { shows: [{ status: 'watching', show: { title: 'Title', year: 2020, ids: { simkl: 1 } }, watched_episodes_count: 1, total_episodes_count: 10 }], movies: [], anime: [] };
  expect(watchlistResourceContents('simkl://watchlist/shows/watching', 'shows', 'watching', detailed).contents[0].text).toBe('Title (2020) | status: watching | progress: 1/10 | rating: unrated | Simkl: <https://simkl.com/tv/1>');
  expect(watchlistResourceContents('simkl://watchlist/shows/completed', 'shows', 'completed', items).contents[0].text).toBe('no shows with status completed');
});
function tools(client: any, hooks?: any) {
  const callbacks = new Map<string, (args: any) => Promise<any>>();
  registerTools({ registerTool(name: string, _: unknown, callback: any) { callbacks.set(name, callback); } } as any, client, () => 'token', hooks);
  return callbacks;
}
test('watchlist hook returns compact cached text without raw API call', async () => {
  const callbacks = tools({ request() { throw new Error('raw watchlist called'); } }, { getWatchlist: async (args: any) => selectWatchlist(items, args).join('\n') });
  const result = await callbacks.get('simkl_get_watchlist')!({ type: 'shows', status: 'watching' });
  expect(result.content[0].text).toBe('Title (2020) | status: watching | progress: unavailable | rating: unrated | Simkl: <https://simkl.com/tv/1>');
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
  const without = tools(client);
  expect((await without.get('simkl_get_watchlist')!({})).isError).toBe(true);
});

test('watchlist schema exposes only cache filters and pagination', () => {
  let schema: any;
  registerTools({ registerTool(name: string, config: any) { if (name === 'simkl_get_watchlist') schema = config.inputSchema; } } as any, {}, () => undefined);
  expect(Object.keys(schema.shape).sort()).toEqual(['limit', 'offset', 'status', 'title', 'type']);
  expect(schema.safeParse({ title: 'planet', limit: 10, offset: 0 }).success).toBe(true);
  expect(schema.safeParse({ date_from: '2020-01-01' }).success).toBe(false);
});
