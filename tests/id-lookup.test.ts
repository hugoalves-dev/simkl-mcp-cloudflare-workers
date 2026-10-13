import { describe, expect, test } from 'bun:test';
import { getMediaById, parseSimklRedirect } from '../src/api/id-lookup';

describe('parseSimklRedirect', () => {
  test.each([
    ['https://simkl.com/movies/472214/inception', { type: 'movies', id: 472214 }],
    ['//simkl.com/tv/17465/the-walking-dead/season-1/episode-1', { type: 'tv', id: 17465 }],
    ['https://simkl.com/anime/12345/title', { type: 'anime', id: 12345 }],
  ] as const)('parses the %s catalog URL', (location, expected) => {
    expect(parseSimklRedirect(location)).toEqual(expected);
  });

  test.each([
    null,
    'https://simkl.com/movies/not-an-id/title',
    'https://example.com/movies/123/title',
    'https://simkl.com/oauth/authorize',
  ])('rejects malformed or unrelated location %s', location => {
    expect(parseSimklRedirect(location)).toBeNull();
  });
});

describe('getMediaById', () => {
  test('resolves an external ID without a user token, then fetches its public detail record', async () => {
    const calls: Array<{ path: string; options: any }> = [];
    const client = {
      request: async (path: string, options: any) => {
        calls.push({ path, options });
        if (path === '/redirect') return { redirectUrl: 'https://simkl.com/movies/472214/inception' };
        return { title: 'Inception', ids: { simkl: 472214 } };
      },
    } as any;

    const result = await getMediaById(client, { imdb: 'tt1375666' });
    expect(result).toEqual({ title: 'Inception', ids: { simkl: 472214 } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      path: '/redirect',
      options: {
        method: 'GET',
        authorization: 'none',
        redirect: 'manual',
        query: { to: 'simkl', imdb: 'tt1375666' },
      },
    });
    expect(calls[1]).toEqual({ path: '/movies/472214', options: { method: 'GET', authorization: 'none' } });
  });

  test('uses the returned anime type to choose the public detail endpoint', async () => {
    const paths: string[] = [];
    const client = {
      request: async (path: string) => {
        paths.push(path);
        return path === '/redirect' ? { redirectUrl: 'https://simkl.com/anime/2345/title' } : { title: 'Anime' };
      },
    } as any;
    await getMediaById(client, { mal: 1 });
    expect(paths).toEqual(['/redirect', '/anime/2345']);
  });

  test('rejects missing or malformed IDs without making a request', async () => {
    let requests = 0;
    const client = { request: async () => { requests++; return {}; } } as any;
    await expect(getMediaById(client, {})).rejects.toThrow('Provide at least one supported ID');
    await expect(getMediaById(client, { simkl: 0 })).rejects.toThrow('Invalid simkl ID');
    await expect(getMediaById(client, { imdb: 'not-an-imdb-id' })).rejects.toThrow('Invalid imdb ID');
    expect(requests).toBe(0);
  });

  test('reports unresolved redirects without fetching details', async () => {
    let requests = 0;
    const client = {
      request: async () => { requests++; return { redirectUrl: 'https://simkl.com/search' }; },
    } as any;
    await expect(getMediaById(client, { tmdb: 123, type: 'movie' })).rejects.toThrow('No matching Simkl title was found');
    expect(requests).toBe(1);
  });

  test('requires a media type for TMDB IDs', async () => {
    let requests = 0;
    const client = { request: async () => { requests++; return {}; } } as any;
    await expect(getMediaById(client, { tmdb: 123 })).rejects.toThrow('A type is required for TMDB IDs');
    expect(requests).toBe(0);
  });
});
