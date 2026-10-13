// plain-text formatters for simkl media items returned by list endpoints

export interface MediaItem {
  title?: string;
  year?: number;
  date?: string;
  ids?: { simkl_id?: number; simkl?: number; imdb?: string; slug?: string };
  ratings?: { simkl?: { rating?: number } };
  episode?: { episode?: number };
}

export type SimklMediaType = 'tv' | 'movies' | 'anime';
export type ItemFormatter = (item: MediaItem, index: number, type?: SimklMediaType) => string;

const DEFAULT_LIMIT = 20;

export function simklItemUrl(type: SimklMediaType, id: string | number | undefined, slug?: string): string | undefined {
  if (id === undefined || id === null || String(id) === '') return undefined;
  const base = `https://simkl.com/${type}/${encodeURIComponent(String(id))}`;
  const safeSlug = typeof slug === 'string' && slug.trim() ? slug : undefined;
  return safeSlug ? `${base}/${encodeURIComponent(safeSlug)}` : base;
}

export function addSimklItemLinks<T extends MediaItem>(items: T[], type: SimklMediaType): Array<T & { simkl_url?: string }> {
  return items.map(item => withSimklItemLink(item, type));
}

export function withSimklItemLink<T extends MediaItem>(item: T, type: SimklMediaType, fallbackId?: string | number, fallbackSlug?: string): T & { simkl_url?: string } {
  const url = simklItemUrl(type, simklId(item) ?? fallbackId, item.ids?.slug ?? fallbackSlug);
  return { ...item, ...(url ? { simkl_url: url } : {}) };
}

// `[SIMKL #1](https://simkl.com/tv/1) - Dune (2021)`
export const formatItem: ItemFormatter = (item, index, type) => {
  const id = simklId(item);
  const url = type ? simklItemUrl(type, id, item.ids?.slug) : undefined;
  const label = url ? `[SIMKL #${id}](${url})` : `[SIMKL #${id ?? 'unknown'}]`;
  return `${index}: ${label} - ${item.title} (${item.year || 'N/A'})`;
};

export const withRating: ItemFormatter = (item, index, type) =>
  `${formatItem(item, index, type)} - rating: ${item.ratings?.simkl?.rating || 'N/A'}`;

export const withImdb: ItemFormatter = (item, index, type) =>
  `${formatItem(item, index, type)} - imdb:${item.ids?.imdb || 'N/A'}`;

// airing entries describe an episode slot, so the year is replaced by episode and date
export const asAiring: ItemFormatter = (item, index, type) => {
  const id = simklId(item);
  const url = type ? simklItemUrl(type, id, item.ids?.slug) : undefined;
  const label = url ? `[SIMKL #${id}](${url})` : `[SIMKL #${id ?? 'unknown'}]`;
  return `${index}: ${label} - ${item.title} - ep ${item.episode?.episode || '?'} at ${item.date || 'TBA'}`;
};

export function formatList(
  items: MediaItem[],
  format: ItemFormatter = formatItem,
  limit = DEFAULT_LIMIT,
  type?: SimklMediaType,
): string[] {
  return items.slice(0, limit).map((item, index) => format(item, index, type));
}

function simklId(item: MediaItem) {
  return item.ids?.simkl_id || item.ids?.simkl;
}
