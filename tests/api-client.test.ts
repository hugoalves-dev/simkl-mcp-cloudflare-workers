import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SimklApiError, SimklClient } from '../src/api/client';
import { toolsWhitelist } from '../src/tools-config';

describe('SimklClient request policy', () => {
  let originalFetch: typeof fetch;
  let requests: Array<{ url: URL; init: RequestInit }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: new URL(String(input)), init: init ?? {} });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('adds Simkl identification to relative API requests', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await client.request('/movies/trending/today', { method: 'GET' });

    const { url, init } = requests[0];
    expect(url.origin).toBe('https://api.simkl.com');
    expect(url.pathname).toBe('/movies/trending/today');
    expect(url.searchParams.get('client_id')).toBe('app-id');
    expect(url.searchParams.get('app-name')).toBe('simkl-mcp');
    expect(url.searchParams.get('app-version')).toBe('1.0.0');
    expect(new Headers(init.headers).get('User-Agent')).toBe('simkl-mcp/1.0.0');
  });

  test('adds identification to absolute HTTPS endpoints and preserves their query', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await client.request('https://data.simkl.in/discover/trending/movies/today_100.json?existing=yes', {
      method: 'GET', query: { period: 'daily' },
    });

    const { url } = requests[0];
    expect(url.origin).toBe('https://data.simkl.in');
    expect(url.pathname).toBe('/discover/trending/movies/today_100.json');
    expect(url.searchParams.get('existing')).toBe('yes');
    expect(url.searchParams.get('period')).toBe('daily');
    expect(url.searchParams.get('client_id')).toBe('app-id');
    expect(url.searchParams.get('app-name')).toBe('simkl-mcp');
    expect(url.searchParams.get('app-version')).toBe('1.0.0');
    expect(new Headers(requests[0].init.headers).get('User-Agent')).toBe('simkl-mcp/1.0.0');
  });

  test('uses bearer authorization by default when a token is provided', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await client.request('/users/settings', { method: 'GET', token: 'user-token' });
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe('Bearer user-token');
  });

  test('omits authorization when explicitly configured as none', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await client.request('/movies/42', { method: 'GET', token: 'user-token', authorization: 'none' });
    expect(new Headers(requests[0].init.headers).has('Authorization')).toBe(false);
  });

  test('can inspect a redirect Location header without following it', async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(null, {
        status: 301,
        headers: { Location: 'https://simkl.com/movies/42/title' },
      });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/redirect', { method: 'GET', authorization: 'none', redirect: 'manual' }))
      .resolves.toEqual({ redirectUrl: 'https://simkl.com/movies/42/title' });
    expect(requestInit?.redirect).toBe('manual');
  });

  test('preserves quota headers on upstream errors', async () => {
    globalThis.fetch = (async () => new Response('{"error":"user_limit_exceeded"}', {
      status: 429,
      headers: { 'X-RateLimit-Limit': '10000', 'X-RateLimit-Remaining': '0', 'Retry-After': '3600' },
    })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    try {
      await client.request('/sync/all-items/shows/watching', { method: 'GET', token: 'access-token' });
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SimklApiError);
      expect((error as SimklApiError).headers).toEqual({
        rateLimitLimit: '10000', rateLimitRemaining: '0', retryAfter: '3600',
      });
    }
  });

  test('retries a per-second rate limit once and returns remaining allowance metadata', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) return new Response('{"error":"rate_limit"}', { status: 429 });
      return new Response('{"ok":true}', { status: 200, headers: { 'X-RateLimit-Remaining': '37' } });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });

    const result = await client.requestWithMetadata<{ ok: boolean }>('/test', { method: 'GET' });
    expect(attempts).toBe(2);
    expect(result).toEqual({ data: { ok: true }, headers: { rateLimitRemaining: '37' } });
  });

  test('retries direct writes once unless a coordinator disables client retry', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts === 1
        ? Response.json({ error: 'rate_limit' }, { status: 429 })
        : Response.json({ added: {} });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });

    await client.request('/sync/history', { method: 'POST', body: {} });
    expect(attempts).toBe(2);
  });

  test('does not assume remaining allowance when the response omits the header', async () => {
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    const result = await client.requestWithMetadata('/free-endpoint', { method: 'GET', authorization: 'none' });
    expect(result.headers.rateLimitRemaining).toBeUndefined();
  });

  test('does not retry exhausted user allowance', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response('{"error":"user_limit_exceeded"}', { status: 429 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });

    await expect(client.request('/test', { method: 'GET' })).rejects.toMatchObject({ upstreamCode: 'user_limit_exceeded' });
    expect(attempts).toBe(1);
  });

  test('retries server errors with a bounded count', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response('unavailable', { status: 503 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });

    await expect(client.request('/test', { method: 'GET' })).rejects.toBeInstanceOf(SimklApiError);
    expect(attempts).toBe(3);
  });

  test('keeps the streamed response reader bounded at two mebibytes', async () => {
    globalThis.fetch = (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/large', { method: 'GET' })).rejects.toThrow('response too large');
  });
});

describe('generated tool request policy configuration', () => {
  test('marks all public catalog tools as unauthenticated', () => {
    const publicPaths = ['/movies/:id', '/tv/:id', '/anime/:id', '/tv/episodes/:id', '/anime/episodes/:id'];
    for (const path of publicPaths) {
      expect(toolsWhitelist.find(tool => tool.path === path)?.authorization).toBe('none');
    }
  });

  test('uses the current OpenAPI GET operation for stats', () => {
    const stats = toolsWhitelist.find(tool => tool.path === '/users/:user_id/stats');
    expect(stats?.method).toBe('get');
    expect(stats?.schemaMethod).toBeUndefined();
  });

  test('configures existing trending tools for public data files', () => {
    const trendingTools = [
      ['/tv/trending/:interval', '/discover/trending/{type}/{file}.json'],
      ['/movies/trending/:interval', '/discover/trending/{type}/{file}.json'],
      ['/anime/trending/:interval', '/discover/trending/{type}/{file}.json'],
    ];

    for (const [path, schemaPath] of trendingTools) {
      const tool = toolsWhitelist.find(candidate => candidate.path === path);
      expect(tool?.method).toBe('get');
      expect(tool?.authorization).toBe('none');
      expect(tool?.requestPath?.helper).toBe('simklTrendingPath');
      expect(tool?.schemaPath).toBe(schemaPath);
    }
  });

  test('registers the public genre tool and explains live genre quota behavior', () => {
    const publicGenreTool = toolsWhitelist.find(tool => tool.custom?.name === 'simkl_get_trending_by_genre');
    expect(publicGenreTool?.custom?.schema).toContain("z.enum(['tv', 'movies', 'anime'])");
    expect(publicGenreTool?.description).toContain('updated daily');
    expect(publicGenreTool?.description).toContain('no user token');

    for (const path of ['/tv/genres/:genre/:type/:country/:network/:year/:sort', '/anime/genres/:genre/:type/:network/:year/:sort', '/movies/genres/:genre/:type/:country/:year/:sort']) {
      const liveTool = toolsWhitelist.find(tool => tool.path === path);
      expect(liveTool?.description).toContain('user’s daily allowance');
      expect(liveTool?.extraQueryParams).toEqual(['page', 'limit']);
      expect(liveTool?.responseFormat?.type).toBe('simple');
      if (liveTool?.responseFormat?.type === 'simple') {
        expect(liveTool.responseFormat.template(null, {})).toEqual(['no results for this genre']);
        expect(liveTool.authorization).not.toBe('none');
      }
    }
  });

  test('routes airing and ID lookup through public data helpers', () => {
    const airingTools = [
      ['/tv/airing', 'simkl_get_airing_shows'],
      ['/anime/airing', 'simkl_get_airing_anime'],
    ];
    for (const [path, name] of airingTools) {
      const tool = toolsWhitelist.find(candidate => candidate.path === path);
      expect(tool?.custom?.name).toBe(name);
      expect(tool?.custom?.imports?.[0]).toContain('formatAiringTool');
    }

    const lookup = toolsWhitelist.find(tool => tool.custom?.name === 'simkl_search_by_id');
    expect(lookup?.custom?.handler).toContain('getMediaById');
    expect(lookup?.custom?.schema).toContain('imdb: z.string().regex');
    expect(toolsWhitelist.find(tool => tool.path === '/search/id')?.custom).toBeDefined();
  });
});
