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
    expect(fetchCount).toBe(1);
  });

  test('stores explicit cache TTL and preserves Last-Modified', async () => {
    globalThis.fetch = (async () => new Response('[]', {
      status: 200,
      headers: { 'Last-Modified': 'Tue, 13 Oct 2026 00:00:00 GMT' },
    })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
    await client.request('https://data.simkl.in/discover/trending/tv/index.json', { method: 'GET' });
    const stored = [...entries.values()][0];
    expect(stored.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(stored.headers.get('Last-Modified')).toBe('Tue, 13 Oct 2026 00:00:00 GMT');
  });
});
