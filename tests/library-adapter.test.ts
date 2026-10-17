import { afterEach, expect, test } from 'bun:test';
import { SimklApiError, SimklClient } from '../src/api/client';
import { createLibraryAdapter } from '../src/library/adapter';
const original = globalThis.fetch; afterEach(() => { globalThis.fetch = original; });
const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'id' });
function setup(props: any) {
  const names: string[] = [], reads: any[] = [], invalidations: string[] = [], stats: any[] = [], writes: any[] = [], settingsReads: any[] = [], settingsInvalidations: any[] = [];
  const env = { SIMKL_LIBRARY_CACHE: { idFromName(name: string) { names.push(name); return name; }, get(name: string) { return { async read(token: string, force?: boolean) { reads.push({ name, token, force }); return { shows: [], movies: [], anime: [] }; }, async getStats(token: string, userId: string) { stats.push({ name, token, userId }); return { total_mins: 20 }; }, async getSettings(token: string) { settingsReads.push({ name, token }); return { account: { type: 'pro' } }; }, async invalidateSettings(token: string) { settingsInvalidations.push({ name, token }); }, async invalidate() { invalidations.push(name); }, async write(token: string, path: string, options: any) { writes.push({ name, token, path, options }); return { ok: true }; } }; } } };
  return { adapter: createLibraryAdapter(env as any, client, () => props), names, reads, invalidations, stats, writes, settingsReads, settingsInvalidations };
}
test('verified props route without settings and force is forwarded', async () => {
  globalThis.fetch = (async () => { throw new Error('unexpected'); }) as typeof fetch;
  const s = setup({ simklToken: 'token', simklUserId: '42' }); await s.adapter.read(true); await s.adapter.invalidate();
  expect(s.names).toEqual(['simkl-library:v1:42', 'simkl-library:v1:42']); expect(s.reads[0].force).toBe(true); expect(s.invalidations).toEqual(['simkl-library:v1:42']);
});
test('stats route through the verified account cache and preserve canonical decimal IDs', async () => {
  globalThis.fetch = (async () => { throw new Error('unexpected'); }) as typeof fetch;
  const s = setup({ simklToken: 'token', simklUserId: '9007199254740993' });
  expect(await s.adapter.getStats()).toEqual({ total_mins: 20 });
  expect(s.stats).toEqual([{ name: 'simkl-library:v1:9007199254740993', token: 'token', userId: '9007199254740993' }]);
});
test('legacy account verifies settings and memoizes within token identity', async () => {
  let calls = 0; globalThis.fetch = (async () => { calls++; return Response.json({ account: { id: 42 } }); }) as typeof fetch;
  const props = { simklToken: 'token' }; const s = setup(props); await s.adapter.read(); await s.adapter.read(); expect(calls).toBe(1);
  props.simklToken = 'different'; await s.adapter.read(); expect(calls).toBe(2);
});
test('different accounts isolate objects; sessions share verified account', async () => {
  const a = setup({ simklToken: 'one', simklUserId: '42' }), b = setup({ simklToken: 'two', simklUserId: '42' }), c = setup({ simklToken: 'three', simklUserId: '43' });
  await Promise.all([a.adapter.read(), b.adapter.read(), c.adapter.read()]); expect(a.names).toEqual(b.names); expect(c.names).not.toEqual(a.names);
});
test('queued writer routes through the verified account object with operation-local token', async () => {
  const s = setup({ simklToken: 'write-token', simklUserId: '42' });
  await expect(s.adapter.write('/sync/history', { method: 'POST', body: { movies: [{ ids: { simkl: 1 } }] } })).resolves.toEqual({ ok: true });
  expect(s.writes).toEqual([{ name: 'simkl-library:v1:42', token: 'write-token', path: '/sync/history', options: { method: 'POST', body: { movies: [{ ids: { simkl: 1 } }] } } }]);
});
test('rejects a stale rewatch token rather than queueing it under a changed account', async () => {
  const props = { simklToken: 'new-token', simklUserId: '43' }, s = setup(props);
  await expect(s.adapter.write('/sync/history', { method: 'POST', body: {} }, 'old-token')).rejects.toThrow(/token changed/);
  expect(s.writes).toEqual([]);
});
for (const id of [undefined, null, 0, -1, 'simkl_user_uuid', 'x', 1.5]) test('failed legacy verification does not access cache '+String(id), async () => {
  globalThis.fetch = (async () => Response.json({ account: { id } })) as typeof fetch;
  const s = setup({ simklToken: 'token' }); await expect(s.adapter.read()).rejects.toThrow(); expect(s.names).toEqual([]);
});
test('missing token and revoked legacy token cannot access cache', async () => {
  const missing = setup({ simklToken: '', simklUserId: '42' }); await expect(missing.adapter.read()).rejects.toThrow(); expect(missing.names).toEqual([]);
  globalThis.fetch = (async () => new Response('revoked', { status: 401 })) as typeof fetch;
  const revoked = setup({ simklToken: 'old' }); await expect(revoked.adapter.read()).rejects.toThrow(); expect(revoked.names).toEqual([]);
});
test('restores safe API quota metadata from a Worker RPC error without exposing its message', async () => {
  const { SimklApiError } = await import('../src/api/client');
  const rpcError = Object.assign(new Error('remote upstream sensitive message'), { name: 'SimklApiError', statusCode: 429, upstreamCode: 'user_limit_exceeded', headers: { retryAfter: '3600', rateLimitRemaining: '0' } });
  const env = { SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async read() { throw rpcError; } }) } };
  const adapter = createLibraryAdapter(env as any, client, () => ({ simklToken: 'token', simklUserId: '42' }));
  const error = await adapter.read().catch(error => error);
  expect(error).toBeInstanceOf(SimklApiError); expect(error.upstreamCode).toBe('user_limit_exceeded'); expect(error.headers.retryAfter).toBe('3600'); expect(error.message).not.toContain('sensitive');
});
test('restores sanitized API errors returned by cached stats operations', async () => {
  const { SimklApiError } = await import('../src/api/client');
  const rpcError = Object.assign(new Error('remote upstream sensitive message'), { name: 'SimklApiError', statusCode: 429, upstreamCode: 'user_limit_exceeded', headers: { retryAfter: '3600' } });
  const env = { SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async getStats() { throw rpcError; } }) } };
  const adapter = createLibraryAdapter(env as any, client, () => ({ simklToken: 'token', simklUserId: '42' }));
  const error = await adapter.getStats().catch(error => error);
  expect(error).toBeInstanceOf(SimklApiError); expect(error.upstreamCode).toBe('user_limit_exceeded'); expect(error.headers.retryAfter).toBe('3600'); expect(error.message).not.toContain('sensitive');
});

test('restores mutation cache invalidation failure across Worker RPC', async () => {
  const rpcError = Object.assign(new Error('sanitized'), { name: 'LibraryWriteInvalidationError' });
  const env = { SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async write() { throw rpcError; } }) } };
  const adapter = createLibraryAdapter(env as any, client, () => ({ simklToken: 'token', simklUserId: '42' }));
  await expect(adapter.write('/sync/history', { method: 'POST', body: {} })).rejects.toThrow('Upstream write succeeded, but library cache invalidation failed');
});

test('restores Simkl quota errors from a queued write across Worker RPC', async () => {
  const rpcError = Object.assign(new Error('sensitive upstream message'), { name: 'SimklApiError', statusCode: 429, upstreamCode: 'user_limit_exceeded', headers: { retryAfter: '3600' } });
  const env = { SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async write() { throw rpcError; } }) } };
  const adapter = createLibraryAdapter(env as any, client, () => ({ simklToken: 'token', simklUserId: '42' }));
  const error = await adapter.write('/sync/history', { method: 'POST', body: {} }).catch(error => error);
  expect(error).toBeInstanceOf(SimklApiError); expect(error.upstreamCode).toBe('user_limit_exceeded'); expect(error.headers.retryAfter).toBe('3600'); expect(error.message).not.toContain('sensitive');
});

test('settings reads and invalidations route through one verified per-account object', async () => {
  const a = setup({ simklToken: 'token-a', simklUserId: '42' });
  const b = setup({ simklToken: 'token-b', simklUserId: '42' });
  expect(await a.adapter.getSettings('token-a')).toEqual({ account: { type: 'pro' } });
  expect(await b.adapter.getSettings('token-b')).toEqual({ account: { type: 'pro' } });
  await a.adapter.invalidateSettings('token-a');
  expect(a.settingsReads).toEqual([{ name: 'simkl-library:v1:42', token: 'token-a' }]);
  expect(b.settingsReads).toEqual([{ name: 'simkl-library:v1:42', token: 'token-b' }]);
  expect(a.settingsInvalidations).toEqual([{ name: 'simkl-library:v1:42', token: 'token-a' }]);
});

test('settings eligibility rejects stale tokens before contacting another account object', async () => {
  const props = { simklToken: 'old-token', simklUserId: '42' };
  const s = setup(props);
  props.simklToken = 'new-token';
  props.simklUserId = '43';
  await expect(s.adapter.getSettings('old-token')).rejects.toThrow(/token changed/);
  await expect(s.adapter.invalidateSettings('old-token')).rejects.toThrow(/token changed/);
  expect(s.settingsReads).toHaveLength(0);
  expect(s.settingsInvalidations).toHaveLength(0);
});

test('sanitizes upstream API errors when reading shared settings over Worker RPC', async () => {
  const rpcError = Object.assign(new Error('sensitive upstream response'), {
    name: 'SimklApiError', statusCode: 429, upstreamCode: 'user_limit_exceeded',
    headers: { retryAfter: '3600' },
  });
  const env = { SIMKL_LIBRARY_CACHE: { idFromName: (id: string) => id, get: () => ({ async getSettings() { throw rpcError; } }) } };
  const adapter = createLibraryAdapter(env as any, client, () => ({ simklToken: 'token', simklUserId: '42' }));
  const error = await adapter.getSettings().catch(error => error);
  expect(error).toBeInstanceOf(SimklApiError);
  expect(error.upstreamCode).toBe('user_limit_exceeded');
  expect(error.message).not.toContain('sensitive');
});
