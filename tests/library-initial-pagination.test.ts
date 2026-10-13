import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { fetchInitialLibrary } from '../src/library/sync';
const original = globalThis.fetch; afterEach(() => { globalThis.fetch = original; });
const client = () => new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
function fixture(incomplete = false) {
  const calls: URL[] = [];
  globalThis.fetch = (async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === '/sync/activities') return Response.json({ all: '2026-10-01T00:00:00Z' });
    if (url.pathname.endsWith('/shows')) {
      const page = Number(url.searchParams.get('page') || 1);
      const headers: Record<string, string> = { 'X-Pagination-Page': String(page), 'X-Pagination-Limit': '100', 'X-Pagination-Page-Count': '2' };
      if (!incomplete) headers['X-Pagination-Item-Count'] = '2';
      return Response.json({ shows: [{ status: 'watching', show: { ids: { simkl: page } } }] }, { headers });
    }
    return Response.json({});
  }) as typeof fetch;
  return calls;
}
test('initial foundation pull also retrieves every advertised page before completion', async () => {
  const calls = fixture(); const result = await fetchInitialLibrary(client(), 'token');
  expect(result.items).toHaveLength(2); expect(calls.filter(url => url.pathname.endsWith('/shows')).map(url => url.searchParams.get('page'))).toEqual(['1', '2']);
});
test('partial first-page pagination prevents initialization instead of truncating it', async () => {
  fixture(true); await expect(fetchInitialLibrary(client(), 'token')).rejects.toThrow();
});
