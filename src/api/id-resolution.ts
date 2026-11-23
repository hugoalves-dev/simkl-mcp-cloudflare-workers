export type SimklDetailType = 'movies' | 'tv' | 'anime';

export interface ResolvedSimklId {
  type: SimklDetailType;
  id: number;
  slug?: string;
}

/**
 * Shared guard for Simkl `/redirect`. Simkl blocks a client_id from the whole
 * API after 1,000–10,000 `/redirect` calls a day, so every upstream attempt
 * must reserve budget first and successful resolutions are reused.
 */
export interface RedirectGuard {
  lookup(key: string): Promise<ResolvedSimklId | null>;
  /** Reserve one upstream `/redirect` attempt. Throws when the budget is spent. */
  reserve(): Promise<void>;
  store(key: string, value: ResolvedSimklId): Promise<void>;
}

export interface RedirectReservation {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class SimklRedirectBudgetError extends Error {
  constructor(public retryAfterSeconds: number) {
    super('Simkl ID resolution budget exhausted');
    this.name = 'SimklRedirectBudgetError';
  }
}

export class SimklRedirectGuardUnavailableError extends Error {
  constructor() {
    super('Simkl ID resolution guard unavailable');
    this.name = 'SimklRedirectGuardUnavailableError';
  }
}

export const DEFAULT_REDIRECT_DAILY_BUDGET = 500;
// Simkl's documented block threshold starts at 1,000/day; never allow a config to reach it.
export const MAX_REDIRECT_DAILY_BUDGET = 999;
export const DEFAULT_ID_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function parseRedirectDailyBudget(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return DEFAULT_REDIRECT_DAILY_BUDGET;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_REDIRECT_DAILY_BUDGET) : DEFAULT_REDIRECT_DAILY_BUDGET;
}

export function parseIdCacheTtlSeconds(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return DEFAULT_ID_CACHE_TTL_SECONDS;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 3600 || parsed > 365 * 24 * 60 * 60) return DEFAULT_ID_CACHE_TTL_SECONDS;
  return parsed;
}

/**
 * Stable, hashed key over every parameter that changes what `/redirect`
 * resolves to (e.g. `tmdb` with `type=movie` vs `type=tv`). Hashing keeps
 * free-text titles out of storage.
 */
export async function idResolutionKey(query: Record<string, string | number>): Promise<string> {
  const entries = Object.entries(query)
    .map(([key, value]) => {
      if (typeof value === 'number') return [key, value] as const;
      const text = value.trim().replace(/\s+/g, ' ');
      return [key, key === 'title' || key === 'imdb' ? text.toLowerCase() : text] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['v1', entries])));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isResolvedSimklId(value: unknown): value is ResolvedSimklId {
  if (!value || typeof value !== 'object') return false;
  const { type, id, slug } = value as Record<string, unknown>;
  return (type === 'movies' || type === 'tv' || type === 'anime')
    && typeof id === 'number' && Number.isSafeInteger(id) && id > 0
    && (slug === undefined || (typeof slug === 'string' && slug.length > 0 && slug.length <= 512));
}

interface GuardStub {
  lookup(key: string): Promise<ResolvedSimklId | null>;
  reserve(): Promise<RedirectReservation>;
  store(key: string, value: ResolvedSimklId): Promise<void>;
}

const GUARD_OBJECT_NAME = 'simkl-redirect-guard:v1';

/** One application-wide object: the budget is per Simkl client_id, not per user. */
export function createRedirectGuard(namespace: DurableObjectNamespace | undefined): RedirectGuard {
  const stub = (): GuardStub => {
    if (!namespace) throw new SimklRedirectGuardUnavailableError();
    const id = namespace.idFromName(GUARD_OBJECT_NAME);
    return (namespace as { get(id: DurableObjectId): unknown }).get(id) as GuardStub;
  };
  return {
    async lookup(key) {
      let value: unknown;
      // Fail closed: without the guard there is no budget check either.
      try { value = await stub().lookup(key); }
      catch { throw new SimklRedirectGuardUnavailableError(); }
      return isResolvedSimklId(value) ? value : null;
    },
    async reserve() {
      let reservation: RedirectReservation;
      try { reservation = await stub().reserve(); }
      catch { throw new SimklRedirectGuardUnavailableError(); }
      if (!reservation?.allowed) throw new SimklRedirectBudgetError(reservation?.retryAfterSeconds ?? 3600);
    },
    async store(key, value) {
      try { await stub().store(key, value); }
      catch { /* Best-effort: the upstream attempt was already counted. */ }
    },
  };
}
