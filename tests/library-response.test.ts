import { afterEach, expect, test } from 'bun:test';
import { SimklApiError, SimklClient } from '../src/api/client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const DEFAULT = 2 * 1024 * 1024;
const LIBRARY = 16 * 1024 * 1024;
const client = () => new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
const body = (bytes: number) => JSON.stringify('x'.repeat(bytes - 2));
function respond(text: string, status = 200) {
  globalThis.fetch = (async () => new Response(text, { status })) as typeof fetch;
}

test('recognizes max_items without retaining upstream bodies', () => {
  const error = new SimklApiError('error', 400, '{"error":"max_items","token":"secret"}');
  expect(error.upstreamCode).toBe('max_items');
  expect(JSON.stringify(error)).not.toContain('secret');
  expect(new SimklApiError('error', 400, '{"error":"different"}').upstreamCode).toBe('');
});

test('accepts >2MiB and exactly 16MiB only for successful library GET profile', async () => {
  for (const bytes of [DEFAULT + 1, LIBRARY]) {
    respond(body(bytes));
    const result = await client().request<string>('/sync/all-items/shows', { method: 'GET', responseProfile: 'library' });
    expect(result.length).toBe(bytes - 2);
  }
  respond(body(DEFAULT + 1));
  await expect(client().request('/sync/all-items/shows', { method: 'GET' })).rejects.toThrow('response too large');
  respond(body(LIBRARY + 1));
  await expect(client().request('/sync/all-items/shows', { method: 'GET', responseProfile: 'library' })).rejects.toThrow('response too large');
});

test('keeps unrelated, absolute, POST and error responses at 2MiB', async () => {
  for (const [path, method, status] of [
    ['/users/settings', 'GET', 200], ['/sync/activities', 'GET', 200],
    ['/sync/ratings', 'POST', 200], ['/sync/all-items/shows/invalid', 'GET', 200],
    ['https://api.simkl.com/sync/all-items/shows', 'GET', 200],
    ['//api.simkl.com/sync/all-items/shows', 'GET', 200],
    ['/sync/all-items/shows', 'POST', 200], ['/sync/all-items/shows', 'GET', 400],
  ] as const) {
    respond(body(DEFAULT + 1), status);
    await expect(client().request(path, { method, responseProfile: 'library' })).rejects.toThrow('response too large');
  }
});

test('allowlists every media/status variant', async () => {
  for (const media of ['shows', 'movies', 'anime']) for (const status of ['', '/watching', '/plantowatch', '/hold', '/completed', '/dropped']) {
    respond(body(DEFAULT + 1));
    await client().request(`/sync/all-items/${media}${status}`, { method: 'GET', responseProfile: 'library' });
  }
});

test('counts streamed UTF-8 bytes, ignores Content-Length, and cancels overflow', async () => {
  let cancelled = false;
  let reads = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(new TextEncoder().encode('"' + 'é'.repeat(DEFAULT / 2)));
      else controller.enqueue(new TextEncoder().encode('"'));
    }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Length': '1' } })) as typeof fetch;
  await expect(client().request('/users/settings', { method: 'GET' })).rejects.toThrow('response too large');
  expect(cancelled).toBe(true);
});

test('accepts exact default byte limit and measures fallback in UTF-8 bytes', async () => {
  respond(body(DEFAULT));
  expect((await client().request<string>('/users/settings', { method: 'GET' })).length).toBe(DEFAULT - 2);
  globalThis.fetch = (async () => ({ status: 200, ok: true, headers: new Headers(), body: null,
    text: async () => JSON.stringify('é'.repeat(DEFAULT / 2)),
  }) as Response) as typeof fetch;
  await expect(client().request('/users/settings', { method: 'GET' })).rejects.toThrow('response too large');
});


test('all-types library and ratings deltas retain bounded large-response support', async () => {
  for (const path of ['/sync/all-items', '/sync/ratings']) {
    respond(body(DEFAULT + 1));
    expect((await client().request<string>(path, { method: 'GET', responseProfile: 'library' })).length).toBe(DEFAULT - 1);
    respond(body(LIBRARY + 1));
    await expect(client().request(path, { method: 'GET', responseProfile: 'library' })).rejects.toThrow('response too large');
  }
});
