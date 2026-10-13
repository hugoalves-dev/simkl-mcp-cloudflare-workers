import { MEDIA_TYPES, type LibraryItem, type LibraryItems, type MediaType } from './types';
import { simklItemUrl } from '../format/media';

const statuses = ['watching', 'plantowatch', 'hold', 'completed', 'dropped'];
const mediaPath: Record<MediaType, 'tv' | 'movies' | 'anime'> = { shows: 'tv', movies: 'movies', anime: 'anime' };
const DEFAULT_WATCHLIST_LIMIT = 50;

export class LibraryQueryError extends Error {}

function formatWatchlistItem(item: LibraryItem, type: MediaType): string {
  const media = (item.show || item.movie || item.anime || {}) as NonNullable<LibraryItem['show']>;
  const ids = media.ids || {};
  const simklId = ids.simkl;
  if (simklId === undefined || simklId === null) throw new LibraryQueryError('Cached watchlist item is missing its Simkl ID');

  const title = typeof media.title === 'string' && media.title ? media.title : 'unknown';
  const year = typeof media.year === 'number' ? String(media.year) : 'N/A';
  const url = simklItemUrl(mediaPath[type], simklId, typeof ids.slug === 'string' ? ids.slug : undefined);
  if (!url) throw new LibraryQueryError('Cached watchlist item is missing its Simkl ID');
  const watched = item.watched_episodes_count;
  const total = item.total_episodes_count;
  const progress = typeof watched === 'number' && Number.isFinite(watched)
    && typeof total === 'number' && Number.isFinite(total)
    ? `${watched}/${total}`
    : 'unavailable';
  const rating = typeof item.user_rating === 'number' && Number.isFinite(item.user_rating)
    ? `${item.user_rating}/10`
    : 'unrated';
  const next = typeof item.next_to_watch === 'string' && item.next_to_watch
    ? ` | next episode: ${item.next_to_watch}`
    : '';

  return `${title} (${year}) | status: ${item.status || 'unknown'} | progress: ${progress}${next} | rating: ${rating} | Simkl: <${url}>`;
}

export function selectWatchlist(items: LibraryItems, args: Record<string, unknown>): string[] {
  const { type, status, title, limit = DEFAULT_WATCHLIST_LIMIT, offset = 0 } = args;
  if (type !== undefined && !MEDIA_TYPES.includes(type as MediaType)) throw new LibraryQueryError('Invalid watchlist type');
  if (status !== undefined && !statuses.includes(status as string)) throw new LibraryQueryError('Invalid watchlist status');
  if (title !== undefined && typeof title !== 'string') throw new LibraryQueryError('Invalid watchlist title');
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new LibraryQueryError('Watchlist limit must be an integer from 1 to 100');
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new LibraryQueryError('Watchlist offset must be a non-negative integer');

  for (const key of ['date_from', 'extended', 'allow_rewatch', 'next_watch_info', 'episode_watched_at', 'memos']) {
    if (args[key] !== undefined) throw new LibraryQueryError(`Unsupported cached watchlist option: ${key}`);
  }

  const normalizedTitle = typeof title === 'string' ? title.trim().toLowerCase() : '';
  const selected = (type ? [type as MediaType] : MEDIA_TYPES).flatMap(mediaType =>
    items[mediaType]
      .filter(item => !status || item.status === status)
      .filter(item => {
        if (!normalizedTitle) return true;
        const media = item.show || item.movie || item.anime;
        return typeof media?.title === 'string' && media.title.toLowerCase().includes(normalizedTitle);
      })
      .map(item => ({ item, mediaType }))
  );

  return selected
    .slice(offset as number, (offset as number) + (limit as number))
    .map(({ item, mediaType }) => formatWatchlistItem(item, mediaType));
}

export function watchlistResourceContents(uri: string, type: string, status: string, items: LibraryItems) {
  const lines = selectWatchlist(items, { type, status });
  if (!lines.length) return { contents: [{ uri, mimeType: 'text/plain', text: `no ${type} with status ${status}` }] };
  return { contents: lines.map((text, index) => ({ uri: `${uri}#${index}`, mimeType: 'text/plain', text })) };
}
