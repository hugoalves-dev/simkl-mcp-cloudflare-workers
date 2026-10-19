import { normalizeSimklId } from './identity';
import type { RewatchRow, RewatchSnapshot } from './rewatches.js';
import {
  isRecord, jsonBytes, MAX_ROW_JSON_BYTES, MAX_PENDING_ITEM_BYTES,
  type LibraryActivitySnapshot, type LibraryCandidate, type LibraryInitialization, type LibraryItemRow, type LibrarySnapshot, type LibraryItem, type UserProfileSnapshot, MEDIA_TYPES,
} from './types.js';

/** Application events are correlated with Cloudflare's $metadata.traceId. No credentials or item details. */
function logCacheStorageEvent(event: 'metadata_updated' | 'items_changed', details: Record<string, string | number | boolean>): void {
  console.info(JSON.stringify({ component: 'simkl_library_cache', event, ...details }));
}

function isActivityTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}

function isUserProfileSnapshot(value: unknown): value is UserProfileSnapshot {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.activities)
    || !(value.activities.all === null || isActivityTimestamp(value.activities.all))
    || !Number.isFinite(value.checkedAt) || (value.checkedAt as number) < 0) return false;
  if (value.activities.settings !== undefined && (!isRecord(value.activities.settings)
    || (value.activities.settings.all !== undefined && value.activities.settings.all !== null && !isActivityTimestamp(value.activities.settings.all)))) return false;
  if (value.settingsActivity !== undefined && value.settingsActivity !== null && !isActivityTimestamp(value.settingsActivity)) return false;
  if (value.statsActivity !== undefined && value.statsActivity !== null && !isActivityTimestamp(value.statsActivity)) return false;
  if (value.settings !== undefined && !isRecord(value.settings)) return false;
  if (value.stats !== undefined && !isRecord(value.stats)) return false;
  return true;
}

/** Network-free SQLite storage; all serialization happens before transactionSync. */
export class LibraryStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS library_items (
      media_type TEXT NOT NULL, simkl_id TEXT NOT NULL, item_json TEXT NOT NULL,
      PRIMARY KEY (media_type, simkl_id))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS rewatch_sessions (
      media_type TEXT NOT NULL, simkl_id TEXT NOT NULL, rewatch_id INTEGER NOT NULL,
      item_json TEXT NOT NULL, PRIMARY KEY (media_type, simkl_id, rewatch_id))`);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS library_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
    storage.sql.exec("INSERT OR IGNORE INTO library_metadata (key, value_json) VALUES ('schema-version', '1')");
  }

  getInitialization(): LibraryInitialization | null {
    const row = this.storage.sql.exec<{ value_json: string }>(
      "SELECT value_json FROM library_metadata WHERE key = 'completion'",
    ).toArray()[0];
    if (!row) return null;
    const value: unknown = JSON.parse(row.value_json);
    if (!isRecord(value) || !Number.isSafeInteger(value.itemCount) || (value.itemCount as number) < 0) {
      throw new Error('Invalid library cache completion metadata');
    }
    return { initialized: true, itemCount: value.itemCount as number };
  }

  loadProfile(): UserProfileSnapshot | undefined {
    const row = this.storage.sql.exec<{ value_json: string }>(
      "SELECT value_json FROM library_metadata WHERE key = 'user-profile'",
    ).toArray()[0];
    if (!row) return undefined;
    const value: unknown = JSON.parse(row.value_json);
    if (!isUserProfileSnapshot(value)) throw new Error('Invalid user profile cache record');
    return value;
  }

  saveProfile(snapshot: UserProfileSnapshot): void {
    if (!isUserProfileSnapshot(snapshot)) throw new Error('Invalid user profile cache record');
    const serialized = JSON.stringify(snapshot);
    if (jsonBytes(serialized) > MAX_ROW_JSON_BYTES) throw new Error('User profile cache too large');
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT OR REPLACE INTO library_metadata (key, value_json) VALUES ('user-profile', ?)",
        serialized,
      );
    });
  }

  commit(candidate: LibraryCandidate, freshness?: { checkedAt: number; forceCheck: boolean }): LibraryInitialization {
    const metadata = JSON.stringify({ activities: candidate.activities, completedAt: Date.now(), itemCount: candidate.items.length, ...freshness });
    if (jsonBytes(metadata) > MAX_ROW_JSON_BYTES) throw new Error('Library metadata too large');
    let pendingBytes = 0;
    for (const item of candidate.items) {
      const bytes = jsonBytes(item.itemJson);
      if (bytes > MAX_ROW_JSON_BYTES) throw new Error('Library item too large');
      pendingBytes += bytes;
      if (pendingBytes > MAX_PENDING_ITEM_BYTES) throw new Error('Library initialization too large');
    }
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM library_items');
      for (const item of candidate.items) {
        this.storage.sql.exec('INSERT INTO library_items (media_type, simkl_id, item_json) VALUES (?, ?, ?)',
          item.mediaType, item.simklId, item.itemJson);
      }
      this.storage.sql.exec("INSERT OR REPLACE INTO library_metadata (key, value_json) VALUES ('completion', ?)", metadata);
    });
    logCacheStorageEvent('metadata_updated', { operation: 'initialize', forceCheck: freshness?.forceCheck ?? false });
    if (candidate.items.length > 0) {
      logCacheStorageEvent('items_changed', { operation: 'initialize', upserted: candidate.items.length, removed: 0, totalItems: candidate.items.length });
    }
    return { initialized: true, itemCount: candidate.items.length };
  }

  loadActivitySnapshot(): LibraryActivitySnapshot | undefined {
    const version = this.storage.sql.exec<{ value_json: string }>("SELECT value_json FROM library_metadata WHERE key = 'schema-version'").toArray()[0];
    if (version?.value_json !== '1') throw new Error('Unsupported library cache schema');
    const row = this.storage.sql.exec<{ value_json: string }>("SELECT value_json FROM library_metadata WHERE key = 'completion'").toArray()[0];
    if (!row) return undefined;
    const metadata = JSON.parse(row.value_json);
    if (!isRecord(metadata.activities) || (metadata.activities.all !== null && (typeof metadata.activities.all !== 'string' || !Number.isFinite(Date.parse(metadata.activities.all))))) throw new Error('Invalid cached library activities');
    const checkedAt = metadata.checkedAt ?? metadata.completedAt;
    if (!Number.isFinite(checkedAt)) throw new Error('Invalid cached library check time');
    return { activities: metadata.activities, checkedAt, forceCheck: metadata.forceCheck === true };
  }

  loadSnapshot(): LibrarySnapshot | undefined {
    const activitySnapshot = this.loadActivitySnapshot();
    if (!activitySnapshot) return undefined;
    const items: LibrarySnapshot['items'] = { shows: [], movies: [], anime: [] };
    for (const row of this.readItems()) items[row.mediaType].push(JSON.parse(row.itemJson) as LibraryItem);
    return { version: 1, items, ...activitySnapshot };
  }

  /**
   * Persist a freshness flag or TTL check without loading or mutating library_items.
   * The completion record remains compatible with caches created before this change.
   */
  saveFreshness(freshness: Pick<LibraryActivitySnapshot, 'checkedAt' | 'forceCheck'>): void {
    if (!Number.isFinite(freshness.checkedAt) || freshness.checkedAt < 0
      || typeof freshness.forceCheck !== 'boolean') throw new Error('Invalid library cache freshness');
    const row = this.storage.sql.exec<{ value_json: string }>(
      "SELECT value_json FROM library_metadata WHERE key = 'completion'",
    ).toArray()[0];
    if (!row) throw new Error('Library cache is not initialized');
    const previous: unknown = JSON.parse(row.value_json);
    if (!isRecord(previous)) throw new Error('Invalid library cache completion metadata');
    const metadata = JSON.stringify({ ...previous, ...freshness });
    if (jsonBytes(metadata) > MAX_ROW_JSON_BYTES) throw new Error('Library metadata too large');
    this.storage.transactionSync(() => {
      this.storage.sql.exec("UPDATE library_metadata SET value_json = ? WHERE key = 'completion'", metadata);
    });
    logCacheStorageEvent('metadata_updated', { operation: 'freshness', forceCheck: freshness.forceCheck });
  }

  /**
   * Initial snapshots use the atomic replacement path. Incremental snapshots only
   * write rows whose serialized value changed and delete rows no longer present.
   * Both the delta and its new activity watermark commit in a single transaction.
   */
  saveSnapshot(snapshot: LibrarySnapshot): void {
    if (snapshot.version !== 1) throw new Error('Unsupported library cache schema');
    const items: LibraryItemRow[] = [];
    const nextKeys = new Set<string>();
    let pendingBytes = 0;
    for (const mediaType of MEDIA_TYPES) for (const item of snapshot.items[mediaType]) {
      const id = normalizeSimklId((item.show || item.movie || item.anime)?.ids?.simkl);
      if (!id) throw new Error('Invalid cached library item ID');
      const key = JSON.stringify([mediaType, id]);
      if (nextKeys.has(key)) throw new Error('Duplicate cached library item ID');
      nextKeys.add(key);
      const itemJson = JSON.stringify(item);
      const bytes = jsonBytes(itemJson);
      if (bytes > MAX_ROW_JSON_BYTES) throw new Error('Library item too large');
      pendingBytes += bytes;
      if (pendingBytes > MAX_PENDING_ITEM_BYTES) throw new Error('Library initialization too large');
      items.push({ mediaType, simklId: id, itemJson });
    }
    const freshness = { checkedAt: snapshot.checkedAt, forceCheck: snapshot.forceCheck };
    if (!Number.isFinite(freshness.checkedAt) || freshness.checkedAt < 0
      || typeof freshness.forceCheck !== 'boolean') throw new Error('Invalid library cache freshness');
    const candidate = { activities: snapshot.activities, items };
    if (!this.getInitialization()) {
      this.commit(candidate, freshness);
      return;
    }

    const metadata = JSON.stringify({
      activities: candidate.activities, completedAt: Date.now(), itemCount: items.length, ...freshness,
    });
    if (jsonBytes(metadata) > MAX_ROW_JSON_BYTES) throw new Error('Library metadata too large');
    const previous = new Map(this.readItems().map(row => [JSON.stringify([row.mediaType, row.simklId]), row.itemJson]));
    const changes = items.filter(row => previous.get(JSON.stringify([row.mediaType, row.simklId])) !== row.itemJson);
    const removals = [...previous.keys()].filter(key => !nextKeys.has(key));

    this.storage.transactionSync(() => {
      for (const key of removals) {
        const [mediaType, simklId] = JSON.parse(key) as [string, string];
        this.storage.sql.exec('DELETE FROM library_items WHERE media_type = ? AND simkl_id = ?', mediaType, simklId);
      }
      for (const row of changes) {
        this.storage.sql.exec(
          'INSERT INTO library_items (media_type, simkl_id, item_json) VALUES (?, ?, ?) ON CONFLICT(media_type, simkl_id) DO UPDATE SET item_json = excluded.item_json',
          row.mediaType, row.simklId, row.itemJson,
        );
      }
      this.storage.sql.exec("INSERT OR REPLACE INTO library_metadata (key, value_json) VALUES ('completion', ?)", metadata);
    });
    logCacheStorageEvent('metadata_updated', { operation: 'snapshot', forceCheck: snapshot.forceCheck });
    if (changes.length > 0 || removals.length > 0) {
      logCacheStorageEvent('items_changed', {
        operation: 'incremental', upserted: changes.length, removed: removals.length, totalItems: items.length,
      });
    }
  }

  readItems(): LibraryItemRow[] {
    return this.storage.sql.exec<{ mediaType: 'shows' | 'movies' | 'anime'; simklId: string; itemJson: string }>(
      'SELECT media_type AS mediaType, simkl_id AS simklId, item_json AS itemJson FROM library_items ORDER BY media_type, simkl_id',
    ).toArray();
  }
  /** Separate identity model: canonical (type, id), rewatch (type, id, session). */
  loadRewatches(): RewatchSnapshot | undefined {
    const row = this.storage.sql.exec<{ value_json: string }>(
      "SELECT value_json FROM library_metadata WHERE key = 'rewatch-snapshot'",
    ).toArray()[0];
    if (!row) return undefined;
    const metadata: unknown = JSON.parse(row.value_json);
    if (!isRecord(metadata) || !isRecord(metadata.activities)
      || !(metadata.activities.all === null || isActivityTimestamp(metadata.activities.all))
      || typeof metadata.stale !== 'boolean') throw new Error('Invalid cached rewatch metadata');
    const rows = this.storage.sql.exec<{ mediaType: RewatchRow['mediaType']; simklId: string; rewatchId: number; itemJson: string }>(
      'SELECT media_type AS mediaType, simkl_id AS simklId, rewatch_id AS rewatchId, item_json AS itemJson FROM rewatch_sessions ORDER BY media_type, simkl_id, rewatch_id',
    ).toArray();
    return { activities: metadata.activities as RewatchSnapshot['activities'], stale: metadata.stale, rows };
  }

  saveRewatches(snapshot: RewatchSnapshot): void {
    if (!isRecord(snapshot.activities) || !(snapshot.activities.all === null || isActivityTimestamp(snapshot.activities.all))
      || typeof snapshot.stale !== 'boolean') throw new Error('Invalid rewatch snapshot');
    const metadata = JSON.stringify({ activities: snapshot.activities, stale: snapshot.stale });
    if (jsonBytes(metadata) > MAX_ROW_JSON_BYTES) throw new Error('Rewatch metadata too large');
    const newRows = new Map<string, RewatchRow>();
    let totalBytes = 0;
    for (const row of snapshot.rows) {
      if (!MEDIA_TYPES.includes(row.mediaType) || !normalizeSimklId(row.simklId)
        || !Number.isSafeInteger(row.rewatchId) || row.rewatchId <= 0) throw new Error('Invalid rewatch identity');
      const key = JSON.stringify([row.mediaType, row.simklId, row.rewatchId]);
      if (newRows.has(key)) throw new Error('Duplicate rewatch identity');
      const value: unknown = JSON.parse(row.itemJson);
      if (!isRecord(value) || value.is_rewatch !== true || value.rewatch_id !== row.rewatchId) {
        throw new Error('Invalid rewatch session body');
      }
      const size = jsonBytes(row.itemJson);
      if (size > MAX_ROW_JSON_BYTES) throw new Error('Rewatch session too large');
      totalBytes += size;
      if (totalBytes > MAX_PENDING_ITEM_BYTES) throw new Error('Rewatch cache too large');
      newRows.set(key, row);
    }
    const oldRows = this.loadRewatches()?.rows ?? [];
    const existing = new Map(oldRows.map(row => [JSON.stringify([row.mediaType, row.simklId, row.rewatchId]), row.itemJson]));
    const deletes = [...existing.keys()].filter(key => !newRows.has(key));
    const changes = [...newRows].filter(([key, row]) => existing.get(key) !== row.itemJson).map(([, row]) => row);
    // Rows, removals, and the cursor advance atomically; a failed delta can never
    // leave a newer watermark pointing at an incomplete set of sessions.
    this.storage.transactionSync(() => {
      for (const key of deletes) {
        const [type, id, session] = JSON.parse(key) as [string, string, number];
        this.storage.sql.exec('DELETE FROM rewatch_sessions WHERE media_type=? AND simkl_id=? AND rewatch_id=?', type, id, session);
      }
      for (const row of changes) {
        this.storage.sql.exec(
          'INSERT INTO rewatch_sessions (media_type, simkl_id, rewatch_id, item_json) VALUES (?, ?, ?, ?) ON CONFLICT(media_type, simkl_id, rewatch_id) DO UPDATE SET item_json=excluded.item_json',
          row.mediaType, row.simklId, row.rewatchId, row.itemJson,
        );
      }
      this.storage.sql.exec("INSERT OR REPLACE INTO library_metadata (key, value_json) VALUES ('rewatch-snapshot', ?)", metadata);
    });
    console.info(JSON.stringify({ component: 'simkl_rewatch_cache', event: 'snapshot_saved', upserted: changes.length, removed: deletes.length }));
  }

  invalidateRewatches(): void {
    const row = this.storage.sql.exec<{ value_json: string }>(
      "SELECT value_json FROM library_metadata WHERE key = 'rewatch-snapshot'",
    ).toArray()[0];
    if (!row) return; // First read always fetches a baseline.
    const metadata: unknown = JSON.parse(row.value_json);
    if (!isRecord(metadata) || !isRecord(metadata.activities)) throw new Error('Invalid cached rewatch metadata');
    if (metadata.stale === true) return;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE library_metadata SET value_json = ? WHERE key = 'rewatch-snapshot'",
        JSON.stringify({ ...metadata, stale: true }),
      );
    });
  }

}
