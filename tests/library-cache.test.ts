import { afterEach, expect, mock, test } from 'bun:test';
import { sqliteStorage } from './helpers/library-storage';
import { LibraryStore } from '../src/library/store';

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

test('empty account reads persist null activities across object reconstruction without media pulls', async () => {
  const adapter = sqliteStorage();
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    calls.push(new URL(String(input)).pathname);
    return Response.json({ all: null });
  }) as typeof fetch;
  try {
    const object = cache(adapter.storage);
    expect(await object.read('token')).toEqual({ shows: [], movies: [], anime: [] });
    expect(await object.ensureInitialized('token')).toEqual({ initialized: true, itemCount: 0 });
    expect(await object.read('token')).toEqual({ shows: [], movies: [], anime: [] });
    const reconstructed = cache(adapter.storage);
    expect(await reconstructed.read('token')).toEqual({ shows: [], movies: [], anime: [] });
    expect(await reconstructed.readItems()).toEqual([]);
    expect(calls).toEqual(['/sync/activities']);
    expect(await reconstructed.read('token', true)).toEqual({ shows: [], movies: [], anime: [] });
    expect(calls).toEqual(['/sync/activities', '/sync/activities']);
  } finally { adapter.db.close(); }
});

test('issue #44: simultaneous and restarted manual refreshes obey a per-account minute window', async () => {
  const firstStorage = sqliteStorage(), secondStorage = sqliteStorage();
  try {
    const first = cache(firstStorage.storage), second = cache(secondStorage.storage);
    const calls = upstream();
    await first.ensureInitialized('account-a');
    await second.ensureInitialized('account-b');
    expect(calls.filter(path => path === '/sync/activities')).toHaveLength(2);

    const results = await Promise.all([
      first.refreshLibrary('account-a'),
      first.refreshLibrary('another-session-same-account'),
      first.refreshLibrary('yet-another-session'),
    ]);
    expect(results[0]).toEqual({ status: 'refreshed' });
    expect(results[1].status).toBe('suppressed');
    expect(results[2].status).toBe('suppressed');
    expect(results[1].retryAfterSeconds).toBeGreaterThan(0);
    expect(calls.filter(path => path === '/sync/activities')).toHaveLength(3);

    const afterRestart = cache(firstStorage.storage);
    expect((await afterRestart.refreshLibrary('account-a')).status).toBe('suppressed');
    expect(calls.filter(path => path === '/sync/activities')).toHaveLength(3);
    expect(await second.refreshLibrary('account-b')).toEqual({ status: 'refreshed' });
    expect(calls.filter(path => path === '/sync/activities')).toHaveLength(4);

    // Manual cooldown cannot swallow mandatory freshness after an upstream write.
    await afterRestart.write('account-a', '/sync/history', { method: 'POST', body: {} });
    const beforeCheck = calls.filter(path => path === '/sync/activities').length;
    expect((await afterRestart.refreshLibrary('account-a')).status).toBe('suppressed');
    expect(calls.filter(path => path === '/sync/activities')).toHaveLength(beforeCheck + 1);
    expect(new LibraryStore(firstStorage.storage).loadSnapshot()?.forceCheck).toBe(false);

    // 60 seconds is a hard boundary, but only one metadata row is updated.
    firstStorage.db.query("UPDATE library_metadata SET value_json=? WHERE key='manual-refresh-at'")
      .run(JSON.stringify(Date.now() - 60_001));
    const rowsBefore = new LibraryStore(firstStorage.storage).readItems();
    expect(await afterRestart.refreshLibrary('account-a')).toEqual({ status: 'refreshed' });
    expect(new LibraryStore(firstStorage.storage).readItems()).toEqual(rowsBefore);
    const persisted = JSON.stringify(firstStorage.db.query('SELECT * FROM library_metadata').all());
    expect(persisted).not.toContain('account-a');
    expect(persisted).not.toContain('another-session');
  } finally {
    firstStorage.db.close(); secondStorage.db.close();
  }
});

test('issue #44: failed manual refresh occupies its slot but does not force repeated upstream retries', async () => {
  const data = sqliteStorage();
  try {
    const object = cache(data.storage);
    upstream();
    await object.ensureInitialized('token');
    let checks = 0;
    globalThis.fetch = (async () => {
      checks++;
      throw new Error('upstream unavailable');
    }) as typeof fetch;
    await expect(object.refreshLibrary('token')).rejects.toThrow('upstream unavailable');
    expect(checks).toBe(1);
    expect(new LibraryStore(data.storage).loadSnapshot()?.forceCheck).toBe(false);
    expect((await cache(data.storage).refreshLibrary('token')).status).toBe('suppressed');
    await cache(data.storage).read('token');
    expect(checks).toBe(1);
  } finally { data.db.close(); }
});
