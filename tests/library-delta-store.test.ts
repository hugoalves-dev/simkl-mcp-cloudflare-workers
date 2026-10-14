import { expect, test } from 'bun:test';
import { LibraryStore } from '../src/library/store';
import { sqliteStorage } from './helpers/library-storage';
import type { LibraryCandidate, LibraryItem } from '../src/library/types';

const oldWatermark = '2026-10-01T00:00:00Z';
const newWatermark = '2026-10-02T00:00:00Z';
const show = (id: number, status = 'watching'): LibraryItem => ({
  status, show: { title: 'Show ' + id, ids: { simkl: id } },
});
function candidate(size: number): LibraryCandidate {
  return {
    activities: { all: oldWatermark },
    items: Array.from({ length: size }, (_, index) => ({
      mediaType: 'shows' as const, simklId: String(index + 1), itemJson: JSON.stringify(show(index + 1)),
    })),
  };
}
function audit(db: ReturnType<typeof sqliteStorage>['db']): () => string[] {
  db.exec('CREATE TABLE item_writes (operation TEXT NOT NULL)');
  for (const [name, operation] of [['insert', 'INSERT'], ['update', 'UPDATE'], ['delete', 'DELETE']]) {
    db.exec("CREATE TRIGGER count_" + name + " AFTER " + operation +
      " ON library_items BEGIN INSERT INTO item_writes VALUES ('" + name + "'); END");
  }
  return () => (db.query('SELECT operation FROM item_writes ORDER BY rowid').all() as { operation: string }[])
    .map(row => row.operation);
}

test('freshness-only checks and invalidations do not write library_items even with 5000 rows', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit(candidate(5000), { checkedAt: 10, forceCheck: false });
  const writes = audit(db);
  store.saveFreshness({ checkedAt: 20, forceCheck: true });
  store.saveFreshness({ checkedAt: 30, forceCheck: false });
  expect(store.loadActivitySnapshot()).toEqual({
    activities: { all: oldWatermark }, checkedAt: 30, forceCheck: false,
  });
  expect(store.getInitialization()).toEqual({ initialized: true, itemCount: 5000 });
  expect(writes()).toEqual([]);

  const previous = store.loadSnapshot()!;
  store.saveSnapshot({ ...previous, checkedAt: 40 });
  expect(writes()).toEqual([]);
  expect(store.loadSnapshot()?.checkedAt).toBe(40);
  db.close();
});

test('small incremental delta writes only changed, new, and removed items', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit(candidate(5000), { checkedAt: 10, forceCheck: false });
  const writes = audit(db);
  const previous = store.loadSnapshot()!;
  const next = previous.items.shows
    .filter(item => item.show?.ids.simkl !== 1)
    .map(item => item.show?.ids.simkl === 2 ? { ...item, status: 'completed' } : item);
  next.push(show(5001));
  store.saveSnapshot({
    ...previous,
    items: { ...previous.items, shows: next },
    activities: { all: newWatermark },
    checkedAt: 50,
  });
  expect(writes().sort()).toEqual(['delete', 'insert', 'update']);
  expect(store.getInitialization()?.itemCount).toBe(5000);
  expect(store.loadActivitySnapshot()?.activities.all).toBe(newWatermark);
  expect(store.loadSnapshot()?.items.shows.find(item => item.show?.ids.simkl === 2)?.status).toBe('completed');
  expect(store.loadSnapshot()?.items.shows.some(item => item.show?.ids.simkl === 1)).toBe(false);
  db.close();
});

test.each(['row', 'metadata'])('delta and watermark roll back together on %s failure', kind => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit(candidate(2), { checkedAt: 10, forceCheck: true });
  const beforeRows = store.readItems();
  const beforeActivity = store.loadActivitySnapshot();
  const previous = store.loadSnapshot()!;
  const next = {
    ...previous,
    activities: { all: newWatermark },
    checkedAt: 100,
    forceCheck: false,
    items: { ...previous.items, shows: [show(2, 'completed'), show(3)] },
  };
  if (kind === 'row') {
    db.exec("CREATE TRIGGER fail_delta BEFORE UPDATE ON library_items WHEN NEW.simkl_id = '2' BEGIN SELECT RAISE(ABORT, 'delta failed'); END");
  } else {
    db.exec("CREATE TRIGGER fail_meta BEFORE INSERT ON library_metadata WHEN NEW.key = 'completion' BEGIN SELECT RAISE(ABORT, 'metadata failed'); END");
  }
  expect(() => store.saveSnapshot(next)).toThrow('failed');
  expect(store.readItems()).toEqual(beforeRows);
  expect(store.loadActivitySnapshot()).toEqual(beforeActivity);
  db.exec('DROP TRIGGER ' + (kind === 'row' ? 'fail_delta' : 'fail_meta'));
  store.saveSnapshot(next);
  expect(store.loadActivitySnapshot()?.activities.all).toBe(newWatermark);
  expect(store.readItems().map(row => row.simklId)).toEqual(['2', '3']);
  db.close();
});

test('failed metadata-only update preserves previously persisted freshness', () => {
  const { storage, db } = sqliteStorage();
  const store = new LibraryStore(storage);
  store.commit(candidate(1), { checkedAt: 20, forceCheck: false });
  const beforeRows = store.readItems();
  db.exec("CREATE TRIGGER fail_freshness BEFORE UPDATE ON library_metadata WHEN NEW.key = 'completion' BEGIN SELECT RAISE(ABORT, 'freshness failed'); END");
  expect(() => store.saveFreshness({ checkedAt: 30, forceCheck: true })).toThrow('freshness failed');
  expect(store.loadActivitySnapshot()).toEqual({
    activities: { all: oldWatermark }, checkedAt: 20, forceCheck: false,
  });
  expect(store.readItems()).toEqual(beforeRows);
  db.close();
});
