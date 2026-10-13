import { expect, test } from 'bun:test';
import { LibraryStore } from '../src/library/store';
import { sqliteStorage } from './helpers/library-storage';
import type { LibraryCandidate, UserProfileSnapshot } from '../src/library/types';

const activities = {
  all: '2026-10-13T10:00:00Z',
  settings: { all: '2026-10-13T09:00:00Z' },
};

const profile = (overrides: Partial<UserProfileSnapshot> = {}): UserProfileSnapshot => ({
  version: 1,
  activities,
  checkedAt: 1234,
  settingsActivity: activities.settings.all,
  settings: { account: { id: 42 } },
  statsActivity: activities.all,
  stats: { total_mins: 180 },
  ...overrides,
});

const candidate: LibraryCandidate = {
  activities: { all: activities.all },
  items: [{ mediaType: 'shows', simklId: '7', itemJson: JSON.stringify({ show: { ids: { simkl: 7 } } }) }],
};

test('profile cache survives LibraryStore reconstruction', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.saveProfile(profile());

  expect(new LibraryStore(storage).loadProfile()).toEqual(profile());
  db.close();
});

test('profile cache accepts and reconstructs null Simkl activity watermarks', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  const nullProfile = profile({
    activities: { all: null, settings: { all: null } } as any,
    settingsActivity: null as any,
    statsActivity: null as any,
  });

  store.saveProfile(nullProfile);
  expect(new LibraryStore(storage).loadProfile()).toEqual(nullProfile);
  db.close();
});

test('profile cache writes preserve library completion and item rows', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit(candidate);
  store.saveProfile(profile());

  expect(store.getInitialization()).toEqual({ initialized: true, itemCount: 1 });
  expect(store.readItems()).toEqual(candidate.items);
  expect(store.loadProfile()).toEqual(profile());
  db.close();
});

test('library activity snapshot can be loaded without materializing item rows', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit(candidate, { checkedAt: 5678, forceCheck: false });

  expect(store.loadActivitySnapshot()).toEqual({ activities: { all: activities.all }, checkedAt: 5678, forceCheck: false });
  db.close();
});

test('malformed persisted profile JSON is rejected', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  db.query("INSERT INTO library_metadata (key, value_json) VALUES ('user-profile', '{')").run();

  expect(store.loadProfile).toBeFunction();
  expect(() => store.loadProfile()).toThrow();
  db.close();
});

test('oversized profile serialization rejects before transaction and keeps previous profile', () => {
  const adapter = sqliteStorage();
  const store = new LibraryStore(adapter.storage);
  store.saveProfile(profile());
  const transactionCount = adapter.transactions();

  expect(() => store.saveProfile(profile({ settings: { bio: 'x'.repeat(1024 * 1024) } }))).toThrow('too large');
  expect(adapter.transactions()).toBe(transactionCount);
  expect(store.loadProfile()).toEqual(profile());
  adapter.db.close();
});
