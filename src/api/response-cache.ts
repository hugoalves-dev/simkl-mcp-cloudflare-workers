/** Shared cache policy for public Simkl catalog responses. */
export interface ResponseCachePolicy {
  ttlSeconds: number;
}

export const RESPONSE_CACHE_TTL_SECONDS = {
  catalog: 60 * 60,
  details: 6 * 60 * 60,
  trending: 60 * 60,
} as const;

/**
 * Cache only endpoints whose results are independent of the authenticated user.
 * The complete URL is used as the key so query parameters (including pagination
 * and search filters) remain part of the cache identity.
 */
export function getResponseCachePolicy(url: URL, method: string): ResponseCachePolicy | null {
  if (method.toUpperCase() !== 'GET') return null;

  if (url.hostname === 'data.simkl.in' && /^\/discover\/trending\/(tv|movies|anime)\//.test(url.pathname)) {
    // Simkl says these files may be served from the CDN for an hour. Keep this
    // cache no longer than that, and retain Last-Modified on the stored response.
    return { ttlSeconds: RESPONSE_CACHE_TTL_SECONDS.trending };
  }

  if (url.hostname !== 'api.simkl.com') return null;

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
