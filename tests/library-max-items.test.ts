import { expect, test } from 'bun:test';
import { SimklApiError, SimklClient } from '../src/api/client';
import { toMcpErrorResult } from '../src/api/errors';
import { LibrarySyncLimitError } from '../src/library/errors';
import { fetchPartitionedLibrary } from '../src/library/partitions';
import { refreshLibrary } from '../src/library/refresh';
import { fetchInitialLibrary } from '../src/library/sync';
import type { LibraryItems, LibrarySnapshot } from '../src/library/types';

const oldDate = '2026-10-01T00:00:00Z';
const newDate = '2026-10-02T00:00:00Z';
const maxItems = () => new SimklApiError('upstream rejected response', 400, '{"error":"max_items","code":400}');
const show = (id: number, status = 'completed', rating: number | null = 8) =>
  ({ status, show: { title: 'Show', ids: { simkl: id } }, user_rating: rating });
const movie = (id: number, status = 'completed') =>
  ({ status, movie: { title: 'Movie', ids: { simkl: id } } });
const anime = (id: number, status = 'completed') =>
  ({ status, show: { title: 'Anime', ids: { simkl: id } } });
const empty = (): LibraryItems => ({ shows: [], movies: [], anime: [] });
const previous = (): LibrarySnapshot => ({
  version: 1,
  activities: { all: oldDate, tv_shows: { completed: oldDate, rated_at: oldDate, removed_from_list: oldDate } },
  items: { ...empty(), shows: [show(1, 'watching'), show(3)] },
  checkedAt: 0, forceCheck: false,
});
const opts = { ttlSeconds: 300, now: 300_000 };

function setup(handler: (path: string, query?: Record<string, string | number | undefined>) => unknown | Promise<unknown>) {
  const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
  const calls: Array<{ path: string; query?: Record<string, string | number | undefined>; responseProfile?: string }> = [];
  let active = 0, maxActive = 0;
  client.request = async (path, options) => {
    calls.push({ path, query: options.query, responseProfile: options.responseProfile });
    active++;
    maxActive = Math.max(maxActive, active);
    try { await Promise.resolve(); return await handler(path, options.query) as any; }
    finally { active--; }
  };
  return { client, calls, peak: () => maxActive };
}

function activities(bucket: 'completed' | 'rated_at' | 'removed_from_list' = 'completed') {
  return { all: newDate, tv_shows: { completed: bucket === 'completed' ? newDate : oldDate, rated_at: bucket === 'rated_at' ? newDate : oldDate, removed_from_list: bucket === 'removed_from_list' ? newDate : oldDate } };
}

test('incremental happy path issues one bounded request and applies status transition', async () => {
  const s = setup(path => path === '/sync/activities' ? activities() : { shows: [show(1, 'completed')] });
  const result = await refreshLibrary(s.client, 'private-token', previous(), opts);
  expect(result.items.shows.find(row => row.show?.ids.simkl === 1)?.status).toBe('completed');
  expect(result.activities.all).toBe(newDate);
  expect(s.calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items']);
  expect(s.calls[1].query).toEqual({ date_from: oldDate });
  expect(s.calls[1].responseProfile).toBe('library');
});

test('all-type delta max_items falls back to sequential types with original date_from', async () => {
  const s = setup(path => {
    if (path === '/sync/activities') return activities();
    if (path === '/sync/all-items') throw maxItems();
    if (path === '/sync/all-items/shows') return { shows: [show(1, 'completed'), show(2)] };
    if (path === '/sync/all-items/movies') return { movies: [movie(5)] };
    return { anime: [anime(7)] };
  });
  const result = await refreshLibrary(s.client, 'secret-token', previous(), opts);
  expect(result.items.shows.map(x => x.show?.ids.simkl)).toEqual([1, 3, 2]);
  expect(result.items.movies).toEqual([movie(5)]);
  expect(result.items.anime).toEqual([anime(7)]);
  expect(result.activities.all).toBe(newDate);
  expect(s.calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items', '/sync/all-items/shows', '/sync/all-items/movies', '/sync/all-items/anime']);
  expect(s.calls.slice(1).every(c => JSON.stringify(c.query) === JSON.stringify({ date_from: oldDate }))).toBe(true);
  expect(s.peak()).toBe(1);
});

test('nested type max_items uses only valid per-status partitions in order', async () => {
  const s = setup(path => {
    if (path === '/sync/activities') return activities();
    if (path === '/sync/all-items' || path === '/sync/all-items/movies' || path === '/sync/all-items/shows') throw maxItems();
    if (path.startsWith('/sync/all-items/shows/')) return path.endsWith('/completed') ? { shows: [show(1)] } : {};
    if (path.startsWith('/sync/all-items/movies/')) return path.endsWith('/completed') ? { movies: [movie(9)] } : {};
    return {};
  });
  const result = await refreshLibrary(s.client, 'token', previous(), opts);
  expect(result.items.movies).toEqual([movie(9)]);
  expect(s.calls.map(c => c.path)).toEqual([
    '/sync/activities', '/sync/all-items', '/sync/all-items/shows',
    ...['watching', 'plantowatch', 'hold', 'completed', 'dropped'].map(status => `/sync/all-items/shows/${status}`),
    '/sync/all-items/movies',
    ...['plantowatch', 'completed', 'dropped'].map(status => `/sync/all-items/movies/${status}`),
    '/sync/all-items/anime',
  ]);
  expect(s.calls.every(call => !call.query || (call.query.date_from === oldDate && call.query.page === undefined && call.query.limit === undefined))).toBe(true);
  expect(s.peak()).toBe(1);
});

test('anime uses all five supported statuses after confirmed max_items', async () => {
  const s = setup(path => {
    if (path === '/sync/all-items' || path === '/sync/all-items/anime') throw maxItems();
    return {};
  });
  await fetchPartitionedLibrary(s.client, 'token', 'delta', { date_from: oldDate }, value => {
    if (value === null) return empty();
    return { ...empty(), ...(value as object) };
  });
  expect(s.calls.map(c => c.path).slice(-5)).toEqual(
    ['watching', 'plantowatch', 'hold', 'completed', 'dropped'].map(status => `/sync/all-items/anime/${status}`),
  );
});

test('ratings delta falls back by media and retains null rating removals', async () => {
  const s = setup(path => {
    if (path === '/sync/activities') return activities('rated_at');
    if (path === '/sync/ratings') throw maxItems();
    if (path === '/sync/ratings/shows') return { shows: [{ show: { ids: { simkl: 1 } }, user_rating: null }] };
    return {};
  });
  const result = await refreshLibrary(s.client, 'token', previous(), opts);
  expect(result.items.shows[0].user_rating).toBeNull();
  expect(result.items.shows[0].show?.title).toBe('Show');
  expect(s.calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/ratings', '/sync/ratings/shows', '/sync/ratings/movies', '/sync/ratings/anime']);
  expect(s.calls.slice(1).every(c => c.query?.date_from === oldDate)).toBe(true);
});

test('oversized type-specific ratings do not split by rating and leave snapshot unchanged', async () => {
  const before = previous(), saved = structuredClone(before);
  const s = setup(path => {
    if (path === '/sync/activities') return activities('rated_at');
    if (path === '/sync/ratings' || path === '/sync/ratings/shows') throw maxItems();
    throw new Error('must not request rating segment');
  });
  await expect(refreshLibrary(s.client, 'token', before, opts)).rejects.toMatchObject({
    name: 'LibrarySyncLimitError', code: 'SIMKL_SYNC_PARTITION_EXHAUSTED',
    phase: 'incremental', operation: 'ratings', media: 'shows',
  });
  expect(before).toEqual(saved);
  expect(s.calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/ratings', '/sync/ratings/shows']);
});

test('membership retries by type then status, only prunes after complete set', async () => {
  const before = previous();
  const s = setup(path => {
    if (path === '/sync/activities') return activities('removed_from_list');
    if (path === '/sync/all-items' || path === '/sync/all-items/shows') throw maxItems();
    if (path === '/sync/all-items/shows/completed') return { shows: [{ show: { ids: { simkl: 3 } } }] };
    return {};
  });
  const result = await refreshLibrary(s.client, 'token', before, opts);
  expect(result.items.shows.map(x => x.show?.ids.simkl)).toEqual([3]);
  expect(s.calls[1].query).toEqual({ extended: 'simkl_ids_only' });
  expect(s.calls.slice(1).every(c => c.query?.date_from === undefined)).toBe(true);
  expect(s.calls.map(c => c.path)).toContain('/sync/all-items/shows/dropped');
});

test('failed membership status cannot prune and retry uses old watermark', async () => {
  const before = previous(), saved = structuredClone(before);
  let reject = true;
  const s = setup(path => {
    if (path === '/sync/activities') return activities('removed_from_list');
    if (path === '/sync/all-items' || path === '/sync/all-items/shows') throw maxItems();
    if (path === '/sync/all-items/shows/plantowatch' && reject) throw new Error('network failed');
    if (path === '/sync/all-items/shows/completed') return { shows: [{ show: { ids: { simkl: 3 } } }] };
    return {};
  });
  await expect(refreshLibrary(s.client, 'token', before, opts)).rejects.toThrow('network failed');
  expect(before).toEqual(saved);
  reject = false;
  const result = await refreshLibrary(s.client, 'token', before, opts);
  expect(result.items.shows.map(x => x.show?.ids.simkl)).toEqual([3]);
  expect(s.calls.filter(c => c.path === '/sync/activities')).toHaveLength(2);
});

test('individual status max_items yields actionable typed diagnostic, no extra retries', async () => {
  const before = previous(), saved = structuredClone(before);
  const s = setup(path => {
    if (path === '/sync/activities') return activities();
    if (path === '/sync/all-items' || path === '/sync/all-items/shows' || path === '/sync/all-items/shows/watching') throw maxItems();
    return {};
  });
  let thrown: unknown;
  try { await refreshLibrary(s.client, 'token', before, opts); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(LibrarySyncLimitError);
  const diagnostic = thrown as LibrarySyncLimitError;
  expect(diagnostic.phase).toBe('incremental');
  expect(diagnostic.status).toBe('watching');
  expect(diagnostic.code).toBe('SIMKL_SYNC_PARTITION_EXHAUSTED');
  expect(toMcpErrorResult(diagnostic).content[0].text).toContain('support.simkl.com');
  expect(before).toEqual(saved);
  expect(s.calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items', '/sync/all-items/shows', '/sync/all-items/shows/watching']);
});

test('initial baseline status max_items is a typed unrecoverable limitation', async () => {
  const s = setup(path => {
    if (path === '/sync/activities') return { all: oldDate };
    if (path === '/sync/all-items/shows' || path === '/sync/all-items/shows/watching') throw maxItems();
    return {};
  });
  await expect(fetchInitialLibrary(s.client, 'token')).rejects.toMatchObject({
    name: 'LibrarySyncLimitError', phase: 'initial', operation: 'baseline',
    media: 'shows', status: 'watching',
  });
  expect(s.calls.map(c => c.path)).toEqual(['/sync/activities', '/sync/all-items/shows', '/sync/all-items/shows/watching']);
});

test('partial malformed or conflicting partition never advances snapshot', async () => {
  for (const payload of [
    { shows: [show(2), show(2)] },
    { shows: [show(2, 'completed'), show(2, 'dropped')] },
    { shows: [show(2, 'watching')] },
    { movies: [movie(88)] },
    { error: 'partial' },
  ]) {
    const before = previous(), saved = structuredClone(before);
    const s = setup(path => {
      if (path === '/sync/activities') return activities();
      if (path === '/sync/all-items' || path === '/sync/all-items/shows') throw maxItems();
      if (path === '/sync/all-items/shows/completed') return payload;
      return {};
    });
    await expect(refreshLibrary(s.client, 'token', before, opts)).rejects.toThrow();
    expect(before).toEqual(saved);
  }
});

test('oversized individual response remains a hard failure with no fake success', async () => {
  const before = previous(), saved = structuredClone(before);
  const s = setup(path => {
    if (path === '/sync/activities') return activities();
    if (path === '/sync/all-items' || path === '/sync/all-items/shows') throw maxItems();
    if (path === '/sync/all-items/shows/completed') throw new SimklApiError('simkl api error: response too large', 200, null);
    return {};
  });
  await expect(refreshLibrary(s.client, 'token', before, opts)).rejects.toThrow('response too large');
  expect(before).toEqual(saved);
  expect(s.calls.filter(c => c.path === '/sync/all-items/shows/completed')).toHaveLength(1);
});

test('fallback logs only bounded partition metadata, never token or title', async () => {
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    const s = setup(path => path === '/sync/all-items' ? (() => { throw maxItems(); })() : {});
    await fetchPartitionedLibrary(s.client, 'VERY_SECRET_TOKEN', 'delta', { date_from: oldDate }, value => ({
      ...empty(), ...(value as object),
    }));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join(' ')).toContain('partition_fallback');
    expect(logs.join(' ')).toContain('max_items');
    expect(logs.join(' ')).not.toContain('VERY_SECRET_TOKEN');
    expect(logs.join(' ')).not.toContain(oldDate);
    expect(s.calls).toHaveLength(4);
    expect(s.peak()).toBe(1);
  } finally { console.info = originalInfo; }
});

test('instrumentation logs activity gate, exact request order and commit-readiness correlation', async () => {
  const originalInfo = console.info;
  const logs: Array<Record<string, unknown>> = [];
  console.info = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    try {
      const parsed = JSON.parse(text);
      if (parsed.component === 'simkl_library_sync') logs.push(parsed);
    } catch { /* unrelated test output */ }
  };
  try {
    const s = setup(path => {
      if (path === '/sync/activities') return activities();
      if (path === '/sync/all-items') throw maxItems();
      if (path === '/sync/all-items/shows') return { shows: [show(1)] };
      return {};
    });
    const result = await refreshLibrary(s.client, 'VERY_SECRET_TOKEN', previous(), opts);
    expect(result.activities.all).toBe(newDate);
    const requests = logs.filter(log => log.event === 'upstream_request');
    expect(requests).toHaveLength(5);
    expect(requests.map(log => log.requestNo)).toEqual([1, 2, 3, 4, 5]);
    expect(requests.map(log => log.operation)).toEqual(['activities', 'delta', 'delta', 'delta', 'delta']);
    expect(requests.map(log => log.outcome)).toEqual(['success', 'failed', 'success', 'success', 'success']);
    expect(requests[1].reason).toBe('max_items');
    expect(requests[1].queryMode).toBe('date_from');
    expect(requests[2].media).toBe('shows');
    expect(logs.find(log => log.event === 'activities_gate')?.outcome).toBe('watermark_changed');
    expect(logs.filter(log => log.event === 'route' && log.outcome === 'required').map(log => log.operation)).toEqual(['delta']);
    expect(logs.find(log => log.event === 'snapshot_ready')?.requests).toBe(5);
    expect(new Set(logs.map(log => log.syncId)).size).toBe(1);
    expect(typeof logs[0].syncId).toBe('string');
    for (const log of requests) expect(typeof log.durationMs).toBe('number');
    const rendered = JSON.stringify(logs);
    expect(rendered).not.toContain('VERY_SECRET_TOKEN');
    expect(rendered).not.toContain(oldDate);
    expect(rendered).not.toContain(newDate);
    expect(rendered).not.toContain('Title');
    expect(rendered).not.toContain('Show');
    expect(rendered).not.toContain('simkl_id');
  } finally { console.info = originalInfo; }
});

test('incremental unchanged activities and TTL shortcut are observable without redundant requests', async () => {
  const originalInfo = console.info;
  const logs: Array<Record<string, unknown>> = [];
  console.info = (...args: unknown[]) => {
    try {
      const entry = JSON.parse(args.map(String).join(' '));
      if (entry.component === 'simkl_library_sync') logs.push(entry);
    } catch { /* ignore */ }
  };
  try {
    const s = setup(path => {
      if (path === '/sync/activities') return { all: oldDate };
      throw new Error('unexpected library pull');
    });
    await refreshLibrary(s.client, 'token', previous(), opts);
    expect(s.calls).toHaveLength(1);
    expect(logs.find(log => log.event === 'activities_gate')?.outcome).toBe('watermark_unchanged');
    expect(logs.filter(log => log.event === 'upstream_request')).toHaveLength(1);
    logs.length = 0;
    await refreshLibrary(s.client, 'token', previous(), { ...opts, now: 299_999 });
    expect(s.calls).toHaveLength(1);
    expect(logs.find(log => log.event === 'activities_gate')?.outcome).toBe('ttl_hit');
    expect(logs.filter(log => log.event === 'upstream_request')).toHaveLength(0);
  } finally { console.info = originalInfo; }
});

test('failed requests log only sanitized classifications and never raw upstream error content', async () => {
  const originalInfo = console.info;
  const logs: Array<Record<string, unknown>> = [];
  console.info = (...args: unknown[]) => {
    try {
      const entry = JSON.parse(args.map(String).join(' '));
      if (entry.component === 'simkl_library_sync') logs.push(entry);
    } catch { /* ignore */ }
  };
  try {
    const before = previous(), saved = structuredClone(before);
    const s = setup(path => {
      if (path === '/sync/activities') return activities('rated_at');
      if (path === '/sync/ratings') throw new SimklApiError(
        'SECRET upstream message with title, token and timestamp', 503,
        '{"secret":"private user title"}',
      );
      return {};
    });
    await expect(refreshLibrary(s.client, 'SECRET_ACCESS_TOKEN', before, opts)).rejects.toThrow('SECRET upstream message');
    expect(before).toEqual(saved);
    const error = logs.find(log => log.event === 'upstream_request' && log.outcome === 'failed');
    expect(error?.reason).toBe('upstream_http');
    const rendered = JSON.stringify(logs);
    expect(rendered).not.toContain('SECRET');
    expect(rendered).not.toContain('private user title');
    expect(rendered).not.toContain(oldDate);
    expect(logs.filter(log => log.event === 'snapshot_ready')).toHaveLength(0);
  } finally { console.info = originalInfo; }
});
