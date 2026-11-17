import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sqliteStorage } from './helpers/library-storage';
import { SimklApiError } from '../src/api/client';
import {
  CustomListCooldownError, CustomListsService, customListCooldownSeconds, customListErrorResult,
  isCustomListRoute, type CustomListRequestOptions,
} from '../src/api/custom-lists';
import {
  CUSTOM_LIST_MEDIA_TYPES, CUSTOM_LIST_PERMISSIONS, CUSTOM_LIST_PRIVACY, CUSTOM_LIST_USER_SORTS,
  registerCustomListTools,
} from '../src/tools/custom-lists';
import { createLibraryAdapter, hasMediaWriteScope } from '../src/library/adapter';
import { decodeRpcError, encodeRpcError } from '../src/api/rpc-errors';

mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, exports: {}, env: {} }));
const { SimklLibraryCache } = await import('../src/library/cache');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type Call = { path: string; options: CustomListRequestOptions };

function fakeService(respond: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const service = new CustomListsService(async (path, options) => {
    const call = { path, options };
    calls.push(call);
    const data = respond(call);
    if (data instanceof Error) throw data;
    return { data, headers: {} };
  }, async () => '777');
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const schemas = new Map<string, any>();
  registerCustomListTools({
    registerTool(name: string, config: any, handler: (args: any) => Promise<any>) {
      handlers.set(name, handler);
      schemas.set(name, config);
    },
  } as any, service);
  return { calls, handlers, schemas };
}

const premiumOnly = {
  error: 'premium_only',
  message: 'Custom list items are available to Simkl PRO and VIP members only.',
  item: { title: 'Upgrade to Simkl PRO/VIP to unlock this list', description: 'Subscribe', poster: 'https://simkl.in/poster_upgrade.webp' },
};

describe('Custom Lists reads', () => {
  test('own lists default to the verified account ID and send documented query values', async () => {
    const { calls, handlers } = fakeService(() => ({ pagination: { page: 1 }, lists: [{ id: 1, name: 'Mine' }] }));
    const result = await handlers.get('simkl_get_user_custom_lists')!({ followed: true, collaborants: true, sort: 'name', limit: 10 });
    expect(result.isError).not.toBe(true);
    expect(calls[0].path).toBe('/lists/user/777');
    expect(calls[0].options).toEqual({
      method: 'GET',
      query: { page: undefined, limit: 10, sort: 'name', direction: undefined, followed: 'true', collaborants: 'true' },
    });
    expect(JSON.parse(result.content[0].text).lists).toHaveLength(1);
  });

  test.each([
    ['simkl_get_custom_list', { list_id: 42 }],
    ['simkl_get_user_custom_lists', { user_id: 9 }],
  ] as const)('%s treats an HTTP 200 premium_only body as an error, not list data', async (tool, args) => {
    const { handlers } = fakeService(() => premiumOnly);
    const result = await handlers.get(tool)!(args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('PRO or VIP');
    expect(result.content[0].text).not.toContain('Upgrade to Simkl PRO/VIP to unlock this list');
  });

  test('any other error body on a 200 is never returned as list data', async () => {
    const { handlers } = fakeService(() => ({ error: 'something_new', items: [] }));
    const result = await handlers.get('simkl_get_custom_list')!({ list_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('something_new');
  });

  test('get list maps extended to full and keeps the free-form sort token', async () => {
    const { calls, handlers } = fakeService(() => ({ id: 42, items: [] }));
    await handlers.get('simkl_get_custom_list')!({ list_id: 42, extended: true, sort: 'position', direction: 'asc' });
    expect(calls[0]).toEqual({ path: '/lists/42', options: { method: 'GET', query: { page: undefined, limit: undefined, sort: 'position', direction: 'asc', extended: 'full' } } });
  });
});

describe('Custom Lists writes', () => {
  test('partial edits send only the changed fields; tag sets are sent whole', async () => {
    const { calls, handlers } = fakeService(() => ({ id: 5 }));
    await handlers.get('simkl_update_custom_list')!({ list_id: 5, privacy: 'private', tags: [], sort: { by: 'position', direction: 'asc' } });
    expect(calls[0]).toEqual({ path: '/lists/5', options: { method: 'POST', body: { privacy: 'private', tags: [], sort: ['position', 'asc'] } } });
    const empty = await handlers.get('simkl_update_custom_list')!({ list_id: 5 });
    expect(empty.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('create requires name and media_type and rejects media_type on edits', async () => {
    const { calls, handlers, schemas } = fakeService(() => ({ id: 9 }));
    await handlers.get('simkl_create_custom_list')!({ name: 'Comfort', media_type: 'movies', display_number: true });
    expect(calls[0]).toEqual({ path: '/lists', options: { method: 'POST', body: { name: 'Comfort', display_number: true, media_type: 'movies' } } });
    const update = schemas.get('simkl_update_custom_list').inputSchema;
    expect(Object.keys(update)).not.toContain('media_type');
    expect(schemas.get('simkl_create_custom_list').inputSchema.name.safeParse(undefined).success).toBe(false);
  });

  test('items: supported IDs are sent, slug is refused, ordering flags are explicit', async () => {
    const { calls, handlers } = fakeService(() => ({ added: 1 }));
    await handlers.get('simkl_add_custom_list_items')!({
      list_id: 3,
      allow_reorder: true,
      movies: [{ ids: { simkl: 53992, imdb: 'tt0111161', tmdb: '278' }, user_position: 1, note: { public: 'Great' } }],
    });
    expect(calls[0]).toEqual({
      path: '/lists/3/items',
      options: {
        method: 'POST',
        query: { allow_reorder: 'yes' },
        body: { movies: [{ ids: { simkl: 53992, imdb: 'tt0111161', tmdb: '278' }, user_position: 1, note: { public: 'Great' } }] },
      },
    });

    await handlers.get('simkl_add_custom_list_items')!({ list_id: 3, shows: [{ ids: { simkl: 1 } }] });
    expect(calls[1].options.query).toEqual({ allow_reorder: undefined });

    const slug = await handlers.get('simkl_add_custom_list_items')!({ list_id: 3, movies: [{ ids: { slug: 'the-movie' } }] });
    expect(slug.isError).toBe(true);
    expect(slug.content[0].text).toContain('response-only');
    const unknown = await handlers.get('simkl_add_favorites')!({ shows: [{ ids: { foo: 1 } }] });
    expect(unknown.isError).toBe(true);
    const none = await handlers.get('simkl_remove_favorites')!({});
    expect(none.isError).toBe(true);
    const seasonOnMovie = await handlers.get('simkl_remove_custom_list_items')!({ list_id: 3, movies: [{ ids: { simkl: 1 }, season: 2 }] });
    expect(seasonOnMovie.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('simkl_id and title-only items are accepted; more than 1000 titles are refused locally', async () => {
    const { calls, handlers } = fakeService(() => ({ deleted: 1 }));
    await handlers.get('simkl_remove_custom_list_items')!({ list_id: 3, anime: [{ ids: { simkl_id: 7 }, season: 2 }], movies: [{ title: 'Heat', year: 1995 }] });
    expect(calls[0].path).toBe('/lists/3/items/remove');
    const many = Array.from({ length: 1001 }, (_, index) => ({ ids: { simkl: index + 1 } }));
    const result = await handlers.get('simkl_add_favorites')!({ movies: many });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('delete returns an explicit outcome for the empty 204 body', async () => {
    const { calls, handlers } = fakeService(() => ({}));
    const result = await handlers.get('simkl_delete_custom_list')!({ list_id: 8 });
    expect(calls[0]).toEqual({ path: '/lists/8', options: { method: 'DELETE' } });
    expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true, list_id: 8 });
  });

  test.each([
    [new SimklApiError('x', 403, JSON.stringify({ error: 'premium_only' })), 'PRO or VIP'],
    [new SimklApiError('x', 403, JSON.stringify({ error: 'insufficient_scope' })), 'media:write'],
    [new SimklApiError('x', 403, JSON.stringify({ error: 'oauth2_token_required' })), 'AUTH V1 token'],
    [new SimklApiError('x', 401, JSON.stringify({ error: 'user_token_required' })), 'AUTH V2 user access token'],
    [new SimklApiError('x', 400, JSON.stringify({ error: 'rate_limit' })), 'retry in about a minute'],
    [new SimklApiError('x', 403, JSON.stringify({ error: 'max_lists' })), 'plan limit'],
    [new SimklApiError('x', 404, JSON.stringify({ error: 'url_failed' })), 'not found'],
    [new SimklApiError('x', 429, JSON.stringify({ error: 'user_limit_exceeded' }), { retryAfter: '120' }), 'daily allowance'],
    [new SimklApiError('x', 502, null, {}, true), 'may have been applied'],
    [new SimklApiError('x', 0, null, {}, true), 'not retried automatically'],
    [new CustomListCooldownError(30), 'about 30 more seconds'],
  ] as const)('maps write failures clearly (%#)', async (error, expected) => {
    const result = customListErrorResult(error, true);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(expected);
  });
});

describe('Custom Lists contract', () => {
  const spec = JSON.parse(readFileSync('api/simkl-openapi.json', 'utf8'));
  const schemas = spec.components.schemas;

  test('all nine documented list routes exist in the codegen spec and are the only allowed routes', () => {
    const routes: Array<[string, 'get' | 'post' | 'delete', string]> = [
      ['/lists/user/{userId}', 'get', '/lists/user/1'],
      ['/lists/{id}', 'get', '/lists/1'],
      ['/lists', 'post', '/lists'],
      ['/lists/{id}', 'post', '/lists/1'],
      ['/lists/{id}', 'delete', '/lists/1'],
      ['/lists/{id}/items', 'post', '/lists/1/items'],
      ['/lists/{id}/items/remove', 'post', '/lists/1/items/remove'],
      ['/lists/favorites', 'post', '/lists/favorites'],
      ['/lists/favorites/remove', 'post', '/lists/favorites/remove'],
    ];
    for (const [template, method, concrete] of routes) {
      expect(spec.paths[template]?.[method]).toBeDefined();
      expect(isCustomListRoute(concrete, method.toUpperCase() as 'GET')).toBe(true);
    }
    expect(isCustomListRoute('/lists/1', 'POST')).toBe(true);
    expect(isCustomListRoute('/lists/abc', 'GET')).toBe(false);
    expect(isCustomListRoute('/lists/favorites', 'GET')).toBe(false);
    expect(isCustomListRoute('/sync/history', 'POST')).toBe(false);
  });

  test('tool enums match the OpenAPI schema', () => {
    const userSort = spec.paths['/lists/user/{userId}'].get.parameters.find((param: any) => param.name === 'sort');
    expect([...CUSTOM_LIST_USER_SORTS]).toEqual(userSort.schema.enum);
    expect([...CUSTOM_LIST_PRIVACY]).toEqual(schemas.CustomListWriteRequest.properties.privacy.enum);
    expect([...CUSTOM_LIST_MEDIA_TYPES]).toEqual(schemas.CustomListWriteRequest.properties.media_type.enum);
    expect([...CUSTOM_LIST_PERMISSIONS]).toEqual(schemas.CustomListPermission.enum);
    expect(Object.keys(schemas.CustomListItemsRequest.properties).sort()).toEqual(['anime', 'movies', 'shows']);
  });

  test('write tools request media:write semantics and reads are read-only', () => {
    const { schemas: tools } = fakeService();
    for (const name of ['simkl_get_user_custom_lists', 'simkl_get_custom_list']) {
      expect(tools.get(name).annotations.readOnlyHint).toBe(true);
    }
    for (const name of ['simkl_create_custom_list', 'simkl_update_custom_list', 'simkl_delete_custom_list',
      'simkl_add_custom_list_items', 'simkl_remove_custom_list_items', 'simkl_add_favorites', 'simkl_remove_favorites']) {
      expect(tools.get(name).description).toContain('media:write');
      expect(tools.get(name).annotations.readOnlyHint).toBeUndefined();
    }
  });
});

describe('Custom Lists account queue and quota', () => {
  const env = { SIMKL_CLIENT_ID: 'app', SIMKL_API_BASE_URL: 'https://api.simkl.com', SIMKL_LIBRARY_CACHE_TTL_SECONDS: '300' };
  const object = (storage: DurableObjectStorage) => {
    const instance = new SimklLibraryCache({ storage } as DurableObjectState, env as any);
    (instance as any).env = env;
    return instance;
  };

  test('writes for one account run one at a time and are never replayed', async () => {
    const storage = sqliteStorage();
    const cache = object(storage.storage);
    const events: string[] = [];
    const releases: Array<() => void> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const name = JSON.parse(String(init?.body)).name;
      events.push(`start:${name}`);
      await new Promise<void>(resolve => releases.push(resolve));
      events.push(`end:${name}`);
      return Response.json({ code: 400, error: 'rate_limit' }, { status: name === 'b' ? 400 : 201 });
    }) as typeof fetch;
    const a = cache.customListRequest('token', '/lists', { method: 'POST', body: { name: 'a', media_type: 'tv' } });
    const b = cache.customListRequest('token', '/lists', { method: 'POST', body: { name: 'b', media_type: 'tv' } });
    while (releases.length < 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(events).toEqual(['start:a']);
    releases.shift()!();
    await a;
    while (releases.length < 1) await Promise.resolve();
    releases.shift()!();
    expect(decodeRpcError(await b.catch(error => error))).toBeInstanceOf(SimklApiError);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('429 user_limit_exceeded pauses list work for the account until Retry-After passes', async () => {
    const storage = sqliteStorage();
    const cache = object(storage.storage);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: 'user_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '600' } });
    }) as typeof fetch;
    const failure = (promise: Promise<unknown>) => promise.then(() => undefined, error => decodeRpcError(error));
    const quota = await failure(cache.customListRequest('token', '/lists/1', { method: 'GET' }));
    expect(quota).toBeInstanceOf(SimklApiError);
    expect((quota as SimklApiError).upstreamCode).toBe('user_limit_exceeded');
    expect(await failure(cache.customListRequest('token', '/lists/1', { method: 'GET' }))).toBeInstanceOf(CustomListCooldownError);
    expect(await failure(object(storage.storage).customListRequest('token', '/lists/1/items', { method: 'POST', body: { movies: [] } })))
      .toBeInstanceOf(CustomListCooldownError);
    expect(calls).toBe(1);
    expect(JSON.stringify(storage.db.query('SELECT * FROM library_metadata').all())).not.toContain('token');

    storage.db.query("UPDATE library_metadata SET value_json = ? WHERE key = 'custom-lists-cooldown'").run(JSON.stringify({ until: Date.now() - 1 }));
    globalThis.fetch = (async () => { calls++; return Response.json({ id: 1, items: [] }); }) as typeof fetch;
    await expect(cache.customListRequest('token', '/lists/1', { method: 'GET' })).resolves.toMatchObject({ data: { id: 1 } });
    expect(calls).toBe(2);
  });

  test('refuses routes outside the documented Custom Lists API', async () => {
    const cache = object(sqliteStorage().storage);
    await expect(cache.customListRequest('token', '/sync/history', { method: 'POST' })).rejects.toThrow(/Unsupported/);
  });

  test('Retry-After parsing falls back to the daily reset and stays bounded', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(customListCooldownSeconds('120', now)).toBe(120);
    expect(customListCooldownSeconds(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    // 07:00 in New York: 17 hours until midnight.
    expect(customListCooldownSeconds(undefined, now)).toBe(17 * 3600);
    expect(customListCooldownSeconds('999999999', now)).toBe(36 * 3600);
  });
});

describe('Custom Lists adapter', () => {
  test('a known read-only AUTH V2 grant is refused locally before any request', async () => {
    let touched = false;
    const namespace = { idFromName() { touched = true; return 'id'; }, get() { touched = true; return {}; } } as any;
    const adapter = createLibraryAdapter({ SIMKL_LIBRARY_CACHE: namespace }, {} as any,
      () => ({ simklToken: 'token', simklUserId: '7', simklScope: 'media:read' }));
    await expect(adapter.customListRequest('/lists', { method: 'POST', body: {} })).rejects.toThrow(/media:write/);
    expect(touched).toBe(false);
  });

  test.each([
    ['media:read media:write', true],
    ['media:read,media:write', true],
    ['media:read', false],
    ['public', true],
    [undefined, true],
  ] as const)('scope %p allows writes: %p', (scope, allowed) => {
    expect(hasMediaWriteScope(scope)).toBe(allowed);
  });

  test('errors survive the Workers RPC boundary, which keeps only "<name>: <message>"', async () => {
    const rpc = (error: Error) => new Error(`${error.name}: ${error.message}`);
    const notFound = decodeRpcError(rpc(encodeRpcError(new SimklApiError('x', 404, JSON.stringify({ error: 'url_failed' }), { retryAfter: '5' })) as Error));
    expect(notFound).toBeInstanceOf(SimklApiError);
    expect(customListErrorResult(notFound, false).content[0].text).toBe('Simkl list not found.');
    const ambiguous = decodeRpcError(rpc(encodeRpcError(new SimklApiError('x', 502, null, {}, true)) as Error)) as SimklApiError;
    expect(ambiguous.writeMayHaveSucceeded).toBe(true);
    const remote = rpc(encodeRpcError(new CustomListCooldownError(42)) as Error);
    const namespace = { idFromName: () => 'id', get: () => ({ customListRequest: async () => { throw remote; } }) } as any;
    const adapter = createLibraryAdapter({ SIMKL_LIBRARY_CACHE: namespace }, {} as any, () => ({ simklToken: 'token', simklUserId: '7' }));
    const error = await adapter.customListRequest('/lists/1', { method: 'GET' }).catch(caught => caught);
    expect(error).toBeInstanceOf(CustomListCooldownError);
    expect(error.retryAfterSeconds).toBe(42);
  });

  test('missing token gives a clear AUTH V2 error without contacting Simkl', async () => {
    const { calls, handlers } = fakeService();
    const adapter = createLibraryAdapter({ SIMKL_LIBRARY_CACHE: {} as any }, {} as any, () => undefined);
    const service = new CustomListsService((path, options) => adapter.customListRequest(path, options), () => adapter.accountId());
    const tools = new Map<string, (args: any) => Promise<any>>();
    registerCustomListTools({ registerTool(name: string, _: unknown, handler: any) { tools.set(name, handler); } } as any, service);
    const result = await tools.get('simkl_get_user_custom_lists')!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires an AUTH V2 user access token');
    expect(calls).toHaveLength(0);
    expect(handlers.size).toBe(9);
  });
});
