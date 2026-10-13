import { MEDIA_TYPES, type LibraryItems, type MediaType } from './types';
const statuses = ['watching', 'plantowatch', 'hold', 'completed', 'dropped'];
export class LibraryQueryError extends Error {}
export function selectWatchlist(items: LibraryItems, args: Record<string, unknown>): Partial<LibraryItems> {
  const { type, status, extended } = args;
  if (type !== undefined && !MEDIA_TYPES.includes(type as MediaType)) throw new LibraryQueryError('Invalid watchlist type');
  if (status !== undefined && !statuses.includes(status as string)) throw new LibraryQueryError('Invalid watchlist status');
  if (extended !== undefined) throw new LibraryQueryError('Unsupported cached watchlist projection; omit extended to use the cached default view');
  for (const key of ['date_from', 'episode_watched_at', 'memos']) if (args[key] !== undefined) throw new LibraryQueryError(`Unsupported cached watchlist option: ${key}`);
  return Object.fromEntries((type ? [type as MediaType] : MEDIA_TYPES).map(media => [media, items[media].filter(item => !status || item.status === status)]));
}
export function watchlistResourceContents(uri: string, type: string, status: string, items: LibraryItems) {
  const selected = selectWatchlist(items, { type, status })[type as MediaType] ?? [];
  if (!selected.length) return { contents: [{ uri, mimeType: 'text/plain', text: `no ${type} with status ${status}` }] };
  return { contents: selected.map((item, index) => {
    const media = item.show || item.movie || item.anime;
    const added = typeof item.added_to_watchlist_at === 'string' ? item.added_to_watchlist_at.split('T')[0] : 'unknown';
    return { uri: `${uri}#${index}`, mimeType: 'text/plain', text: `${index}: [SIMKL #${media?.ids?.simkl || 'unknown'}] - ${media?.title || 'unknown'} (${media?.year || 'N/A'}) - added on ${added}` };
  }) };
}
