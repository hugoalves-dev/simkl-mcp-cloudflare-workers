import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { refreshUserProfile } from '../src/library/profile';
import type { LibrarySnapshot, UserProfileSnapshot } from '../src/library/types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
const oldAll = '2026-10-13T10:00:00Z';
const oldSettings = '2026-10-13T09:00:00Z';
const changedAll = '2026-10-13T11:00:00Z';
const changedSettings = '2026-10-13T10:30:00Z';
const checkedAt = Date.parse(oldAll);
const ttlSeconds = 300;
const settings = { account: { id: 42 } };
const stats = { total_mins: 180 };

function activities(all = oldAll, settingsAll = oldSettings) {
  return { all, settings: { all: settingsAll } };
}

function previousProfile(overrides: Partial<UserProfileSnapshot> = {}): UserProfileSnapshot {
  return {
    version: 1,
    activities: activities(),
    checkedAt,
    settingsActivity: oldSettings,
    settings,
    statsActivity: oldAll,
    stats,
    ...overrides,
  };
}

function upstream(responses: unknown[]) {
  const paths: string[] = [];
  globalThis.fetch = (async input => {
    paths.push(new URL(String(input)).pathname);
    const data = responses.shift();
    if (data instanceof Error) throw data;
    return Response.json(data);
  }) as typeof fetch;
  return paths;
}

const run = (previous: UserProfileSnapshot | undefined, now: number, librarySnapshot?: LibrarySnapshot) =>
  refreshUserProfile(client, 'access-token', '42', previous, librarySnapshot, { ttlSeconds, now });

test('first profile read fetches activities, settings, and statistics in order', async () => {
  const paths = upstream([activities(), settings, stats]);

  const result = await run(undefined, checkedAt + 1);

  expect(paths).toEqual(['/sync/activities', '/users/settings', '/users/42/stats']);
  expect(result.snapshot.settings).toEqual(settings);
  expect(result.snapshot.stats).toEqual(stats);
  expect(result.stats).toEqual(stats);
});

test('unchanged activity snapshot serves the profile cache without Simkl requests inside TTL', async () => {
  const paths = upstream([]);

  const result = await run(previousProfile(), checkedAt + 60_000);

  expect(paths).toEqual([]);
  expect(result.stats).toEqual(stats);
});

test('settings activity change refreshes settings without refetching statistics', async () => {
  const paths = upstream([activities(oldAll, changedSettings), { account: { id: 42, timezone: 'UTC' } }]);

  const result = await run(previousProfile(), checkedAt + (ttlSeconds + 1) * 1000);

  expect(paths).toEqual(['/sync/activities', '/users/settings']);
  expect(result.snapshot.settings).toEqual({ account: { id: 42, timezone: 'UTC' } });
  expect(result.stats).toEqual(stats);
});

test('top-level activity change refreshes statistics without refetching settings', async () => {
  const paths = upstream([activities(changedAll, oldSettings), { total_mins: 240 }]);

  const result = await run(previousProfile(), checkedAt + (ttlSeconds + 1) * 1000);

  expect(paths).toEqual(['/sync/activities', '/users/42/stats']);
  expect(result.snapshot.settings).toEqual(settings);
  expect(result.stats).toEqual({ total_mins: 240 });
});

test('both changed activity markers refresh settings and statistics', async () => {
  const paths = upstream([activities(changedAll, changedSettings), { account: { id: 42 } }, { total_mins: 240 }]);

  const result = await run(previousProfile(), checkedAt + (ttlSeconds + 1) * 1000);

  expect(paths).toEqual(['/sync/activities', '/users/settings', '/users/42/stats']);
  expect(result.snapshot.settingsActivity).toBe(changedSettings);
  expect(result.snapshot.statsActivity).toBe(changedAll);
});

test('a fresh initialized library snapshot is reused without extending its checkedAt', async () => {
  const paths = upstream([]);
  const librarySnapshot: LibrarySnapshot = {
    version: 1,
    items: { shows: [], movies: [], anime: [] },
    activities: activities(),
    checkedAt: checkedAt + 200_000,
    forceCheck: false,
  };

  const result = await run(previousProfile({ checkedAt: checkedAt - ttlSeconds * 1000 }), checkedAt + 250_000, librarySnapshot);

  expect(paths).toEqual([]);
  expect(result.snapshot.checkedAt).toBe(librarySnapshot.checkedAt);
});

test('stale profile requests only activities when both profile watermarks are unchanged', async () => {
  const paths = upstream([activities()]);

  const result = await run(previousProfile(), checkedAt + (ttlSeconds + 1) * 1000);

  expect(paths).toEqual(['/sync/activities']);
  expect(result.stats).toEqual(stats);
});

test('failed settings request leaves prior profile unchanged and retries', async () => {
  const previous = previousProfile();
  const paths = upstream([activities(oldAll, changedSettings), new Error('settings failed')]);
  await expect(run(previous, checkedAt + (ttlSeconds + 1) * 1000)).rejects.toThrow();
  expect(previous).toEqual(previousProfile());

  upstream([activities(oldAll, changedSettings), { account: { id: 42 } }]);
  const retried = await run(previous, checkedAt + (ttlSeconds + 1) * 1000);
  expect(paths).toEqual(['/sync/activities', '/users/settings']);
  expect(retried.snapshot.settingsActivity).toBe(changedSettings);
});

test('failed statistics request leaves prior profile unchanged and retries', async () => {
  const previous = previousProfile();
  const paths = upstream([activities(changedAll, oldSettings), new Error('stats failed')]);
  await expect(run(previous, checkedAt + (ttlSeconds + 1) * 1000)).rejects.toThrow();
  expect(previous).toEqual(previousProfile());

  upstream([activities(changedAll, oldSettings), { total_mins: 240 }]);
  const retried = await run(previous, checkedAt + (ttlSeconds + 1) * 1000);
  expect(paths).toEqual(['/sync/activities', '/users/42/stats']);
  expect(retried.snapshot.statsActivity).toBe(changedAll);
});

test('invalid activity timestamp fails without advancing cached markers', async () => {
  const previous = previousProfile();
  upstream([{ all: 'not-a-date' }]);
  await expect(run(previous, checkedAt + (ttlSeconds + 1) * 1000)).rejects.toThrow();
  expect(previous).toEqual(previousProfile());
});

test('oversized profile response is rejected before it can be persisted', async () => {
  const previous = previousProfile();
  upstream([activities(changedAll, oldSettings), { total_mins: 240, detail: 'x'.repeat(1024 * 1024) }]);
  await expect(run(previous, checkedAt + (ttlSeconds + 1) * 1000)).rejects.toThrow(/large|size/i);
  expect(previous).toEqual(previousProfile());
});
