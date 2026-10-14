/** Shared cache policy for public Simkl catalog and CDN responses. */
export interface ResponseCachePolicy {
  ttlSeconds: number;
}

export const RESPONSE_CACHE_TTL_SECONDS = {
  catalog: 60 * 60,
  details: 6 * 60 * 60,
  trending: 60 * 60,
  calendar: 60 * 60,
} as const;

/** Only known public JSON files receive the larger CDN response allowance. */
export function isSupportedCdnFile(url: URL): boolean {
  if (url.origin !== 'https://data.simkl.in') return false;

  return /^\/calendar\/v2\/(?:(?:\d{4})\/(?:[1-9]|1[0-2])\/)?(?:tv|anime|movie_release)\.json$/.test(url.pathname)
    || /^\/discover\/trending\/(?:tv|movies|anime)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.json$/.test(url.pathname);
}

/**
 * Cache only endpoints whose results are independent of the authenticated user.
 * The complete URL is used as the key so query parameters (including pagination
 * and search filters) remain part of the cache identity.
 */
export function getResponseCachePolicy(url: URL, method: string): ResponseCachePolicy | null {
  if (method.toUpperCase() !== 'GET') return null;

  if (isSupportedCdnFile(url)) {
    // Simkl public JSON files are cached for at most one hour.
    return { ttlSeconds: url.pathname.startsWith('/calendar/v2/')
      ? RESPONSE_CACHE_TTL_SECONDS.calendar
      : RESPONSE_CACHE_TTL_SECONDS.trending };
  }

  if (url.origin !== 'https://api.simkl.com') return null;

  const path = url.pathname;
  if (
    /^\/search(?:\/(?:tv|movies|anime|id))?$/.test(path) ||
    /^\/(?:tv|anime)\/best\//.test(path) ||
    /^\/(?:tv|anime|movies)\/genres\//.test(path)
  ) {
    return { ttlSeconds: RESPONSE_CACHE_TTL_SECONDS.catalog };
  }

  if (/^\/(?:tv|movies|anime)\/\d+$/.test(path) || /^\/(?:tv|anime)\/episodes\/[^/]+$/.test(path)) {
    return { ttlSeconds: RESPONSE_CACHE_TTL_SECONDS.details };
  }

  return null;
}

/** Cache API keys contain only the full request URL and method, never headers. */
export function createResponseCacheKey(url: URL): Request {
  return new Request(url.toString(), { method: 'GET' });
}
