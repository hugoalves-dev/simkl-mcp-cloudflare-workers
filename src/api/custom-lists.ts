import { SimklApiError, type SimklResponseHeaders } from './client.js';
import { toMcpErrorResult } from './errors.js';
import { hasValidMediaIds } from './rewatches.js';

/** Custom Lists endpoints are AUTH V2 + PRO/VIP and are never cached or polled. */
export type CustomListMethod = 'GET' | 'POST' | 'DELETE';

export interface CustomListRequestOptions {
  method: CustomListMethod;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface CustomListResponse {
  data: unknown;
  headers: SimklResponseHeaders;
}

export type CustomListRequester = (path: string, options: CustomListRequestOptions) => Promise<CustomListResponse>;

const LIST_ROUTES: Array<{ method: CustomListMethod; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/lists\/user\/[1-9]\d*$/ },
  { method: 'GET', pattern: /^\/lists\/[1-9]\d*$/ },
  { method: 'POST', pattern: /^\/lists$/ },
  { method: 'POST', pattern: /^\/lists\/[1-9]\d*$/ },
  { method: 'DELETE', pattern: /^\/lists\/[1-9]\d*$/ },
  { method: 'POST', pattern: /^\/lists\/[1-9]\d*\/items(?:\/remove)?$/ },
  { method: 'POST', pattern: /^\/lists\/favorites(?:\/remove)?$/ },
];

/** Only the nine documented Custom Lists routes may be called through the list queue. */
export function isCustomListRoute(path: string, method: CustomListMethod): boolean {
  return LIST_ROUTES.some(route => route.method === method && route.pattern.test(path));
}

export class CustomListInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomListInputError';
  }
}

/** A free account gets HTTP 200 with `{ error: 'premium_only' }` on list reads, not list data. */
export class CustomListPremiumError extends Error {
  constructor() {
    super('Simkl Custom Lists require a Simkl PRO or VIP account. Simkl returned its upgrade placeholder instead of list data, so no list contents were read. (For free or anonymous callers, a missing list ID returns the same placeholder.)');
    this.name = 'CustomListPremiumError';
  }
}

export class CustomListUnexpectedBodyError extends Error {
  constructor(readonly upstreamError: string) {
    super(`Simkl returned an error body (${upstreamError}) instead of list data.`);
    this.name = 'CustomListUnexpectedBodyError';
  }
}

export class CustomListScopeError extends Error {
  constructor() {
    super('This Simkl session was not granted the media:write scope, so Custom List changes are refused locally. Reconnect your Simkl account and grant write access; no request was sent.');
    this.name = 'CustomListScopeError';
  }
}

/** Raised while this account is inside a Simkl `429 user_limit_exceeded` Retry-After window. */
export class CustomListCooldownError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`This Simkl account reached its AUTH V2 daily allowance. Custom List requests are paused for this account for about ${retryAfterSeconds} more seconds (Retry-After); no request was sent. Manage Connected Apps: https://simkl.com/settings/apps`);
    this.name = 'CustomListCooldownError';
  }
}

const MAX_COOLDOWN_SECONDS = 36 * 60 * 60;

/** Retry-After as seconds or an HTTP date; without one, wait for the New York midnight reset. */
export function customListCooldownSeconds(retryAfter: string | undefined, now: number): number {
  const value = retryAfter?.trim();
  let seconds: number | undefined;
  if (value && /^\d+$/.test(value)) seconds = Number(value);
  else if (value && Number.isFinite(Date.parse(value))) seconds = Math.ceil((Date.parse(value) - now) / 1000);
  if (seconds === undefined || !Number.isFinite(seconds)) seconds = secondsUntilNewYorkMidnight(now);
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(1, seconds));
}

function secondsUntilNewYorkMidnight(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find(entry => entry.type === type)?.value ?? 0);
  const elapsed = part('hour') * 3600 + part('minute') * 60 + part('second');
  return Math.max(60, 86_400 - elapsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check for an `error` key on a 200 before treating the body as list data. */
function assertListPayload(data: unknown): Record<string, unknown> {
  if (isRecord(data) && data.error !== undefined && data.error !== null) {
    if (data.error === 'premium_only') throw new CustomListPremiumError();
    throw new CustomListUnexpectedBodyError(typeof data.error === 'string' && /^[a-z_]{1,40}$/i.test(data.error) ? data.error : 'unknown');
  }
  if (!isRecord(data)) throw new CustomListUnexpectedBodyError('invalid_body');
  return data;
}

function positiveId(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CustomListInputError(`${name} must be a positive integer`);
  return value as number;
}

/** Supported write ID keys; `slug` is response-only and must never be sent. */
const WRITE_ID_KEYS = new Set([
  'simkl', 'simkl_id', 'imdb', 'tmdb', 'tvdb', 'mal', 'anidb', 'anilist', 'kitsu', 'livechart',
  'anisearch', 'animeplanet', 'netflix', 'letterboxd', 'traktslug', 'crunchyroll', 'hulu',
]);

export interface CustomListItemInput {
  ids?: Record<string, string | number>;
  title?: string;
  year?: number;
  note?: { public?: string; private?: string };
  user_position?: number;
  season?: number;
  seasons?: Array<{ number: number }>;
}

export interface CustomListItemsInput {
  movies?: CustomListItemInput[];
  shows?: CustomListItemInput[];
  anime?: CustomListItemInput[];
}

const MAX_ITEMS_PER_REQUEST = 1000;

function itemsBody(input: CustomListItemsInput): Record<string, CustomListItemInput[]> {
  const body: Record<string, CustomListItemInput[]> = {};
  let count = 0;
  for (const key of ['movies', 'shows', 'anime'] as const) {
    const items = input[key];
    if (items === undefined) continue;
    items.forEach((item, index) => {
      const ids = item.ids;
      if (ids) {
        if ('slug' in ids) throw new CustomListInputError(`${key}[${index}].ids.slug is response-only; send a supported ID such as simkl, imdb or tmdb`);
        const unknown = Object.keys(ids).filter(name => !WRITE_ID_KEYS.has(name));
        if (unknown.length) throw new CustomListInputError(`${key}[${index}].ids has unsupported keys: ${unknown.join(', ')}`);
      }
      const simklId = ids?.simkl_id;
      const usableIds = ids && (hasValidMediaIds(ids) || (Number.isSafeInteger(simklId) && (simklId as number) > 0));
      if (!usableIds && !(typeof item.title === 'string' && item.title.trim())) {
        throw new CustomListInputError(`${key}[${index}] needs a supported ID or a title`);
      }
      if (key !== 'anime' && (item.season !== undefined || item.seasons !== undefined)) {
        throw new CustomListInputError(`${key}[${index}]: season and seasons apply to anime only`);
      }
    });
    count += items.length;
    if (items.length) body[key] = items;
  }
  if (count === 0) throw new CustomListInputError('Send at least one title in movies, shows or anime');
  if (count > MAX_ITEMS_PER_REQUEST) throw new CustomListInputError(`At most ${MAX_ITEMS_PER_REQUEST} titles per request`);
  return body;
}

export interface CustomListDetailsInput {
  name?: string;
  privacy?: 'public' | 'unlisted' | 'private';
  description?: { short?: string; full?: string };
  note?: string;
  display_number?: boolean;
  sort?: { by: string; direction?: 'asc' | 'desc' };
  tags?: string[];
  private_tags?: string[];
  collaborators?: Array<{ user: number; permissions?: string[] }>;
}

/** Partial edits: only keys the caller supplied are sent; omitted keys are left unchanged upstream. */
function detailsBody(input: CustomListDetailsInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ['name', 'privacy', 'description', 'note', 'display_number', 'tags', 'private_tags', 'collaborators'] as const) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (input.sort !== undefined) {
    body.sort = input.sort.direction ? [input.sort.by, input.sort.direction] : [input.sort.by];
  }
  return body;
}

export interface CustomListPageInput {
  page?: number;
  limit?: number;
  direction?: 'asc' | 'desc';
}

export class CustomListsService {
  constructor(
    private readonly request: CustomListRequester,
    private readonly accountId: () => Promise<string>,
  ) {}

  async listUserLists(input: CustomListPageInput & {
    user_id?: number;
    sort?: string;
    followed?: boolean;
    collaborants?: boolean;
  }): Promise<Record<string, unknown>> {
    const userId = input.user_id === undefined ? await this.accountId() : String(positiveId(input.user_id, 'user_id'));
    if (!/^[1-9]\d*$/.test(userId)) throw new CustomListInputError('Unable to resolve the Simkl account ID');
    const { data } = await this.request(`/lists/user/${userId}`, {
      method: 'GET',
      query: {
        page: input.page, limit: input.limit, sort: input.sort, direction: input.direction,
        followed: input.followed ? 'true' : undefined,
        collaborants: input.collaborants ? 'true' : undefined,
      },
    });
    const payload = assertListPayload(data);
    if (!Array.isArray(payload.lists)) throw new CustomListUnexpectedBodyError('missing_lists');
    return payload;
  }

  async getList(input: CustomListPageInput & { list_id: number; sort?: string; extended?: boolean }): Promise<Record<string, unknown>> {
    const id = positiveId(input.list_id, 'list_id');
    const { data } = await this.request(`/lists/${id}`, {
      method: 'GET',
      query: {
        page: input.page, limit: input.limit, sort: input.sort, direction: input.direction,
        extended: input.extended ? 'full' : undefined,
      },
    });
    const payload = assertListPayload(data);
    if (payload.items !== undefined && !Array.isArray(payload.items)) throw new CustomListUnexpectedBodyError('invalid_items');
    return payload;
  }

  async createList(input: CustomListDetailsInput & { name: string; media_type: 'movies' | 'tv' | 'anime' }): Promise<unknown> {
    if (!input.name.trim()) throw new CustomListInputError('name must not be empty');
    const body = { ...detailsBody(input), media_type: input.media_type };
    return (await this.request('/lists', { method: 'POST', body })).data;
  }

  async updateList(input: CustomListDetailsInput & { list_id: number }): Promise<unknown> {
    const id = positiveId(input.list_id, 'list_id');
    const body = detailsBody(input);
    if (Object.keys(body).length === 0) throw new CustomListInputError('Send at least one field to change; omitted fields are kept as they are');
    return (await this.request(`/lists/${id}`, { method: 'POST', body })).data;
  }

  async deleteList(input: { list_id: number }): Promise<Record<string, unknown>> {
    const id = positiveId(input.list_id, 'list_id');
    await this.request(`/lists/${id}`, { method: 'DELETE' });
    return { deleted: true, list_id: id };
  }

  async addItems(input: CustomListItemsInput & { list_id: number; allow_reorder?: boolean }): Promise<unknown> {
    const id = positiveId(input.list_id, 'list_id');
    return (await this.request(`/lists/${id}/items`, {
      method: 'POST', body: itemsBody(input), query: { allow_reorder: input.allow_reorder ? 'yes' : undefined },
    })).data;
  }

  async removeItems(input: CustomListItemsInput & { list_id: number }): Promise<unknown> {
    const id = positiveId(input.list_id, 'list_id');
    return (await this.request(`/lists/${id}/items/remove`, { method: 'POST', body: itemsBody(input) })).data;
  }

  async addFavorites(input: CustomListItemsInput & { allow_reorder?: boolean }): Promise<unknown> {
    return (await this.request('/lists/favorites', {
      method: 'POST', body: itemsBody(input), query: { allow_reorder: input.allow_reorder ? 'yes' : undefined },
    })).data;
  }

  async removeFavorites(input: CustomListItemsInput): Promise<unknown> {
    return (await this.request('/lists/favorites/remove', { method: 'POST', body: itemsBody(input) })).data;
  }
}

type McpErrorResult = ReturnType<typeof toMcpErrorResult>;

function text(message: string): McpErrorResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** List-specific wording first; anything else falls back to the shared mapping. */
export function customListErrorResult(error: unknown, mutation: boolean): McpErrorResult {
  if (error instanceof CustomListInputError || error instanceof CustomListPremiumError
    || error instanceof CustomListScopeError || error instanceof CustomListCooldownError
    || error instanceof CustomListUnexpectedBodyError) {
    return text(error.message);
  }
  if (!(error instanceof SimklApiError)) return toMcpErrorResult(error);

  if (mutation && error.writeMayHaveSucceeded) {
    return text('The Simkl list change may have been applied despite the upstream failure. It was not retried automatically. Read the list with simkl_get_custom_list before trying again to avoid duplicate or out-of-order changes.');
  }
  const { statusCode: status, upstreamCode: code } = error;
  const messages: Record<string, string> = {
    '403:premium_only': 'Simkl Custom List changes require a Simkl PRO or VIP account (adding collaborators requires VIP).',
    '403:private_list': 'This list is private and this account is neither its owner nor a collaborator.',
    '403:no_access': 'This account lacks the collaborator permission needed for this list change. Nothing was changed.',
    '403:max_lists': 'The account reached its plan limit for custom lists (30 on PRO, 1,000 on VIP). Nothing was created.',
    '403:max_items': 'The list owner reached the per-list title limit (2,000 on PRO, 10,000 on VIP). Nothing was added.',
    '403:max_items_total': 'The list owner reached the total title limit across all lists. Nothing was added.',
    '400:list_error': 'Simkl refused this change for this kind of list (favorite, recommendation or auto list). Nothing was changed.',
    '400:wrong_parameter': 'Simkl rejected a parameter or body field. Nothing was changed.',
    '400:empty_field': 'Simkl rejected the request because a required field was empty. Nothing was changed.',
    '400:rate_limit': 'Another Custom List write for this account is still running on Simkl ("your lists are being updated"). Nothing was changed; retry in about a minute.',
    '404:url_failed': 'Simkl list not found.',
  };
  const message = messages[`${status}:${code}`];
  return message ? text(message) : toMcpErrorResult(error);
}
