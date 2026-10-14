// simkl api http client

import { APP_NAME, APP_VERSION, USER_AGENT } from '../app-info';
import { createResponseCacheKey, getResponseCachePolicy, isSupportedCdnFile } from './response-cache';

const MAX_SERVER_RETRIES = 2;
const SERVER_RETRY_BASE_DELAY_MS = 100;
const RATE_LIMIT_RETRY_DELAY_MS = 1000;
const CDN_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

export interface SimklClientOptions {
  baseUrl: string;
  clientId: string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  token?: string;
  authorization?: 'bearer' | 'none';
  redirect?: 'follow' | 'error' | 'manual';
  responseProfile?: 'library';
  rateLimitRetry?: boolean;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
  fetchAllPages?: boolean;
  maxPages?: number;
  requireComplete?: boolean;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  pageCount: number;
  itemCount: number;
}

export interface PaginatedResult<T> {
  data: T;
  pagination: PaginationInfo | null;
}

export interface SimklResponseHeaders {
  rateLimitLimit?: string;
  rateLimitRemaining?: string;
  retryAfter?: string;
  lastModified?: string;
}

interface RequestResult<T> extends PaginatedResult<T> {
  headers: SimklResponseHeaders;
}

export class SimklClient {
  private baseUrl: string;
  private clientId: string;

  constructor(options: SimklClientOptions) {
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
  }

  async request<T = unknown>(endpoint: string, options: RequestOptions): Promise<T> {
    const { data } = await this.doRequest<T>(endpoint, options);
    return data;
  }

  async requestWithMetadata<T = unknown>(endpoint: string, options: RequestOptions): Promise<{ data: T; headers: SimklResponseHeaders }> {
    const { data, headers } = await this.doRequest<T>(endpoint, options);
    return { data, headers };
  }

  async requestPaginated<T = unknown>(
    endpoint: string,
    options: RequestOptions & { pagination?: PaginationOptions }
  ): Promise<PaginatedResult<T>> {
    const { pagination: paginationOptions, ...baseOptions } = options;
    const baseQuery: Record<string, string | number | undefined> = {
      ...baseOptions.query,
    };

    if (paginationOptions?.page !== undefined) {
      baseQuery.page = paginationOptions.page;
    }

    if (paginationOptions?.limit !== undefined) {
      baseQuery.limit = paginationOptions.limit;
    }

    const firstPage = await this.doRequest<T>(endpoint, { ...baseOptions, query: baseQuery }, paginationOptions?.requireComplete);
    const firstPagination = firstPage.pagination;

    if (!paginationOptions?.fetchAllPages || !firstPagination) {
      return firstPage;
    }

    if (!Array.isArray(firstPage.data)) {
      throw new SimklApiError('simkl api error: fetchAllPages requires array response', 0, null);
    }

    const items = [...firstPage.data];
    const maxPages = paginationOptions.maxPages ?? firstPagination.pageCount;
    const lastPage = Math.min(maxPages, firstPagination.pageCount);

    for (let page = firstPagination.page + 1; page <= lastPage; page++) {
      const query = { ...baseQuery, page };
      const nextPage = await this.doRequest<T>(endpoint, { ...baseOptions, query }, paginationOptions?.requireComplete);
      if (!Array.isArray(nextPage.data)) {
        throw new SimklApiError('simkl api error: fetchAllPages requires array response', 0, null);
      }
      items.push(...nextPage.data);
    }

    return {
      data: items as unknown as T,
      pagination: {
        ...firstPagination,
        pageCount: lastPage,
      },
    };
  }

  private async doRequest<T = unknown>(endpoint: string, options: RequestOptions, strictPagination = false): Promise<RequestResult<T>> {
    const url = this.buildUrl(endpoint, options.query);
    const requestUrl = new URL(url);
    const isPublicCdn = requestUrl.origin === 'https://data.simkl.in';
    // CDN responses are shared; never forward credentials in headers or URL parameters.
    if (isPublicCdn && (
      requestUrl.username || requestUrl.password ||
      [...requestUrl.searchParams.keys()].some(key => /^(?:access_token|refresh_token|authorization|token)$/i.test(key))
    )) {
      throw new SimklApiError('simkl api error: CDN requests cannot include credentials', 0, null);
    }
    const authorization = isPublicCdn ? 'none' : options.authorization;
    const headers = this.buildHeaders(options.token, authorization);

    const init: RequestInit = {
      method: options.method,
      headers,
      redirect: options.redirect,
    };

    if (options.body && options.method !== 'GET') {
      init.body = JSON.stringify(options.body);
    }

    const cachePolicy = getResponseCachePolicy(requestUrl, options.method);
    const cache = cachePolicy && typeof caches !== 'undefined' ? caches.default : undefined;
    const cacheKey = cache && cachePolicy ? createResponseCacheKey(requestUrl) : undefined;

    let response: Response | undefined;
    if (cache && cacheKey) {
      try {
        response = await cache.match(cacheKey);
      } catch {
        // Cache failures should not make the upstream API unavailable.
      }
    }

    if (!response) {
      let serverRetries = 0;
      let rateLimitRetried = false;
      while (true) {
        try {
          response = await fetch(url, init);
        } catch {
          // A failed connection does not tell us whether a write reached Simkl.
          throw new SimklApiError('simkl api request failed', 0, null);
        }

        if (response.status === 429) {
          const responseText = await this.readResponseBody(response);
          const error = new SimklApiError(
            `simkl api error: ${response.status} ${response.statusText}`,
            response.status,
            responseText,
            this.parseResponseHeaders(response)
          );
          if (options.rateLimitRetry !== false && error.upstreamCode === 'rate_limit' && !rateLimitRetried) {
            rateLimitRetried = true;
            await this.delay(RATE_LIMIT_RETRY_DELAY_MS);
            continue;
          }
          throw error;
        }

        if (response.status >= 500 && serverRetries < MAX_SERVER_RETRIES) {
          await this.delay(SERVER_RETRY_BASE_DELAY_MS * (2 ** serverRetries));
          serverRetries++;
          continue;
        }
        break;
      }

    }
    const responseHeaders = this.parseResponseHeaders(response);

    if (response.status === 204) {
      return { data: {} as T, pagination: null, headers: responseHeaders };
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location') || response.headers.get('location');
      return { data: { redirectUrl: location } as T, pagination: null, headers: responseHeaders };
    }

    let responseText: string;
    try {
      const libraryResponse = response.ok && options.method === 'GET'
        && options.responseProfile === 'library'
        && /^\/sync\/(all-items|ratings)(\/(shows|movies|anime)(\/(watching|plantowatch|hold|completed|dropped))?)?$/.test(endpoint);
      const responseLimit = libraryResponse ? 16 * 1024 * 1024
        : response.ok && options.method === 'GET' && isSupportedCdnFile(requestUrl)
          ? CDN_RESPONSE_LIMIT_BYTES
          : 2 * 1024 * 1024;
      responseText = await this.readResponseBody(response, responseLimit);
    } catch (error) {
      if (error instanceof SimklApiError) throw error;
      throw new SimklApiError('simkl api error: response body read failed', response.status, null, responseHeaders);
    }

    if (!response.ok) {
      throw new SimklApiError(
        `simkl api error: ${response.status} ${response.statusText}`,
        response.status,
        responseText,
        responseHeaders
      );
    }

    if (!responseText) {
      return { data: null as T, pagination: this.parsePaginationInfo(response, strictPagination), headers: responseHeaders };
    }

    try {
      const data = JSON.parse(responseText);
      // Cache only a successfully bounded, valid JSON response. Never cache an oversized body.
      if (cache && cacheKey && cachePolicy && response.ok) {
        const cacheHeaders = new Headers(response.headers);
        // The body was decoded and re-serialized; original compression/length headers
        // must not describe the new response or cached reads may be corrupted.
        cacheHeaders.delete('Content-Encoding');
        cacheHeaders.delete('Content-Length');
        cacheHeaders.set('Cache-Control', `public, max-age=${cachePolicy.ttlSeconds}`);
        try {
          await cache.put(cacheKey, new Response(responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: cacheHeaders,
          }));
        } catch {
          // Cache writes are best-effort; return the successful upstream response.
        }
      }
      return {
        data,
        pagination: this.parsePaginationInfo(response, strictPagination),
        headers: responseHeaders,
      };
    } catch {
      throw new SimklApiError('simkl api error: invalid json response', response.status, responseText);
    }
  }

  private buildUrl(endpoint: string, query?: Record<string, string | number | undefined>): string {
    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(endpoint);
    const url = isAbsolute
      ? new URL(endpoint)
      : new URL(endpoint.startsWith('/') ? endpoint : `/${endpoint}`, this.baseUrl);

    if (isAbsolute && url.protocol !== 'https:') {
      throw new SimklApiError('simkl api error: absolute endpoint must use HTTPS', 0, null);
    }

    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('app-name', APP_NAME);
    url.searchParams.set('app-version', APP_VERSION);

    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined) return;
        url.searchParams.set(key, String(value));
      });
    }

    return url.toString();
  }

  private buildHeaders(token?: string, authorization: RequestOptions['authorization'] = 'bearer'): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };

    if (authorization === 'bearer' && token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  private async readResponseBody(response: Response, limit = 2 * 1024 * 1024): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > limit) {
        throw new SimklApiError('simkl api error: response too large', response.status, text.slice(0, 1024));
      }
      return text;
    }

    const decoder = new TextDecoder();
    let result = '';
    let bytesRead = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > limit) {
          reader.cancel().catch(() => {});
          throw new SimklApiError('simkl api error: response too large', response.status, result.slice(0, 1024));
        }
        result += decoder.decode(value, { stream: true });
      }

      result += decoder.decode();
      return result;
    } finally {
      reader.releaseLock();
    }
  }

  private parseResponseHeaders(response: Response): SimklResponseHeaders {
    const headers: SimklResponseHeaders = {};
    const values: Array<[keyof SimklResponseHeaders, string]> = [
      ['rateLimitLimit', 'X-RateLimit-Limit'],
      ['rateLimitRemaining', 'X-RateLimit-Remaining'],
      ['retryAfter', 'Retry-After'],
      ['lastModified', 'Last-Modified'],
    ];
    for (const [property, name] of values) {
      const value = response.headers.get(name);
      if (value !== null) headers[property] = value;
    }
    return headers;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private parsePaginationInfo(response: Response, strict = false): PaginationInfo | null {
    const page = this.parsePaginationHeader(response, 'X-Pagination-Page', strict);
    const limit = this.parsePaginationHeader(response, 'X-Pagination-Limit', strict);
    const pageCount = this.parsePaginationHeader(response, 'X-Pagination-Page-Count', strict);
    const itemCount = this.parsePaginationHeader(response, 'X-Pagination-Item-Count', strict);

    if (
      page === null ||
      limit === null ||
      pageCount === null ||
      itemCount === null
    ) {
      if (strict && ['Page', 'Limit', 'Page-Count', 'Item-Count'].some(name => response.headers.has(`X-Pagination-${name}`))) throw new SimklApiError('simkl api error: incomplete or invalid pagination', response.status, null);
      return null;
    }
    if (strict && (page < 1 || limit < 1 || pageCount < page || itemCount < 0)) throw new SimklApiError('simkl api error: invalid pagination values', response.status, null);
    return { page, limit, pageCount, itemCount };
  }

  private parsePaginationHeader(response: Response, name: string, strict = false): number | null {
    const value = response.headers.get(name) || response.headers.get(name.toLowerCase());
    if (!value) return null;
    if (strict && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
}

export class SimklApiError extends Error {
  public upstreamCode: string;

  constructor(
    message: string,
    public statusCode: number,
    responseBody: string | null,
    public headers: SimklResponseHeaders = {}
  ) {
    super(message);
    this.name = 'SimklApiError';
    let code = '';
    try {
      const parsed = JSON.parse(responseBody || '') as { error?: unknown };
      if (typeof parsed.error === 'string' && ['rate_limit', 'user_limit_exceeded', 'app_limit_exceeded', 'user_token_required', 'max_items'].includes(parsed.error)) {
        code = parsed.error;
      }
    } catch {
      // Keep the raw upstream response out of the error object.
    }
    this.upstreamCode = code;
  }
}
