import { expect, test } from 'bun:test';
import { formatItem, formatList, simklItemUrl } from '../src/format/media';
import { registerTools } from '../generated/tools';

test.each([
  ['tv', 'https://simkl.com/tv/11/blue-planet'],
  ['movies', 'https://simkl.com/movies/11/blue-planet'],
  ['anime', 'https://simkl.com/anime/11/blue-planet'],
] as const)('formats a clickable %s item link', (type, url) => {
  const item = { title: 'Blue Planet', ids: { simkl: 11, slug: 'blue-planet' } };
  expect(simklItemUrl(type, item.ids.simkl, item.ids.slug)).toBe(url);
  expect(formatList([item], formatItem, 20, type)[0]).toContain(`[SIMKL #11](${url})`);
});

test('omits an absent slug and safely encodes a supplied slug', () => {
  expect(simklItemUrl('tv', 42)).toBe('https://simkl.com/tv/42');
  expect(simklItemUrl('tv', 42, 'blue planet/part')).toBe('https://simkl.com/tv/42/blue%20planet%2Fpart');
});

test('list tools include the correct route and genre trending exposes a link on each rich item', async () => {
  const callbacks = new Map<string, (args: any) => Promise<any>>();
  const client = {
    requestWithMetadata: async (path: string) => ({
      data: /^\/(tv|movies|anime)\/9$/.test(path)
        ? { title: 'Drama detail', ids: { simkl: 9, slug: 'drama-title' } }
        : path.endsWith('/index.json')
        ? [{ name: 'Drama', slug: 'drama', count: 1 }]
        : [{ title: 'Drama title', ids: { simkl: 9, slug: 'drama-title' } }],
      headers: {},
    }),
  };
  registerTools({ registerTool(name: string, _: unknown, callback: any) { callbacks.set(name, callback); } } as any, client, () => undefined);

  for (const [tool, type] of [
    ['simkl_get_trending_shows', 'tv'],
    ['simkl_get_trending_movies', 'movies'],
    ['simkl_get_trending_anime', 'anime'],
  ] as const) {
    const result = await callbacks.get(tool)!({ interval: 'daily' });
    expect(result.content[0].text).toContain(`https://simkl.com/${type}/9/drama-title`);
  }

  for (const [tool, type] of [
    ['simkl_get_show_by_id', 'tv'],
    ['simkl_get_movie_by_id', 'movies'],
    ['simkl_get_anime_by_id', 'anime'],
  ] as const) {
    const detail = await callbacks.get(tool)!({ id: 9 });
    expect(detail.content[0].text).toContain(`"simkl_url": "https://simkl.com/${type}/9/drama-title"`);
  }

  const genre = await callbacks.get('simkl_get_trending_by_genre')!({ type: 'anime', genre: 'drama' });
  expect(genre.content[0].text).toContain('"simkl_url": "https://simkl.com/anime/9/drama-title"');
});
