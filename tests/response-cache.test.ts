import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SimklClient, SimklApiError } from '../src/api/client';
import { createResponseCacheKey, getResponseCachePolicy, RESPONSE_CACHE_TTL_SECONDS } from '../src/api/response-cache';

describe('shared response cache policy', () => {
  test('uses the full URL as the key without authorization data', () => {
    const first = createResponseCacheKey(new URL('https://api.simkl.com/search/tv?q=the%20bear&page=1'));
    const otherQuery = createResponseCacheKey(new URL('https://api.simkl.com/search/tv?q=the%20bear&page=2'));
    expect(first.url).toBe('https://api.simkl.com/search/tv?q=the%20bear&page=1');
    expect(first.headers.has('Authorization')).toBe(false);
    expect(otherQuery.url).not.toBe(first.url);
  });

  test('assigns documented TTLs only to public catalog responses', () => {
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/search/tv?q=x'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.catalog);
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/tv/best/all'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.catalog);
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/tv/genres/drama/all'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.catalog);
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/tv/42'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.details);
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/tv/episodes/42'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.details);
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/discover/trending/tv/index.json'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.trending);
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/tv.json'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.calendar);
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/2026/8/anime.json'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.calendar);
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/movie_release.json'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.calendar);
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/2026/10/movie_release.json'), 'GET')?.ttlSeconds)
      .toBe(RESPONSE_CACHE_TTL_SECONDS.calendar);
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/tv.json'), 'POST')).toBeNull();
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/2026/13/tv.json'), 'GET')).toBeNull();
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/calendar/v2/other.json'), 'GET')).toBeNull();
    expect(getResponseCachePolicy(new URL('https://data.simkl.in/private/data.json'), 'GET')).toBeNull();
    expect(getResponseCachePolicy(new URL('https://other.example/calendar/v2/tv.json'), 'GET')).toBeNull();
    expect(getResponseCachePolicy(new URL('http://data.simkl.in/calendar/v2/tv.json'), 'GET')).toBeNull();
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/users/settings'), 'GET')).toBeNull();
    expect(getResponseCachePolicy(new URL('https://api.simkl.com/search/tv?q=x'), 'POST')).toBeNull();
  });
});

describe('SimklClient shared cache behavior', () => {
  let originalFetch: typeof fetch;
  let originalCaches: PropertyDescriptor | undefined;
  let entries: Map<string, Response>;
  let fetchCount: number;
  let putCount: number;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    entries = new Map();
    fetchCount = 0;
    putCount = 0;
    const defaultCache = {
      match: async (key: Request) => entries.get(key.url)?.clone(),
      put: async (key: Request, response: Response) => {
        putCount++;
        entries.set(key.url, response.clone());
      },
    };
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: defaultCache } });
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ count: fetchCount }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete (globalThis as typeof globalThis & { caches?: CacheStorage }).caches;
  });

  test('shares catalog data across user tokens while bypassing user-specific endpoints', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    const first = await client.request('/search/tv', { method: 'GET', query: { q: 'x' }, token: 'user-one' });
    const second = await client.request('/search/tv', { method: 'GET', query: { q: 'x' }, token: 'user-two' });
    expect(first).toEqual(second);
    expect(fetchCount).toBe(1);
    expect(putCount).toBe(1);

    await client.request('/users/settings', { method: 'GET', token: 'user-one' });
    await client.request('/users/settings', { method: 'GET', token: 'user-two' });
    expect(fetchCount).toBe(3);
    expect(putCount).toBe(1);
  });

  test('does not cache failed upstream responses', async () => {
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response('upstream error', { status: 503, statusText: 'Unavailable' });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    await expect(client.request('/search/tv', { method: 'GET' })).rejects.toBeInstanceOf(SimklApiError);
    expect(putCount).toBe(0);
    expect(fetchCount).toBe(3);
  });

  test('caches rolling calendars and monthly archives by full URL without user credentials', async () => {
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      requests.push({
        url: String(input),
        auth: new Headers(init?.headers).get('Authorization'),
      });
      return Response.json({ pathname: new URL(String(input)).pathname, count: fetchCount });
    }) as typeof fetch;

    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    const rolling = 'https://data.simkl.in/calendar/v2/tv.json';
    const archive = 'https://data.simkl.in/calendar/v2/2026/8/tv.json';

    const first = await client.request(rolling, { method: 'GET', token: 'secret-one' });
    const second = await client.request(rolling, { method: 'GET', token: 'secret-two' });
    expect(second).toEqual(first);
    expect(await client.request(archive, { method: 'GET', token: 'secret-three' }))
      .toEqual({ pathname: '/calendar/v2/2026/8/tv.json', count: 2 });
    expect(fetchCount).toBe(2);
    expect(putCount).toBe(2);
    expect(requests.every(request => request.auth === null)).toBe(true);
    expect([...entries.keys()].every(key => !key.includes('secret'))).toBe(true);
    expect(entries.size).toBe(2);
    expect([...entries.values()].every(response => response.headers.get('Cache-Control') === 'public, max-age=3600')).toBe(true);
  });

  test('rejects credential-bearing CDN URLs before requesting or caching', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    for (const url of [
      'https://data.simkl.in/calendar/v2/tv.json?access_token=secret',
      'https://secret@data.simkl.in/calendar/v2/tv.json',
    ]) {
      await expect(client.request(url, { method: 'GET' }))
        .rejects.toThrow('CDN requests cannot include credentials');
    }
    expect(fetchCount).toBe(0);
    expect(putCount).toBe(0);
  });

  test('does not populate cache for oversized CDN files', async () => {
    globalThis.fetch = (async () => {
      fetchCount++;
      return Response.json({ payload: 'x'.repeat(8 * 1024 * 1024) });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    const url = 'https://data.simkl.in/calendar/v2/tv.json';

    await expect(client.request(url, { method: 'GET' })).rejects.toThrow('response too large');
    await expect(client.request(url, { method: 'GET' })).rejects.toThrow('response too large');
    expect(fetchCount).toBe(2);
    expect(putCount).toBe(0);
  });

  test('stores explicit cache TTL and preserves Last-Modified', async () => {
    globalThis.fetch = (async () => new Response('[]', {
      status: 200,
      headers: {
        'Last-Modified': 'Tue, 13 Oct 2026 00:00:00 GMT',
        'Content-Encoding': 'gzip',
        'Content-Length': '7',
      },
    })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    await client.request('https://data.simkl.in/discover/trending/tv/index.json', { method: 'GET' });
    const stored = [...entries.values()][0];
    expect(stored.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(stored.headers.get('Last-Modified')).toBe('Tue, 13 Oct 2026 00:00:00 GMT');
    expect(stored.headers.has('Content-Encoding')).toBe(false);
    expect(stored.headers.has('Content-Length')).toBe(false);
  });
});
