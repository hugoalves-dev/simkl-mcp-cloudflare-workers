import type { RequestOptions, SimklClient } from './client.js';

export type RewatchMediaType = 'all' | 'movies' | 'shows' | 'anime';
export type RewatchWriteMediaType = Exclude<RewatchMediaType, 'all'>;
export type RewatchStatus = 'active' | 'closed' | 'completed';
type RewatchWriteOptions = Omit<RequestOptions, 'method'> & { method: 'POST' };

export interface RewatchItem extends Record<string, unknown> {
  ids: Record<string, string | number>;
  watched_at?: string;
  seasons?: Array<{ number: number; episodes?: Array<{ number: number; watched_at?: string }> }>;
}

export interface RewatchItemInput {
  mediaType: RewatchWriteMediaType;
  ids: Record<string, string | number>;
  watched_at?: string;
  seasons?: RewatchItem['seasons'];
}

export interface RewatchStartInput extends RewatchItemInput {
  rewatch_id?: number;
  rewatch_status?: RewatchStatus;
}

export interface RewatchUpdateInput extends RewatchItemInput {
  rewatch_id: number;
  rewatch_status?: RewatchStatus;
}

export class RewatchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewatchPlanError';
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const mediaKeys: Record<RewatchWriteMediaType, string> = { movies: 'movies', shows: 'shows', anime: 'anime' };
const numericIdKeys = new Set(['simkl', 'hulu', 'netflix', 'mal', 'tvdb', 'tmdb', 'anidb', 'crunchyroll', 'anilist', 'kitsu', 'livechart', 'anisearch']);
const stringIdKeys = new Set(['imdb', 'animeplanet', 'traktslug', 'letterboxd']);

export function hasValidMediaIds(ids: Record<string, string | number> | undefined): boolean {
  return !!ids && Object.entries(ids).some(([key, value]) => {
    if (key === 'tvdb' && typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value)) return true;
    if (numericIdKeys.has(key)) return typeof value === 'number'
      ? Number.isInteger(value) && value > 0
      : typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0;
    if (key === 'imdb') return typeof value === 'string' && (/^tt\d+$/.test(value) || /^https?:\/\/www\.imdb\.com\/title\/tt\d+\/?$/.test(value));
    return stringIdKeys.has(key) && typeof value === 'string' && value.trim().length > 0;
  });
}

export class RewatchService {
  private eligibility = new Map<string, { allowed: boolean; expiresAt: number }>();
  private writeRequest: (endpoint: string, options: RewatchWriteOptions) => Promise<any>;

  constructor(
    private readonly client: SimklClient,
    private readonly getToken: () => string | undefined,
    private readonly now: () => number = Date.now,
    writer?: (endpoint: string, options: RewatchWriteOptions) => Promise<any>,
  ) { this.writeRequest = writer ?? ((endpoint, options) => this.client.request(endpoint, options)); }

  async start(input: RewatchStartInput): Promise<any> {
    if (input.rewatch_id !== undefined) this.validateId(input.rewatch_id);
    if (input.rewatch_status === 'completed' && input.mediaType !== 'movies') {
      throw new Error('rewatch_status completed can only be set for movies');
    }
    const item = this.toItem(input);
    const token = await this.requireEligiblePlan();
    item.is_rewatch = true;
    if (input.rewatch_id !== undefined) item.rewatch_id = input.rewatch_id;
    if (input.rewatch_status) item.rewatch_status = input.rewatch_status;
    return this.writeRequest('/sync/history', {
      method: 'POST', token, query: { allow_rewatch: 'yes' },
      body: { [mediaKeys[input.mediaType]]: [item] },
    });
  }

  async update(input: RewatchUpdateInput): Promise<any> {
    this.validateId(input.rewatch_id);
    if (input.rewatch_status === 'completed' && input.mediaType !== 'movies') {
      throw new Error('rewatch_status completed can only be set for movies');
    }
    const item = this.toItem(input);
    const token = await this.requireEligiblePlan();
    item.rewatch_id = input.rewatch_id;
    if (input.rewatch_status) item.rewatch_status = input.rewatch_status;
    return this.writeRequest('/sync/history', {
      method: 'POST', token, query: { allow_rewatch: 'yes' },
      body: { [mediaKeys[input.mediaType]]: [item] },
    });
  }

  async list(input: { mediaType: RewatchMediaType; status: string; date_from?: string; initial_sync?: boolean }): Promise<any> {
    if (!input.date_from && !input.initial_sync) throw new Error('date_from is required unless initial_sync is explicitly true');
    if (input.date_from && !Number.isFinite(Date.parse(input.date_from))) throw new Error('date_from must be a valid date');
    const allowedStatuses = ['watching', 'plantowatch', 'hold', 'completed', 'dropped'];
    if (!allowedStatuses.includes(input.status)) throw new Error('invalid watch status');
    return this.client.request(`/sync/all-items/${input.mediaType}/${input.status}`, {
      method: 'GET', token: this.getToken(),
      query: {
        allow_rewatch: 'yes', extended: 'full', episode_watched_at: 'yes',
        date_from: input.date_from,
      },
    });
  }

  async stop(input: { body: Record<string, unknown>; allow_rewatch?: boolean }): Promise<any> {
    const useRewatch = input.allow_rewatch === true;
    if (useRewatch) {
      const progress = input.body.progress;
      if (typeof progress !== 'number' || progress < 80) {
        throw new Error('rewatch opt-in on scrobble stop requires progress of at least 80');
      }
    }
    const token = useRewatch ? await this.requireEligiblePlan() : this.getToken();
    const result = await this.writeRequest('/scrobble/stop', {
      method: 'POST', token,
      ...(useRewatch ? { query: { allow_rewatch: 'yes' } } : {}),
      body: input.body,
    });
    if (useRewatch && hasProRequiredStatus(result)) this.clearEligibility(token);
    return result;
  }

  private async requireEligiblePlan(): Promise<string> {
    const token = this.getToken();
    if (!token) throw new RewatchPlanError('a Simkl account token is required for rewatch tracking');
    for (const [cachedToken, value] of this.eligibility) {
      if (value.expiresAt <= this.now()) this.eligibility.delete(cachedToken);
    }
    const cached = this.eligibility.get(token);
    if (cached && cached.expiresAt > this.now()) {
      if (cached.allowed) {
        if (this.getToken() !== token) throw new RewatchPlanError('Simkl account token changed during rewatch authorization; retry the operation');
        return token;
      }
      throw new RewatchPlanError('rewatch tracking requires a Simkl PRO or VIP account');
    }
    const settings = await this.client.request<any>('/users/settings', { method: 'GET', token });
    if (this.getToken() !== token) throw new RewatchPlanError('Simkl account token changed during rewatch authorization; retry the operation');
    const allowed = ['pro', 'vip'].includes(String(settings?.account?.type ?? '').toLowerCase());
    this.eligibility.set(token, { allowed, expiresAt: this.now() + CACHE_TTL_MS });
    if (!allowed) throw new RewatchPlanError('rewatch tracking requires a Simkl PRO or VIP account');
    return token;
  }

  private clearEligibility(token: string | undefined): void {
    if (token) this.eligibility.delete(token);
  }

  private toItem(input: RewatchItemInput): RewatchItem {
    if (!hasValidMediaIds(input.ids)) throw new Error('at least one valid media identifier is required');
    if (input.watched_at && !Number.isFinite(Date.parse(input.watched_at))) throw new Error('watched_at must be a valid date');
    return {
      ids: input.ids,
      ...(input.watched_at ? { watched_at: input.watched_at } : {}),
      ...(input.seasons ? { seasons: input.seasons } : {}),
    };
  }

  private validateId(id: number): void {
    if (!Number.isInteger(id) || id <= 0) throw new Error('rewatch_id must be a positive integer');
  }
}

function hasProRequiredStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const visit = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    if (Array.isArray(item)) return item.some(visit);
    const record = item as Record<string, unknown>;
    if (record.rewatch_status === 'pro_required') return true;
    return Object.values(record).some(visit);
  };
  return visit(value);
}
