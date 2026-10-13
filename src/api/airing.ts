import { asAiring, formatList, type MediaItem } from '../format/media';
import { simklCalendarPath } from './calendar';

export type SimklAiringType = 'tv' | 'anime';
export type SimklAiringSort = 'time' | 'rank' | 'popularity';

interface CalendarItem extends MediaItem {
  rank?: number | null;
}

export async function getAiringItems(
  client: { request<T = unknown>(path: string, options: { method: 'GET'; authorization: 'none' }): Promise<T> },
  type: SimklAiringType,
  date?: string,
  sort: SimklAiringSort = 'time',
  now = new Date(),
): Promise<CalendarItem[]> {
  const items = await client.request<CalendarItem[]>(simklCalendarPath(type, date), {
    method: 'GET',
    authorization: 'none',
  });

  if (!Array.isArray(items)) throw new Error('Simkl calendar returned an invalid response');

  const day = date && date !== 'today' && date !== 'tomorrow'
    ? `${date.slice(6, 10)}-${date.slice(3, 5)}-${date.slice(0, 2)}`
    : new Date(now.getTime() + (date === 'tomorrow' ? 86_400_000 : 0)).toISOString().slice(0, 10);

  const filtered = items.filter(item => item.date?.slice(0, 10) === day);
  if (sort === 'rank' || sort === 'popularity') {
    filtered.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  } else {
    filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  return filtered;
}

export async function formatAiringTool(
  client: Parameters<typeof getAiringItems>[0],
  type: SimklAiringType,
  args: { date?: string; sort?: SimklAiringSort },
) {
  const items = await getAiringItems(client, type, args.date, args.sort);
  return { content: formatList(items, asAiring).map(text => ({ type: 'text' as const, text })) };
}

