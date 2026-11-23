import { afterEach, describe, expect, mock, test } from 'bun:test';
import { sqliteStorage } from './helpers/library-storage';
import { IdResolutionStore } from '../src/api/id-resolution-store';
import {
  createRedirectGuard, idResolutionKey, parseIdCacheTtlSeconds, parseRedirectDailyBudget,
  SimklRedirectBudgetError, SimklRedirectGuardUnavailableError, type RedirectGuard,
} from '../src/api/id-resolution';
import { getMediaById } from '../src/api/id-lookup';
import { SimklClient } from '../src/api/client';
import { toMcpErrorResult } from '../src/api/errors';

mock.module('cloudflare:workers', () => ({ DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
const { SimklIdResolutionGuard } = await import('../src/api/id-resolution-object');

const HOUR = 60 * 60 * 1000;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Same contract as the Durable Object stub, backed by the real SQL store. */
function guardFor(object: InstanceType<typeof SimklIdResolutionGuard>): RedirectGuard {
  const namespace = {
    idFromName: () => ({}),
    get: () => ({
      lookup: async (key: string) => object.lookup(key),
      reserve: async () => object.reserve(),
      store: async (key: string, value: any) => object.store(key, value),
    }),
  };
  return createRedirectGuard(namespace as any);
}

function newObject(env: Record<string, string> = {}) {
  return new SimklIdResolutionGuard({ storage: sqliteStorage().storage } as any, env);
}

function fakeUpstream(onRedirect: (url: URL) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/redirect') {
      expect(init?.redirect).toBe('manual');
      return onRedirect(url);
    }
    const [, type, id] = url.pathname.split('/');
    return Response.json({ title: `${type}-${id}`, ids: { simkl: Number(id) } });
  }) as typeof fetch;
  return calls;
}

const client = () => new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app-client-id' });
const redirectTo = (location: string) => new Response(null, { status: 301, headers: { Location: location } });

describe('IdResolutionStore budget', () => {
  test('allows exactly the limit inside a rolling 24h window, then frees the oldest hour', () => {
    const store = new IdResolutionStore(sqliteStorage().storage);
    const start = Date.UTC(2026, 10, 23, 10, 15);
    expect(store.reserve(start, 3).allowed).toBe(true);
    expect(store.reserve(start + 2 * HOUR, 3).allowed).toBe(true);
    expect(store.reserve(start + 5 * HOUR, 3).allowed).toBe(true);
    const blocked = store.reserve(start + 6 * HOUR, 3);
    expect(blocked.allowed).toBe(false);
    // The first bucket (10:00) leaves the window at 10:00 the next day.
    expect(blocked.retryAfterSeconds).toBe((24 * HOUR - 6 * HOUR - 15 * 60 * 1000) / 1000);
    expect(store.reserve(start + 24 * HOUR, 3).allowed).toBe(true);
    expect(store.reserve(start + 24 * HOUR, 3).allowed).toBe(false);
  });

  test('a zero budget never allows an upstream call', () => {
    const store = new IdResolutionStore(sqliteStorage().storage);
    expect(store.reserve(Date.now(), 0).allowed).toBe(false);
  });

  test('expired resolutions are not served', () => {
    const store = new IdResolutionStore(sqliteStorage().storage);
    const key = 'a'.repeat(64);
    store.store(key, { type: 'movies', id: 1, slug: 'x' }, 0, 3600);
    expect(store.lookup(key, 3599_000)).toEqual({ type: 'movies', id: 1, slug: 'x' });
    expect(store.lookup(key, 3600_000)).toBeNull();
  });
});

describe('configuration', () => {
  test('budget defaults conservatively and is clamped below Simkl block threshold', () => {
    expect(parseRedirectDailyBudget(undefined)).toBe(500);
    expect(parseRedirectDailyBudget('garbage')).toBe(500);
    expect(parseRedirectDailyBudget('-5')).toBe(500);
    expect(parseRedirectDailyBudget('0')).toBe(0);
    expect(parseRedirectDailyBudget('10000')).toBe(999);
  });

  test('cache TTL defaults to 30 days and rejects out-of-range values', () => {
    expect(parseIdCacheTtlSeconds(undefined)).toBe(2592000);
    expect(parseIdCacheTtlSeconds('60')).toBe(2592000);
    expect(parseIdCacheTtlSeconds('86400')).toBe(86400);
  });
});

describe('idResolutionKey', () => {
  test('TMDB movie and TV IDs never share a key', async () => {
    expect(await idResolutionKey({ tmdb: 603, type: 'movie' })).not.toBe(await idResolutionKey({ tmdb: 603, type: 'tv' }));
  });

  test('normalizes title case/spacing and parameter order; year still discriminates', async () => {
    const a = await idResolutionKey({ title: 'The  Matrix', year: 1999, type: 'movie' });
    expect(await idResolutionKey({ type: 'movie', year: 1999, title: 'the matrix ' })).toBe(a);
    expect(await idResolutionKey({ title: 'The Matrix', year: 2021, type: 'movie' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('getMediaById with the shared guard', () => {
  test('a repeated lookup is a cache hit with zero additional redirects', async () => {
    const calls = fakeUpstream(() => redirectTo('https://simkl.com/movies/472214/inception'));
    const guard = guardFor(newObject());
    const first = await getMediaById(client(), { imdb: 'tt1375666' }, guard);
    const second = await getMediaById(client(), { imdb: 'tt1375666' }, guard);
    expect(calls.filter(path => path === '/redirect')).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ simkl_url: 'https://simkl.com/movies/472214/inception' });
  });

  test('TMDB movie and TV resolutions are cached independently', async () => {
    const calls = fakeUpstream(url => redirectTo(url.searchParams.get('type') === 'movie'
      ? 'https://simkl.com/movies/1/a' : 'https://simkl.com/tv/2/b'));
    const guard = guardFor(newObject());
    expect(await getMediaById(client(), { tmdb: 603, type: 'movie' }, guard)).toMatchObject({ title: 'movies-1' });
    expect(await getMediaById(client(), { tmdb: 603, type: 'tv' }, guard)).toMatchObject({ title: 'tv-2' });
    expect(await getMediaById(client(), { tmdb: 603, type: 'movie' }, guard)).toMatchObject({ title: 'movies-1' });
    expect(calls.filter(path => path === '/redirect')).toHaveLength(2);
  });

  test('a Simkl ID with a known type skips /redirect and the budget entirely', async () => {
    const calls = fakeUpstream(() => { throw new Error('must not redirect'); });
    const guard = guardFor(newObject({ SIMKL_REDIRECT_DAILY_BUDGET: '0' }));
    expect(await getMediaById(client(), { simkl: 17465, type: 'tv' }, guard)).toMatchObject({ title: 'tv-17465' });
    expect(calls).toEqual(['/tv/17465']);
  });

  test('a Simkl ID with the ambiguous show type still resolves through the guard', async () => {
    const calls = fakeUpstream(() => redirectTo('https://simkl.com/anime/9/x'));
    await getMediaById(client(), { simkl: 9, type: 'show' }, guardFor(newObject()));
    expect(calls).toEqual(['/redirect', '/anime/9']);
  });

  test('concurrent lookups cannot overrun the shared budget', async () => {
    let redirects = 0;
    fakeUpstream(async url => {
      redirects++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return redirectTo(`https://simkl.com/movies/${url.searchParams.get('mal')}/x`);
    });
    const object = newObject({ SIMKL_REDIRECT_DAILY_BUDGET: '5' });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
      getMediaById(client(), { mal: index + 1 }, guardFor(object))));
    expect(redirects).toBe(5);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(15);
    for (const result of rejected) expect(result.reason).toBeInstanceOf(SimklRedirectBudgetError);
  });

  test('exhaustion blocks new upstream calls but still serves cached results', async () => {
    const calls = fakeUpstream(url => redirectTo(`https://simkl.com/anime/${url.searchParams.get('mal')}/x`));
    const guard = guardFor(newObject({ SIMKL_REDIRECT_DAILY_BUDGET: '1' }));
    await getMediaById(client(), { mal: 1 }, guard);
    const error = await getMediaById(client(), { mal: 2 }, guard).catch(e => e);
    expect(error).toBeInstanceOf(SimklRedirectBudgetError);
    expect(await getMediaById(client(), { mal: 1 }, guard)).toMatchObject({ title: 'anime-1' });
    expect(calls.filter(path => path === '/redirect')).toHaveLength(1);

    const text = toMcpErrorResult(error).content[0].text;
    expect(text).toContain('SIMKL_ID_RESOLUTION_BUDGET_EXHAUSTED');
    expect(text).toContain('Do not retry');
    expect(text).not.toContain('app-client-id');
  });

  test('upstream retries each consume budget and stop when it runs out', async () => {
    let redirects = 0;
    fakeUpstream(() => { redirects++; return new Response('oops', { status: 503 }); });
    const guard = guardFor(newObject({ SIMKL_REDIRECT_DAILY_BUDGET: '2' }));
    // Up to 3 attempts (1 + 2 retries) would be made; the budget stops the third.
    await expect(getMediaById(client(), { mal: 1 }, guard)).rejects.toBeInstanceOf(SimklRedirectBudgetError);
    expect(redirects).toBe(2);
  });

  test('unresolved or malformed redirects are not cached and fetch no detail', async () => {
    const locations = ['https://simkl.com/search', 'https://evil.example/movies/1/x', ''];
    const calls = fakeUpstream(() => {
      const location = locations.shift()!;
      return location ? redirectTo(location) : new Response(null, { status: 301 });
    });
    const guard = guardFor(newObject());
    for (let i = 0; i < 3; i++) {
      await expect(getMediaById(client(), { mal: 7 }, guard)).rejects.toThrow('No matching Simkl title was found');
    }
    expect(calls).toEqual(['/redirect', '/redirect', '/redirect']);
  });

  test('fails closed when the guard is missing or unreachable', async () => {
    const calls = fakeUpstream(() => redirectTo('https://simkl.com/movies/1/x'));
    await expect(getMediaById(client(), { mal: 1 })).rejects.toBeInstanceOf(SimklRedirectGuardUnavailableError);
    const broken = createRedirectGuard({ idFromName: () => ({}), get: () => ({ lookup: async () => { throw new Error('down'); } }) } as any);
    await expect(getMediaById(client(), { mal: 1 }, broken)).rejects.toBeInstanceOf(SimklRedirectGuardUnavailableError);
    expect(calls).toEqual([]);
  });

  test('logs nothing that identifies the lookup or the client', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map(level => {
      const original = console[level];
      console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      return () => { console[level] = original; };
    });
    try {
      fakeUpstream(() => redirectTo('https://simkl.com/movies/472214/inception'));
      const guard = guardFor(newObject({ SIMKL_REDIRECT_DAILY_BUDGET: '1' }));
      await getMediaById(client(), { imdb: 'tt1375666' }, guard);
      await getMediaById(client(), { imdb: 'tt0000001' }, guard).catch(() => undefined);
    } finally { spies.forEach(restore => restore()); }
    const output = logged.join('\n');
    expect(output).toContain('budget_exhausted');
    for (const secret of ['tt1375666', 'tt0000001', 'app-client-id', '472214', 'inception']) expect(output).not.toContain(secret);
  });
});
