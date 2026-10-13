import { expect, test } from 'bun:test';
import { LibraryStore } from '../src/library/store';
import { sqliteStorage } from './helpers/library-storage';
const all = '2026-10-01T00:00:00Z';
const row = { mediaType: 'shows' as const, simklId: '1', itemJson: JSON.stringify({ status: 'watching', show: { title: 'Existing', ids: { simkl: 1 } } }) };
test('existing issue-13 completion and rows become an incremental snapshot without reinitialization', () => {
  const s = sqliteStorage(); const store = new LibraryStore(s.storage);
  store.commit({ activities: { all }, items: [row] });
  const snapshot = store.loadSnapshot()!;
  expect(snapshot.activities.all).toBe(all); expect(snapshot.items.shows[0].show?.title).toBe('Existing'); expect(snapshot.forceCheck).toBe(false);
  expect(snapshot.checkedAt).toBeGreaterThan(0); s.db.close();
});
test('freshness snapshot commits atomically to existing schema and keeps completion API compatible', () => {
  const s = sqliteStorage(); const store = new LibraryStore(s.storage);
  store.commit({ activities: { all }, items: [row] });
  const previous = store.loadSnapshot()!;
  store.saveSnapshot({ ...previous, checkedAt: 123, forceCheck: true });
  expect(store.loadSnapshot()?.checkedAt).toBe(123); expect(store.loadSnapshot()?.forceCheck).toBe(true);
  expect(store.getInitialization()).toEqual({ initialized: true, itemCount: 1 });
  expect(store.readItems()).toEqual([row]); s.db.close();
});
test('snapshot saves retain canonical Simkl row IDs', () => {
  const s = sqliteStorage(); const store = new LibraryStore(s.storage);
  store.saveSnapshot({ version: 1, activities: { all }, checkedAt: 123, forceCheck: false, items: { shows: [{ status: 'watching', show: { ids: { simkl: '0001' } } }], movies: [], anime: [] } });
  expect(store.readItems()[0].simklId).toBe('1'); s.db.close();
});
