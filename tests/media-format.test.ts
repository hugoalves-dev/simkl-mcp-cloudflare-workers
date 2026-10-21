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

test('search accepts specific types and all only as a documented unknown-type fallback', async () => {
  const registrations = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  const paths: string[] = [];
  const client = {
    requestWithMetadata: async (path: string) => {
      paths.push(path);
      return {
        data: [
          { title: 'Movie title', year: 2024, endpoint_type: 'movies', ids: { simkl_id: 101, slug: 'movie-title', imdb: 'tt1' } },
          { title: 'TV title', year: 2023, endpoint_type: 'tv', ids: { simkl_id: 202, slug: 'tv-title' } },
          { title: 'Anime title', year: 2022, endpoint_type: 'anime', ids: { simkl_id: 303, slug: 'anime-title' } },
        ],
        headers: {},
      };
    },
  };
  registerTools({
    registerTool(name: string, config: any, handler: (args: any) => Promise<any>) {
      registrations.set(name, { config, handler });
    },
  } as any, client, () => undefined);

  const search = registrations.get('simkl_search_by_text')!;
  expect(search.config.description).toContain('Prefer tv');
  expect(search.config.description).toContain('Use all only');
  expect(search.config.inputSchema.type.description).toContain('unknown-type fallback');
  for (const type of ['tv', 'anime', 'movie', 'all']) {
    expect(search.config.inputSchema.type.safeParse(type).success).toBe(true);
  }
  expect(search.config.inputSchema.type.safeParse('movies').success).toBe(false);

  const mixed = await search.handler({ type: 'all', q: 'title' });
  expect(mixed.isError).not.toBe(true);
  expect(paths).toEqual(['/search/all']);
  const lines = mixed.content.map((entry: any) => entry.text);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain('https://simkl.com/movies/101/movie-title');
  expect(lines[0]).toContain('type: movies');
  expect(lines[1]).toContain('https://simkl.com/tv/202/tv-title');
  expect(lines[1]).toContain('type: tv');
  expect(lines[2]).toContain('https://simkl.com/anime/303/anime-title');
  expect(lines[2]).toContain('type: anime');

  for (const [type, route] of [['tv', 'tv'], ['anime', 'anime'], ['movie', 'movies']] as const) {
    paths.length = 0;
    const result = await search.handler({ type, q: 'title' });
    expect(paths).toEqual([`/search/${type}`]);
    expect(result.content[0].text).toContain(`https://simkl.com/${route}/101/movie-title`);
    expect(result.content[0].text).not.toContain('type: ');
  }
});

test('mixed search never creates an invented /all or unknown-type link', async () => {
  const { formatList, withImdb } = await import('../src/format/media');
  const unknown = { title: 'Mystery', endpoint_type: 'unknown', ids: { simkl: 9 } };
  expect(() => formatList([unknown], withImdb, 10, 'all')).toThrow('Invalid Simkl search endpoint_type');
});
