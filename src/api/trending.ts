import { addSimklItemLinks } from '../format/media';

export type SimklMediaType = 'tv' | 'movies' | 'anime';
export type SimklTrendingInterval = 'today' | 'week' | 'month' | 'daily' | 'weekly' | 'monthly';

export interface SimklGenre {
  name: string;
  slug: string;
  count: number;
}

export interface GenreTrendingClient {
  requestWithMetadata<T = unknown>(endpoint: string, options: {
    method: 'GET';
    authorization: 'none';
  }): Promise<{ data: T; headers: { lastModified?: string } }>;
}

export class SimklGenreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimklGenreInputError';
  }
}

const timeframeByInterval: Record<SimklTrendingInterval, string> = {
  today: 'today',
  week: 'week',
  month: 'month',
  daily: 'today',
  weekly: 'week',
  monthly: 'month',
};

export function simklTrendingPath(type: SimklMediaType, interval: SimklTrendingInterval): string {
  return `https://data.simkl.in/discover/trending/${type}/${timeframeByInterval[interval]}_100.json`;
}

export async function getTrendingByGenre(
  client: GenreTrendingClient,
  type: SimklMediaType,
  genreSlug: string,
  maxResults = 20,
) {
  if (!['tv', 'movies', 'anime'].includes(type)) {
    throw new SimklGenreInputError('Unsupported media type. Choose tv, movies, or anime.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(genreSlug)) {
    throw new SimklGenreInputError('Invalid genre slug. Use a slug from the selected media type genre index.');
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new SimklGenreInputError('maxResults must be an integer from 1 to 100.');
  }

  const base = `https://data.simkl.in/discover/trending/${type}/genre`;
  const index = await client.requestWithMetadata<SimklGenre[]>(`${base}/index.json`, {
    method: 'GET', authorization: 'none',
  });
  const genre = Array.isArray(index.data)
    ? index.data.find(entry => entry.slug === genreSlug)
    : undefined;
  if (!genre) {
    throw new SimklGenreInputError(`Genre slug not available for ${type}. Choose a slug from that type's genre index.`);
  }

  const file = await client.requestWithMetadata<any[]>(`${base}/${genre.slug}_month_500.json`, {
    method: 'GET', authorization: 'none',
  });
  const items = Array.isArray(file.data) ? file.data : [];
  return {
    type,
    period: 'month',
    updatedAt: file.headers.lastModified ?? null,
    genre,
    total: items.length,
    returned: Math.min(items.length, maxResults),
    results: addSimklItemLinks(items.slice(0, maxResults), type),
  };
}
