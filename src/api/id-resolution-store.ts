import { isResolvedSimklId, type RedirectReservation, type ResolvedSimklId } from './id-resolution';

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24;

/**
 * Public catalog data only: never a token, user ID or library row. Lives in
 * its own Durable Object, separate from per-user library storage.
 */
export class IdResolutionStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS redirect_budget (
      hour INTEGER PRIMARY KEY,
      count INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS id_resolution (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      simkl_id INTEGER NOT NULL,
      slug TEXT,
      expires_at INTEGER NOT NULL
    )`);
  }

  /**
   * Rolling 24-hour window in hourly buckets: whatever day boundary Simkl
   * uses, no calendar day can see more than `limit` attempts.
   */
  reserve(now: number, limit: number): RedirectReservation {
    return this.storage.transactionSync(() => {
      const hour = Math.floor(now / HOUR_MS);
      const oldest = hour - WINDOW_HOURS + 1;
      this.storage.sql.exec('DELETE FROM redirect_budget WHERE hour < ?', oldest);
      const rows = this.storage.sql.exec<{ hour: number; count: number }>(
        'SELECT hour, count FROM redirect_budget ORDER BY hour ASC',
      ).toArray();
      let used = rows.reduce((sum, row) => sum + Number(row.count), 0);
      if (used >= limit) {
        // Wait until enough of the oldest buckets leave the window.
        let freedAt = (hour + 1) * HOUR_MS;
        for (const row of rows) {
          used -= Number(row.count);
          freedAt = (Number(row.hour) + WINDOW_HOURS) * HOUR_MS;
          if (used < limit) break;
        }
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((freedAt - now) / 1000)) };
      }
      this.storage.sql.exec(
        'INSERT INTO redirect_budget (hour, count) VALUES (?, 1) ON CONFLICT(hour) DO UPDATE SET count = count + 1',
        hour,
      );
      return { allowed: true, retryAfterSeconds: 0 };
    });
  }

  lookup(key: string, now: number): ResolvedSimklId | null {
    const row = this.storage.sql.exec<{ type: string; simkl_id: number; slug: string | null }>(
      'SELECT type, simkl_id, slug FROM id_resolution WHERE key = ? AND expires_at > ?', key, now,
    ).toArray()[0];
    if (!row) return null;
    const value = { type: row.type, id: Number(row.simkl_id), ...(row.slug ? { slug: row.slug } : {}) };
    return isResolvedSimklId(value) ? value : null;
  }

  store(key: string, value: ResolvedSimklId, now: number, ttlSeconds: number): void {
    if (!/^[0-9a-f]{64}$/.test(key) || !isResolvedSimklId(value)) return;
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM id_resolution WHERE expires_at <= ?', now);
      this.storage.sql.exec(
        `INSERT INTO id_resolution (key, type, simkl_id, slug, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET type = excluded.type, simkl_id = excluded.simkl_id,
           slug = excluded.slug, expires_at = excluded.expires_at`,
        key, value.type, value.id, value.slug ?? null, now + ttlSeconds * 1000,
      );
    });
  }
}
