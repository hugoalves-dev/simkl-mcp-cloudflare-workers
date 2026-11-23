import { withSimklItemLink } from '../format/media';
import {
  idResolutionKey, SimklRedirectGuardUnavailableError,
  type RedirectGuard, type ResolvedSimklId, type SimklDetailType,
} from './id-resolution';

export type { SimklDetailType } from './id-resolution';

interface SimklRedirectResult {
  redirectUrl?: string | null;
}

export class SimklIdLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimklIdLookupError';
  }
}

const idKeys = [
  'simkl', 'hulu', 'netflix', 'mal', 'tvdb', 'tmdb', 'imdb', 'anidb', 'crunchyroll',
  'anilist', 'kitsu', 'livechart', 'anisearch', 'animeplanet', 'anfo', 'ann', 'tvcom',
  'zap2it', 'traktslug', 'letterboxd', 'boxd', 'mdl',
] as const;

const numericIdKeys = new Set([
  'simkl', 'hulu', 'netflix', 'mal', 'tmdb', 'anidb', 'anilist', 'kitsu', 'livechart', 'anisearch', 'ann',
]);

export function parseSimklRedirect(location?: string | null): { type: SimklDetailType; id: number } | null {
  if (!location) return null;

  let url: URL;
  try {
    url = new URL(location.startsWith('//') ? `https:${location}` : location);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || !['simkl.com', 'www.simkl.com'].includes(url.hostname.toLowerCase())) {
    return null;
  }

  const match = /^\/(movies|tv|anime)\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match) return null;

  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { type: match[1] as SimklDetailType, id };
}

export async function getMediaById(
  client: {
    request<T = unknown>(path: string, options: Record<string, unknown>): Promise<T>;
  },
  args: Record<string, unknown>,
  guard?: RedirectGuard,
): Promise<unknown> {
  const query: Record<string, string | number> = {};
  let hasLookupValue = false;

  for (const key of idKeys) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;

    if (numericIdKeys.has(key)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new SimklIdLookupError(`Invalid ${key} ID`);
      }
    } else if (typeof value !== 'string' || !value.trim()) {
      throw new SimklIdLookupError(`Invalid ${key} ID`);
    }

    if (key === 'imdb' && !/^tt\d+$/.test(String(value))) {
      throw new SimklIdLookupError('Invalid imdb ID');
    }

    query[key] = value as string | number;
    hasLookupValue = true;
  }

  if (typeof args.title === 'string' && args.title.trim()) {
    query.title = args.title.trim();
    hasLookupValue = true;
  }

  if (!hasLookupValue) {
    throw new SimklIdLookupError('Provide at least one supported ID or a title');
  }

  if (args.year !== undefined) {
    if (typeof args.year !== 'number' || !Number.isInteger(args.year) || args.year < 1800 || args.year > 3000) {
      throw new SimklIdLookupError('Invalid year');
    }
    query.year = args.year;
  }

  if (args.type !== undefined) {
    if (!['show', 'tv', 'movie', 'anime'].includes(String(args.type))) {
      throw new SimklIdLookupError('Invalid media type');
    }
    query.type = String(args.type);
  }

  if (query.tmdb !== undefined && !['tv', 'movie'].includes(String(query.type))) {
    throw new SimklIdLookupError('A type is required for TMDB IDs');
  }

  for (const key of ['season', 'episode'] as const) {
    const value = args[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new SimklIdLookupError(`Invalid ${key}`);
      }
      query[key] = value;
    }
  }

  const resolved = await resolveSimklId(client, query, guard);
  const detail = await client.request<any>(`/${resolved.type}/${resolved.id}`, {
    method: 'GET',
    authorization: 'none',
  });
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return detail;
  return withSimklItemLink(detail, resolved.type, resolved.id, resolved.slug);
}

const directDetailTypes: Record<string, SimklDetailType> = { movie: 'movies', tv: 'tv', anime: 'anime' };

async function resolveSimklId(
  client: { request<T = unknown>(path: string, options: Record<string, unknown>): Promise<T> },
  query: Record<string, string | number>,
  guard: RedirectGuard | undefined,
): Promise<ResolvedSimklId> {
  // A Simkl ID with a concrete type needs no resolution at all.
  const directType = directDetailTypes[String(query.type)];
  if (typeof query.simkl === 'number' && directType) return { type: directType, id: query.simkl };

  if (!guard) throw new SimklRedirectGuardUnavailableError();
  const key = await idResolutionKey(query);
  const cached = await guard.lookup(key);
  if (cached) return cached;

  // No /search/id fallback: that would only bypass the /redirect budget.
  const redirect = await client.request<SimklRedirectResult>('/redirect', {
    method: 'GET',
    authorization: 'none',
    redirect: 'manual',
    query: { to: 'simkl', ...query },
    beforeAttempt: () => guard.reserve(),
  });
  const parsed = parseSimklRedirect(redirect?.redirectUrl);
  if (!parsed) throw new SimklIdLookupError('No matching Simkl title was found');

  const resolved: ResolvedSimklId = { ...parsed, ...redirectSlug(redirect?.redirectUrl) };
  await guard.store(key, resolved);
  return resolved;
}

function redirectSlug(location?: string | null): { slug?: string } {
  if (!location) return {};
  try {
    const raw = new URL(location.startsWith('//') ? `https:${location}` : location).pathname.split('/')[3];
    const slug = raw ? decodeURIComponent(raw) : '';
    return slug && slug.length <= 512 ? { slug } : {};
  } catch {
    return {};
  }
}
