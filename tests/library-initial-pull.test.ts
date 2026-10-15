import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { fetchInitialLibrary } from '../src/library/sync';
import { MEDIA_TYPES, STATUSES_BY_MEDIA } from '../src/library/types';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const client = () => new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
const activities = { all: '2026-10-01T00:00:00Z' };

test('initial pull reads each complete media response once without page or limit', async () => {
  const calls: URL[] = [];
  const shows = Array.from({ length: 101 }, (_, id) => ({ status: 'watching', show: { ids: { simkl: id + 1 } } }));
  globalThis.fetch = (async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === '/sync/activities') return Response.json(activities);
    return Response.json(url.pathname.endsWith('/shows') ? { shows } : {});
  }) as typeof fetch;
  const result = await fetchInitialLibrary(client(), 'token');
  expect(result.items).toHaveLength(101);
  expect(calls.map(url => url.pathname)).toEqual(['/sync/activities', ...MEDIA_TYPES.map(type => `/sync/all-items/${type}`)]);
  for (const url of calls) {
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  }
});

test('max_items falls back to one sequential request per supported media status', async () => {
  const calls: URL[] = [];
  let active = 0, peak = 0;
  globalThis.fetch = (async input => {
    const url = new URL(String(input)); calls.push(url);
    active++; peak = Math.max(peak, active);
    try {
      await Promise.resolve();
      if (url.pathname === '/sync/activities') return Response.json(activities);
      const [, , , media, status] = url.pathname.split('/');
      if (!status) return Response.json({ error: 'max_items' }, { status: 400 });
      const statuses = STATUSES_BY_MEDIA[media as keyof typeof STATUSES_BY_MEDIA];
      return Response.json({ [media]: [{ status, [media === 'movies' ? 'movie' : 'show']: { ids: { simkl: statuses.indexOf(status) + 1 } } }] });
    } finally { active--; }
  }) as typeof fetch;
  const result = await fetchInitialLibrary(client(), 'token');
  expect(result.items).toHaveLength(MEDIA_TYPES.reduce((sum, type) => sum + STATUSES_BY_MEDIA[type].length, 0));
  expect(calls.map(url => url.pathname)).toEqual(['/sync/activities', ...MEDIA_TYPES.flatMap(type => [
    `/sync/all-items/${type}`, ...STATUSES_BY_MEDIA[type].map(status => `/sync/all-items/${type}/${status}`),
  ])]);
  expect(peak).toBe(1);
  for (const url of calls) {
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  }
});
