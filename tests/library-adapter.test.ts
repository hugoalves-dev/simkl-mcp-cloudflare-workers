import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { createLibraryAdapter } from '../src/library/adapter';
const original = globalThis.fetch; afterEach(() => { globalThis.fetch = original; });
const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'id' });
function setup(props: any) {
  const names: string[] = [], reads: any[] = [], invalidations: string[] = [];
  const stats: any[] = [];
  const env = { SIMKL_LIBRARY_CACHE: { idFromName(name: string) { names.push(name); return name; }, get(name: string) { return { async read(token: string, force?: boolean) { reads.push({ name, token, force }); return { shows: [], movies: [], anime: [] }; }, async getStats(token: string, userId: string) { stats.push({ name, token, userId }); return { total_mins: 20 }; }, async invalidate() { invalidations.push(name); } }; } } };
  return { adapter: createLibraryAdapter(env as any, client, () => props), names, reads, invalidations, stats };
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
