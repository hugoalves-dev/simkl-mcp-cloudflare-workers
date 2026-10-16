import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { refreshUserProfile, refreshUserSettings } from '../src/library/profile';
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

test('new accounts with null activity watermarks still fetch and cache settings and statistics', async () => {
  const nullActivities = { all: null, settings: { all: null } };
  const paths = upstream([nullActivities, settings, stats]);

  const result = await run(undefined, checkedAt + 1);

  expect(paths).toEqual(['/sync/activities', '/users/settings', '/users/42/stats']);
  expect(result.snapshot.activities).toEqual(nullActivities);
  expect(result.snapshot.settingsActivity).toBeNull();
  expect(result.snapshot.statsActivity).toBeNull();
});

test('null activity watermarks are stable and do not refetch cached values on stale checks', async () => {
  const previous = previousProfile({
    activities: { all: null, settings: { all: null } },
    settingsActivity: null,
    statsActivity: null,
  });
  const paths = upstream([{ all: null, settings: { all: null } }]);

  const result = await run(previous, checkedAt + (ttlSeconds + 1) * 1000);

  expect(paths).toEqual(['/sync/activities']);
  expect(result.stats).toEqual(stats);
  expect(result.snapshot.settings).toEqual(settings);
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

const runSettings = (previous: UserProfileSnapshot | undefined, now: number, librarySnapshot?: LibrarySnapshot) =>
  refreshUserSettings(client, 'access-token', previous, librarySnapshot, { ttlSeconds, now });

test('rewatch-only settings read does not fetch statistics or initialize a library', async () => {
  const pro = { account: { id: 42, type: 'pro' } };
  const paths = upstream([activities(), pro]);
  const result = await runSettings(undefined, checkedAt + 1);
  expect(paths).toEqual(['/sync/activities', '/users/settings']);
  expect(result.settings).toEqual(pro);
  expect(result.snapshot.stats).toBeUndefined();
  expect(result.snapshot.statsActivity).toBeUndefined();
  expect(result.settingsRefreshed).toBe(true);
  expect(result.activitySource).toBe('upstream');
});

test('multiple sessions reuse persisted settings without repeated settings requests', async () => {
  const pro = { account: { type: 'PRO' } };
  const paths = upstream([activities(), pro, activities()]);
  const first = await runSettings(undefined, checkedAt + 1);
  const second = await runSettings(first.snapshot, checkedAt + 60_000);
  const third = await runSettings(second.snapshot, checkedAt + (ttlSeconds + 1) * 1000);
  expect(paths).toEqual(['/sync/activities', '/users/settings', '/sync/activities']);
  expect(second.settings).toEqual(pro);
  expect(third.settings).toEqual(pro);
  expect(second.settingsRefreshed).toBe(false);
  expect(third.settingsRefreshed).toBe(false);
  expect(second.activitySource).toBe('profile_ttl');
});

test('plan upgrades, lapses and cancellations refresh at settings.all changes', async () => {
  const sequence = [
    { marker: '2026-10-13T10:30:00Z', type: 'pro' },
    { marker: '2026-10-13T10:45:00Z', type: 'free' },
    { marker: '2026-10-13T11:00:00Z', type: 'vip' },
  ];
  let previous = previousProfile({ settings: { account: { type: 'free' } } });
  const responses = sequence.flatMap(change => [activities(oldAll, change.marker), { account: { type: change.type } }]);
  const paths = upstream(responses);
  for (const [i, change] of sequence.entries()) {
    const result = await runSettings(previous, checkedAt + (i + 1) * (ttlSeconds + 1) * 1000);
    expect((result.settings.account as { type: string }).type).toBe(change.type);
    expect(result.settingsRefreshed).toBe(true);
    expect(result.snapshot.statsActivity).toBe(oldAll);
    previous = result.snapshot;
  }
  expect(paths).toEqual(sequence.flatMap(() => ['/sync/activities', '/users/settings']));
});

test('settings-only reads do not falsely mark changed statistics as up to date', async () => {
  const paths = upstream([activities(changedAll, changedSettings), { account: { type: 'vip' } }, { total_mins: 240 }]);
  const profile = await runSettings(previousProfile(), checkedAt + (ttlSeconds + 1) * 1000);
  expect(profile.snapshot.statsActivity).toBe(oldAll);
  expect(profile.snapshot.stats).toEqual(stats);
  const result = await run(profile.snapshot, profile.snapshot.checkedAt + 1);
  expect(result.stats).toEqual({ total_mins: 240 });
  expect(paths).toEqual(['/sync/activities', '/users/settings', '/users/42/stats']);
});

test('missing cached settings are reloaded even with unchanged activity marker', async () => {
  const previous = previousProfile({ settings: undefined, settingsActivity: undefined });
  const paths = upstream([{ account: { type: 'pro' } }]);
  const result = await runSettings(previous, checkedAt + 1);
  expect(paths).toEqual(['/users/settings']);
  expect((result.settings.account as { type: string }).type).toBe('pro');
  expect(result.snapshot.stats).toEqual(stats);
});
