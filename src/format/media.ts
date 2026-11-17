// plain-text formatters for simkl media items returned by list endpoints

export interface MediaItem {
  title?: string;
  year?: number;
  endpoint_type?: string;
  date?: string;
  ids?: { simkl_id?: number; simkl?: number; imdb?: string; slug?: string };
  ratings?: { simkl?: { rating?: number } };
  anime_type?: string;
  episode?: { season?: number; episode?: number };
}

export type SimklMediaType = 'tv' | 'movies' | 'anime';
export type ItemFormatter = (item: MediaItem, index: number, type?: SimklMediaType) => string;

const DEFAULT_LIMIT = 20;

export function simklItemUrl(type: SimklMediaType, id: string | number | undefined, slug?: string): string | undefined {
  if (id === undefined || id === null || String(id) === '') return undefined;
  const base = `https://simkl.com/${type}/${encodeURIComponent(String(id))}`;
  const safeSlug = typeof slug === 'string' && slug.trim() ? slug : undefined;
  return safeSlug ? `${base}/${encodeURIComponent(decodeSlug(safeSlug))}` : base;
}

// Simkl sometimes returns slugs that are already percent-encoded (e.g. "%5Bre%5D").
// Decode once so encoding below never turns "%5B" into "%255B".
function decodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
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
  return `${index}: ${label} - ${item.title} - ${airingSlot(item)} at ${item.date || 'TBA'}`;
};

// Movie releases (and anime movies) have no episode object: never invent "ep ?".
function airingSlot(item: MediaItem): string {
  const episode = item.episode;
  if (!episode || item.anime_type === 'movie') {
    return item.anime_type ? `${item.anime_type} release` : 'release';
  }
  const number = episode.episode === undefined ? '?' : String(episode.episode);
  return episode.season === 0 ? `special ep ${number}` : `ep ${number}`;
}

export function formatList(
  items: MediaItem[],
  format: ItemFormatter = formatItem,
  limit = DEFAULT_LIMIT,
  type?: SimklMediaType | 'movie' | 'all',
): string[] {
  return items.slice(0, limit).map((item, index) => {
    if (type === 'all') {
      // /search/all mixes media types. Never guess a URL from the request type.
      const actualType = item.endpoint_type;
      if (actualType !== 'movies' && actualType !== 'tv' && actualType !== 'anime') {
        throw new Error('Invalid Simkl search endpoint_type');
      }
      return `${format(item, index, actualType)} - type: ${actualType}`;
    }
    return format(item, index, type === 'movie' ? 'movies' : type);
  });
}

function simklId(item: MediaItem) {
  return item.ids?.simkl_id || item.ids?.simkl;
}
