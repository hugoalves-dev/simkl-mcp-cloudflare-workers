import { afterEach, expect, mock, test } from 'bun:test';
import { sqliteStorage } from './helpers/library-storage';

mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, exports: {}, env: {} }));
const { SimklLibraryCache } = await import('../src/library/cache');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = { SIMKL_CLIENT_ID: 'app', SIMKL_API_BASE_URL: 'https://api.simkl.com', SIMKL_LIBRARY_CACHE_TTL_SECONDS: '300' };
const cache = (storage: DurableObjectStorage) => {
  const object = new SimklLibraryCache({ storage } as DurableObjectState, env as any);
  (object as any).env = env;
  return object;
};
function upstream(onCall: (path: string, token: string) => Promise<void> | void = () => {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    await onCall(path, new Headers(init?.headers).get('Authorization') ?? '');
    return Response.json(path === '/sync/activities' ? { all: '2026-10-09T12:00:00Z' } : { [path.split('/')[3]]: [] });
  }) as typeof fetch;
  return calls;
}

test('object owns/coalesces complete API sequence and persists no credentials', async () => {
  const adapter = sqliteStorage();
  const object = cache(adapter.storage);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls = upstream(async path => {
    expect(adapter.isInTransaction()).toBe(false);
    if (path === '/sync/activities') await gate;
  });
  expect(calls).toEqual([]);
  const a = object.ensureInitialized('session-a-secret');
  const b = object.ensureInitialized('session-b-secret');
  expect(calls).toEqual(['/sync/activities']);
  release();
  expect(await a).toEqual({ initialized: true, itemCount: 0 });
  expect(await b).toEqual(await a);
  expect(calls).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
  await object.ensureInitialized('session-c-secret');
  const reconstructed = cache(adapter.storage);
  await reconstructed.ensureInitialized('session-d-secret');
  expect(calls).toHaveLength(4);
  const persisted = JSON.stringify(adapter.db.query('SELECT * FROM library_metadata').all()) + JSON.stringify(adapter.db.query('SELECT * FROM library_items').all());
  expect(persisted).not.toContain('secret');
  for (const value of Object.values(object)) expect(value).not.toBe('session-a-secret');
  expect(await reconstructed.readItems()).toEqual([]);
  adapter.db.close();
});

test('independent objects initialize independently', async () => {
  const a = sqliteStorage(); const b = sqliteStorage();
  const calls = upstream();
  await Promise.all([cache(a.storage).ensureInitialized('a'), cache(b.storage).ensureInitialized('b')]);
  expect(calls).toHaveLength(8);
  a.db.close(); b.db.close();
});

test('initialization, queued write, and stats reads preserve per-account order', async () => {
  const adapter = sqliteStorage(); const object = cache(adapter.storage);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/sync/activities' && calls.length === 1) await gate;
    if (path === '/sync/activities') return Response.json({ all: '2026-10-09T12:00:00Z', settings: { all: '2026-10-09T12:00:00Z' } });
    if (path === '/users/settings') return Response.json({ account: { id: 42 } });
    if (path === '/users/42/stats') return Response.json({ total_mins: 20 });
    if (path === '/sync/history') return Response.json({ added: {} });
    return Response.json({ [path.split('/')[3]]: [] });
  }) as typeof fetch;
  const initialization = object.ensureInitialized('token');
  const write = object.write('token', '/sync/history', { method: 'POST', body: {} });
  const stats = object.getStats('token', '42');
  expect(calls).toEqual(['/sync/activities']);
  release();
  await Promise.all([initialization, write, stats]);
  expect(calls).toEqual([
    '/sync/activities', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime',
    '/sync/history', '/sync/activities', '/users/settings', '/users/42/stats',
  ]);
  adapter.db.close();
});

test('partial failure leaves no snapshot and rejected coordination permits retry with a new token', async () => {
  const adapter = sqliteStorage(); const object = cache(adapter.storage);
  await expect(object.readItems()).rejects.toThrow('Library cache is not initialized');
  const calls = upstream((path, token) => { if (path === '/sync/all-items/movies' && token === 'Bearer expired') throw new Error('failed'); });
  const failures = await Promise.allSettled([object.ensureInitialized('expired'), object.ensureInitialized('other')]);
  expect(failures.every(r => r.status === 'rejected')).toBe(true);
  expect(adapter.db.query("SELECT * FROM library_metadata WHERE key='completion'").all()).toEqual([]);
  expect(adapter.db.query('SELECT * FROM library_items').all()).toEqual([]);
  expect(calls).toHaveLength(3);
  await object.ensureInitialized('fresh');
  expect(calls).toHaveLength(7);
  adapter.db.close();
});
