import { afterEach, describe, expect, test } from 'bun:test';
import { registerTools } from '../generated/tools';
import { SimklClient } from '../src/api/client';
import { getResponseCachePolicy } from '../src/api/response-cache';

type Handler = (args: any) => Promise<any>;

function register(getToken: () => string | undefined) {
  const handlers = new Map<string, Handler>();
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), authorization: new Headers(init?.headers).get('Authorization') });
    return Response.json([]);
  }) as typeof fetch;
  const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
  registerTools({ registerTool(name: string, _config: unknown, handler: Handler) { handlers.set(name, handler); } } as any,
    client, getToken, { write: async () => ({}) });
  return { handlers, requests };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('AUTH V2 enforcement', () => {
  const protectedCalls: Array<[string, Record<string, unknown>]> = [
    ['simkl_search_by_text', { type: 'tv', q: 'dune' }],
    ['simkl_get_best_shows', { filter: 'all' }],
    ['simkl_get_best_anime', { filter: 'all' }],
    ['simkl_get_shows_by_genre', { genre: 'all', type: 'all', country: 'all', network: 'all', year: 'all', sort: 'popular-this-week' }],
    ['simkl_get_anime_by_genre', { genre: 'all', type: 'all', network: 'all', year: 'all', sort: 'popular-this-week' }],
    ['simkl_get_movies_by_genre', { genre: 'all', type: 'all', country: 'all', year: 'all', sort: 'popular-this-week' }],
    ['simkl_get_user_stats', { user_id: '1' }],
    ['simkl_mark_watched', { movies: [{ ids: { simkl: 1 } }] }],
    ['simkl_add_rating', { body: { movies: [{ ids: { simkl: 1 }, rating: 8 }] } }],
  ];

  test.each(protectedCalls)('%s fails locally without a user token', async (name, args) => {
    const { handlers, requests } = register(() => undefined);
    const result = await handlers.get(name)!(args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires an AUTH V2 user access token');
    expect(requests).toHaveLength(0);
  });

  test('protected catalog calls send the user token', async () => {
    const { handlers, requests } = register(() => 'user-token');
    await handlers.get('simkl_search_by_text')!({ type: 'movie', q: 'dune' });
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer user-token');
  });

  const publicCalls: Array<[string, Record<string, unknown>, RegExp]> = [
    ['simkl_get_show_by_id', { id: 1 }, /^https:\/\/api\.simkl\.com\/tv\/1$/],
    ['simkl_get_movie_by_id', { id: 1 }, /^https:\/\/api\.simkl\.com\/movies\/1$/],
    ['simkl_get_show_episodes', { id: 1 }, /^https:\/\/api\.simkl\.com\/tv\/episodes\/1$/],
    ['simkl_get_anime_episodes', { id: 1 }, /^https:\/\/api\.simkl\.com\/anime\/episodes\/1$/],
    ['simkl_get_trending_shows', { interval: 'daily' }, /^https:\/\/data\.simkl\.in\//],
  ];

  test.each(publicCalls)('%s stays public and never sends a token', async (name, args, route) => {
    for (const token of [undefined, 'user-token']) {
      const { handlers, requests } = register(() => token);
      const result = await handlers.get(name)!(args);
      expect(result.isError).not.toBe(true);
      expect(requests).toHaveLength(1);
      expect(`${requests[0].url.origin}${requests[0].url.pathname}`).toMatch(route);
      expect(requests[0].authorization).toBeNull();
    }
  });
});

describe('shared response cache scope', () => {
  const policy = (url: string) => getResponseCachePolicy(new URL(url), 'GET');

  test.each(['tv', 'movie', 'anime', 'all', 'id'])('caches user-independent /search/%s catalog results', type => {
    expect(policy(`https://api.simkl.com/search/${type}?q=dune&client_id=app`)).not.toBeNull();
  });

  test.each([
    'https://api.simkl.com/lists/user/1',
    'https://api.simkl.com/lists/2',
    'https://api.simkl.com/users/1/stats',
    'https://api.simkl.com/users/settings',
    'https://api.simkl.com/sync/activities',
    'https://api.simkl.com/sync/all-items/shows/watching',
  ])('never caches user-scoped %s', url => {
    expect(policy(url)).toBeNull();
  });

  test('cache keys never carry credentials', async () => {
    const { createResponseCacheKey } = await import('../src/api/response-cache');
    const key = createResponseCacheKey(new URL('https://api.simkl.com/search/tv?q=dune'));
    expect(key.headers.get('Authorization')).toBeNull();
    expect(key.url).not.toContain('token');
  });
});
