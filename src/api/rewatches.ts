import type { RequestOptions, SimklClient } from './client.js';
import { selectRewatches, type RewatchRow } from '../library/rewatches.js';

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

export interface RewatchDeleteInput extends RewatchItemInput {
  rewatch_id: number;
}

export class RewatchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewatchPlanError';
  }
}

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
  private writeRequest: (endpoint: string, options: RewatchWriteOptions) => Promise<any>;

  constructor(
    private readonly client: SimklClient,
    private readonly getToken: () => string | undefined,
    _now: () => number = Date.now, // Retained for standalone constructor compatibility.
    writer?: (endpoint: string, options: RewatchWriteOptions) => Promise<any>,
    private readonly readSettings: (token: string) => Promise<any> =
      token => client.request('/users/settings', { method: 'GET', token }),
    private readonly invalidateSharedSettings?: (token: string) => Promise<void>,
    private readonly readCachedRewatches?: () => Promise<RewatchRow[]>,
  ) {
    void _now;
    this.writeRequest = writer ?? ((endpoint, options) => this.client.request(endpoint, options));
  }

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
    item.is_rewatch = true;
    item.rewatch_id = input.rewatch_id;
    if (input.rewatch_status) item.rewatch_status = input.rewatch_status;
    return this.writeRequest('/sync/history', {
      method: 'POST', token, query: { allow_rewatch: 'yes' },
      body: { [mediaKeys[input.mediaType]]: [item] },
    });
  }

  async delete(input: RewatchDeleteInput): Promise<any> {
    this.validateId(input.rewatch_id);
    if (input.mediaType === 'movies' && input.seasons !== undefined) {
      throw new Error('season and episode removal is only available for shows and anime');
    }
    const item = this.toItem(input);
    const token = await this.requireEligiblePlan();
    item.rewatch_id = input.rewatch_id;
    return this.writeRequest('/sync/history/remove', {
      method: 'POST', token,
      body: { [mediaKeys[input.mediaType]]: [item] },
    });
  }

  async list(input: { mediaType: RewatchMediaType; status: string }): Promise<string> {
    if (!this.readCachedRewatches) throw new Error('Cached rewatch sessions are unavailable');
    const lines = selectRewatches(await this.readCachedRewatches(), input);
    return lines.length ? lines.join('\n') : 'no rewatch sessions matched';
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
    if (useRewatch && hasProRequiredStatus(result) && token && this.invalidateSharedSettings) {
      try { await this.invalidateSharedSettings(token); }
      catch {
        // A successful upstream write must never be retried because cache invalidation failed.
        console.warn(JSON.stringify({ component: 'simkl_rewatch', event: 'settings_invalidation_failed' }));
      }
    }
    return result;
  }

  private async requireEligiblePlan(): Promise<string> {
    const token = this.getToken();
    if (!token) throw new RewatchPlanError('a Simkl account token is required for rewatch tracking');
    const settings = await this.readSettings(token);
    if (this.getToken() !== token) throw new RewatchPlanError('Simkl account token changed during rewatch authorization; retry the operation');
    const allowed = ['pro', 'vip'].includes(String(settings?.account?.type ?? '').toLowerCase());
    console.info(JSON.stringify({ component: 'simkl_rewatch', event: 'plan_checked', eligible: allowed }));
    if (!allowed) throw new RewatchPlanError('rewatch tracking requires a Simkl PRO or VIP account');
    return token;
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
