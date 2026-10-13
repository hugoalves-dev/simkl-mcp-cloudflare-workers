import { describe, expect, test } from 'bun:test';
import { getTrendingByGenre, simklTrendingPath } from '../src/api/trending';

describe('simklTrendingPath', () => {
  test.each([
    ['tv', 'today', 'tv/today_100.json'],
    ['movies', 'today', 'movies/today_100.json'],
    ['anime', 'today', 'anime/today_100.json'],
    ['tv', 'week', 'tv/week_100.json'],
    ['movies', 'week', 'movies/week_100.json'],
    ['anime', 'week', 'anime/week_100.json'],
    ['tv', 'month', 'tv/month_100.json'],
    ['movies', 'month', 'movies/month_100.json'],
    ['anime', 'month', 'anime/month_100.json'],
    ['tv', 'daily', 'tv/today_100.json'],
    ['movies', 'daily', 'movies/today_100.json'],
    ['anime', 'daily', 'anime/today_100.json'],
    ['tv', 'weekly', 'tv/week_100.json'],
    ['movies', 'weekly', 'movies/week_100.json'],
    ['anime', 'weekly', 'anime/week_100.json'],
    ['tv', 'monthly', 'tv/month_100.json'],
    ['movies', 'monthly', 'movies/month_100.json'],
    ['anime', 'monthly', 'anime/month_100.json'],
  ] as const)('%s %s maps to the official public file', (type, interval, expectedPath) => {
    expect(simklTrendingPath(type, interval)).toBe(`https://data.simkl.in/discover/trending/${expectedPath}`);
  });
});

describe('getTrendingByGenre', () => {
  test('looks up the slug in the selected type index and returns bounded rich items', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = {
      requestWithMetadata: async (url: string, options: any) => {
        calls.push({ url, authorization: options.authorization });
        if (url.endsWith('/index.json')) {
          return { data: [{ name: 'Drama', slug: 'drama', count: 500 }], headers: {} };
        }
        return {
          data: [
            { title: 'One', ids: { simkl: 17, slug: 'one-title' }, overview: 'richer fields stay available', ratings: { simkl: { rating: 8 } } },
            { title: 'Two', overview: 'also rich' },
          ],
          headers: { lastModified: 'Thu, 08 Oct 2026 00:00:00 GMT' },
        };
      },
    } as any;

    const result = await getTrendingByGenre(client, 'tv', 'drama', 1);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://data.simkl.in/discover/trending/tv/genre/index.json');
    expect(calls[1].url).toBe('https://data.simkl.in/discover/trending/tv/genre/drama_month_500.json');
    expect(calls.every(call => call.authorization === 'none')).toBe(true);
    expect(result.genre).toEqual({ name: 'Drama', slug: 'drama', count: 500 });
    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ratings.simkl.rating).toBe(8);
    expect(result.results[0].simkl_url).toBe('https://simkl.com/tv/17/one-title');
    expect(result.updatedAt).toBe('Thu, 08 Oct 2026 00:00:00 GMT');
  });

  test('rejects unsupported media types, malformed slugs, and genres absent from the type index', async () => {
    const client = { requestWithMetadata: async () => ({ data: [], headers: {} }) } as any;
    await expect(getTrendingByGenre(client, 'books' as any, 'drama')).rejects.toThrow('Unsupported media type');
    await expect(getTrendingByGenre(client, 'tv', '../drama')).rejects.toThrow('Invalid genre slug');
    await expect(getTrendingByGenre(client, 'tv', 'missing')).rejects.toThrow('not available for tv');
    await expect(getTrendingByGenre(client, 'tv', 'drama', 101)).rejects.toThrow('maxResults must be an integer from 1 to 100');
  });

  test.each(['tv', 'movies', 'anime'] as const)('selects the %s index and file paths', async type => {
    const paths: string[] = [];
    const client = {
      requestWithMetadata: async (url: string) => {
        paths.push(url);
        return { data: url.endsWith('/index.json') ? [{ name: 'Action', slug: 'action', count: 1 }] : [], headers: {} };
      },
    } as any;
    await getTrendingByGenre(client, type, 'action');
    expect(paths).toEqual([
      `https://data.simkl.in/discover/trending/${type}/genre/index.json`,
      `https://data.simkl.in/discover/trending/${type}/genre/action_month_500.json`,
    ]);
  });
});
