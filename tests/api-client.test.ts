import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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

  // issue #43: Simkl's duplicate stop is already persisted upstream.
  test('returns a successful already-recorded stop without changing its original timestamp or retrying', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({
        error: 'already_watched',
        watched_at: '2026-05-08T14:00:00Z',
        expires_at: '2026-05-08T15:00:00Z',
      }, { status: 409, headers: { 'X-RateLimit-Remaining': '37' } });
    }) as typeof fetch;

    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    expect(await client.requestWithMetadata('/scrobble/stop', { method: 'POST', token: 'token', body: { progress: 100 } })).toEqual({
      data: {
        already_recorded: true,
        watched_at: '2026-05-08T14:00:00Z',
        expires_at: '2026-05-08T15:00:00Z',
      },
      headers: { rateLimitRemaining: '37' },
    });
    expect(attempts).toBe(1);
  });

  // Live Cloudflare telemetry (2026-10-19 19:47/19:49 UTC) classified the
  // upstream 409 as wrong_error. The duplicate window itself is independent
  // evidence, provided *both* verified dates delimit the active one-hour period.
  test.each([
    ['nonstandard error code', 'conflict'],
    ['missing error code', undefined],
    ['alternative duplicate code', 'already_scrobbled'],
  ])('accepts a live one-hour duplicate signature with %s', async (_name, code) => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const watchedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiresAt = new Date(Date.parse(watchedAt) + 60 * 60_000).toISOString();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        ...(code === undefined ? {} : { error: code }),
        watched_at: watchedAt,
        expires_at: expiresAt,
      }, { status: 409, headers: { 'X-RateLimit-Remaining': '19' } });
    }) as typeof fetch;
    try {
      const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
      expect(await client.requestWithMetadata('/scrobble/stop', {
        method: 'POST', token: 'private-token', body: { movie: { ids: { simkl: 100838 } } },
      })).toEqual({
        data: { already_recorded: true, watched_at: watchedAt, expires_at: expiresAt },
        headers: { rateLimitRemaining: '19' },
      });
      expect(calls).toBe(1);
      expect(info).toHaveBeenCalledTimes(1);
      const log = String(info.mock.calls[0][0]);
      expect(JSON.parse(log)).toEqual({
        component: 'simkl_scrobble',
        event: 'stop_conflict',
        classification: 'already_recorded_window',
      });
      expect(log).not.toContain(watchedAt);
      expect(log).not.toContain('private-token');
      expect(log).not.toContain('100838');
    } finally {
      info.mockRestore();
    }
  });

  test.each([
    ['no expiry', (w: string, _e: string) => ({ error: 'conflict', watched_at: w })],
    ['missing watch time', (_w: string, e: string) => ({ error: 'conflict', expires_at: e })],
    ['invalid watch date', (_w: string, e: string) => ({ error: 'conflict', watched_at: 'tomorrow', expires_at: e })],
    ['invalid expiry date', (w: string, _e: string) => ({ error: 'conflict', watched_at: w, expires_at: 'nope' })],
    ['expiry before now', (_w: string, _e: string) => {
      const w = new Date(Date.now() - 90 * 60_000).toISOString();
      return { error: 'conflict', watched_at: w, expires_at: new Date(Date.parse(w) + 60 * 60_000).toISOString() };
    }],
    ['watch time in future', (_w: string, _e: string) => {
      const w = new Date(Date.now() + 5 * 60_000).toISOString();
      return { error: 'conflict', watched_at: w, expires_at: new Date(Date.parse(w) + 60 * 60_000).toISOString() };
    }],
    ['non-hour expiry', (w: string, _e: string) =>
      ({ error: 'conflict', watched_at: w, expires_at: new Date(Date.parse(w) + 30 * 60_000).toISOString() })],
    ['explicit write lock', (w: string, e: string) => ({ error: 'write_lock', watched_at: w, expires_at: e })],
    ['explicit quota error', (w: string, e: string) => ({ error: 'user_limit_exceeded', watched_at: w, expires_at: e })],
  ] as const)('rejects %s with a nonstandard error code without retry', async (_name, payload) => {
    const watch = new Date(Date.now() - 8 * 60_000).toISOString();
    const expiry = new Date(Date.parse(watch) + 60 * 60_000).toISOString();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json(payload(watch, expiry), { status: 409 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/scrobble/stop', { method: 'POST' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(calls).toBe(1);
  });

  test.each([
    ['/scrobble/pause', 'POST' as const, 409],
    ['/scrobble/stop', 'GET' as const, 409],
    ['/scrobble/stop', 'POST' as const, 400],
  ])('does not normalize a timed 409 signature on %s %s %s', async (endpoint, method, status) => {
    const watch = new Date(Date.now() - 8 * 60_000).toISOString();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        error: 'conflict',
        watched_at: watch,
        expires_at: new Date(Date.parse(watch) + 60 * 60_000).toISOString(),
      }, { status });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request(endpoint, { method })).rejects.toMatchObject({ statusCode: status });
    expect(calls).toBe(1);
  });

  test('preserves an upstream ISO timestamp with an explicit offset and supports an absent expiry', async () => {
    globalThis.fetch = (async () => Response.json({
      error: 'already_watched', watched_at: '2026-05-08T11:00:00-03:00',
    }, { status: 409 })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    expect(await client.request('/scrobble/stop', { method: 'POST' })).toEqual({
      already_recorded: true, watched_at: '2026-05-08T11:00:00-03:00',
    });
  });

  test.each([
    { name: 'wrong error code', endpoint: '/scrobble/stop', method: 'POST' as const, status: 409, body: '{"error":"conflict","watched_at":"2026-05-08T14:00:00Z"}' },
    { name: 'missing original date', endpoint: '/scrobble/stop', method: 'POST' as const, status: 409, body: '{"error":"already_watched"}' },
    { name: 'invalid original date', endpoint: '/scrobble/stop', method: 'POST' as const, status: 409, body: '{"error":"already_watched","watched_at":"tomorrow"}' },
    { name: 'invalid expiry', endpoint: '/scrobble/stop', method: 'POST' as const, status: 409, body: '{"error":"already_watched","watched_at":"2026-05-08T14:00:00Z","expires_at":"unknown"}' },
    { name: 'unparseable conflict', endpoint: '/scrobble/stop', method: 'POST' as const, status: 409, body: 'not-json' },
    { name: 'different endpoint', endpoint: '/scrobble/pause', method: 'POST' as const, status: 409, body: '{"error":"already_watched","watched_at":"2026-05-08T14:00:00Z"}' },
    { name: 'different method', endpoint: '/scrobble/stop', method: 'GET' as const, status: 409, body: '{"error":"already_watched","watched_at":"2026-05-08T14:00:00Z"}' },
    { name: 'different HTTP status', endpoint: '/scrobble/stop', method: 'POST' as const, status: 400, body: '{"error":"already_watched","watched_at":"2026-05-08T14:00:00Z"}' },
  ])('keeps $name as an upstream error and never retries', async ({ endpoint, method, status, body }) => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response(body, { status });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request(endpoint, { method, rateLimitRetry: false })).rejects.toMatchObject({ statusCode: status });
    expect(attempts).toBe(1);
  });

  test.each([
    ['valid duplicate', { error: 'already_watched', watched_at: '2026-10-19T18:00:00Z', expires_at: '2026-10-19T19:00:00Z' }, 'already_recorded', false],
    ['missing watch time', { error: 'already_watched' }, 'missing_watched_at', true],
    ['invalid watch time', { error: 'already_watched', watched_at: 'untrusted-timestamp' }, 'invalid_watched_at', true],
    ['invalid expiry', { error: 'already_watched', watched_at: '2026-10-19T18:00:00Z', expires_at: 'nope' }, 'invalid_expires_at', true],
    ['unrelated conflict', { error: 'other_conflict' }, 'wrong_error', true],
    ['non-object', ['already_watched'], 'invalid_body', true],
  ] as const)('logs only a safe classification for %s', async (_label, payload, classification, rejected) => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const secret = 'sensitive-token-that-must-not-leak';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json(payload, { status: 409 });
    }) as typeof fetch;
    try {
      const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
      if (rejected) {
        await expect(client.request('/scrobble/stop', {
          method: 'POST', token: secret, body: { movie: { ids: { simkl: 100838 } } },
        })).rejects.toMatchObject({ statusCode: 409 });
      } else {
        expect(await client.request('/scrobble/stop', { method: 'POST', token: secret })).toEqual({
          already_recorded: true,
          watched_at: '2026-10-19T18:00:00Z',
          expires_at: '2026-10-19T19:00:00Z',
        });
      }
      expect(calls).toBe(1);
      expect(info).toHaveBeenCalledTimes(1);
      const line = String(info.mock.calls[0][0]);
      expect(JSON.parse(line)).toEqual({ component: 'simkl_scrobble', event: 'stop_conflict', classification });
      expect(line).not.toContain(secret);
      expect(line).not.toContain('100838');
      expect(line).not.toContain('2026-10-19');
      expect(line).not.toContain('other_conflict');
    } finally {
      info.mockRestore();
    }
  });

  test('classifies a malformed duplicate response without retry or sensitive logs', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('invalid json - confidential', { status: 409 });
    }) as typeof fetch;
    try {
      const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
      await expect(client.request('/scrobble/stop', { method: 'POST' })).rejects.toMatchObject({ statusCode: 409 });
      expect(calls).toBe(1);
      expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
        component: 'simkl_scrobble', event: 'stop_conflict', classification: 'invalid_json',
      });
      expect(String(info.mock.calls[0][0])).not.toContain('confidential');
    } finally {
      info.mockRestore();
    }
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


  // issue #42 regression: an upstream 5xx can occur after a mutation was applied.
  test.each(['POST', 'DELETE'] as const)('never automatically retries %s after 5xx', async method => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({ error: 'internal_error' }, { status: 503 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/sync/history', { method, body: { movies: [] } }))
      .rejects.toMatchObject({ statusCode: 503, writeMayHaveSucceeded: true });
    expect(attempts).toBe(1);
  });

  test('GET recovers after two transient server failures', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts < 3 ? Response.json({ error: 'internal_error' }, { status: 502 }) : Response.json({ ok: true });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/sync/activities', { method: 'GET' })).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  test('retries a 400 uppercase RATE_LIMIT write lock once', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts === 1
        ? Response.json({ error: 'RATE_LIMIT' }, { status: 400 })
        : Response.json({ added: {} });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/sync/history', { method: 'POST', body: {} })).resolves.toEqual({ added: {} });
    expect(attempts).toBe(2);
  });

  test('write-lock retry can be disabled for serialized writes', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({ error: 'RATE_LIMIT' }, { status: 400 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/sync/history', { method: 'POST', body: {}, rateLimitRetry: false }))
      .rejects.toMatchObject({ statusCode: 400, upstreamCode: 'write_lock' });
    expect(attempts).toBe(1);
  });

  test('never retries a 400 write-lock response on GET', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({ error: 'RATE_LIMIT' }, { status: 400 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/sync/activities', { method: 'GET' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(attempts).toBe(1);
  });

  test('does not retry an exhausted POST daily quota', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return Response.json({ error: 'app_limit_exceeded' }, { status: 429 });
    }) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('/sync/history', { method: 'POST', body: {} }))
      .rejects.toMatchObject({ statusCode: 429, upstreamCode: 'app_limit_exceeded' });
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

  test('accepts known CDN JSON files larger than 2 MiB but smaller than 8 MiB', async () => {
    const payload = { data: 'x'.repeat(3 * 1024 * 1024) };
    globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    for (const url of [
      'https://data.simkl.in/calendar/v2/tv.json',
      'https://data.simkl.in/calendar/v2/2026/8/tv.json',
      'https://data.simkl.in/calendar/v2/2026/10/movie_release.json',
      'https://data.simkl.in/discover/trending/tv/today_100.json',
    ]) {
      expect(await client.request(url, { method: 'GET' })).toEqual(payload);
    }
  });

  test('rejects CDN JSON bodies over the 8 MiB limit', async () => {
    globalThis.fetch = (async () => Response.json({ data: 'x'.repeat(8 * 1024 * 1024) })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    await expect(client.request('https://data.simkl.in/calendar/v2/tv.json', { method: 'GET' }))
      .rejects.toThrow('response too large');
  });

  test('keeps unrelated CDN and API responses at 2 MiB', async () => {
    globalThis.fetch = (async () => Response.json({ data: 'x'.repeat(3 * 1024 * 1024) })) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    for (const url of [
      'https://data.simkl.in/other/path.json',
      '/search/tv',
      'https://other.example/calendar/v2/tv.json',
    ]) {
      await expect(client.request(url, { method: 'GET' })).rejects.toThrow('response too large');
    }
  });

  test('preserves the dedicated library limit above 2 MiB', async () => {
    const payload = { data: 'x'.repeat(3 * 1024 * 1024) };
    globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-id' });
    expect(await client.request('/sync/all-items', { method: 'GET', responseProfile: 'library' })).toEqual(payload);
    await expect(client.request('/sync/all-items', { method: 'GET' })).rejects.toThrow('response too large');
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
