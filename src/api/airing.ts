import { asAiring, formatList, type MediaItem } from '../format/media';
import { resolveSimklCalendarDay, simklCalendarPaths } from './calendar';

export type SimklAiringType = 'tv' | 'anime';
export type SimklAiringSort = 'time' | 'rank' | 'popularity';

interface CalendarItem extends MediaItem {
  rank?: number | null;
  episode?: { season?: number; episode?: number; title?: string };
}


interface CalendarEntry {
  simkl_id: number;
  date: string;
  episode?: { season?: number; episode?: number; title?: string };
}

interface CalendarMetadata {
  title?: string;
  year?: number;
  rank?: number | null;
  ids?: MediaItem['ids'];
}

interface CalendarPayload {
  calendar: unknown[];
  metadata: Record<string, unknown>;
}

export class SimklCalendarPayloadError extends Error {
  readonly code = 'SIMKL_CALENDAR_INVALID_STRUCTURE';

  constructor() {
    super('Simkl calendar returned an invalid response');
    this.name = 'SimklCalendarPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCalendarPayload(value: unknown): CalendarPayload {
  if (!isRecord(value) || !Array.isArray(value.calendar) || !isRecord(value.metadata)) {
    // Log only a fixed diagnostic code, never the CDN payload or request URL.
    console.warn('simkl.calendar.validation', { code: 'SIMKL_CALENDAR_INVALID_STRUCTURE' });
    throw new SimklCalendarPayloadError();
  }
  return { calendar: value.calendar, metadata: value.metadata };
}

function isCalendarEntry(value: unknown): value is CalendarEntry {
  if (!isRecord(value) || !Number.isSafeInteger(value.simkl_id) || (value.simkl_id as number) <= 0
    || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value.date)) {
    return false;
  }
  if (value.episode === undefined || value.episode === null) return true;
  if (!isRecord(value.episode)) return false;
  return (value.episode.episode === undefined || (Number.isInteger(value.episode.episode) && (value.episode.episode as number) > 0))
    && (value.episode.season === undefined || (Number.isInteger(value.episode.season) && (value.episode.season as number) >= 0));
}

function enrichCalendarEntry(entry: CalendarEntry, rawMetadata: unknown): CalendarItem {
  const metadata = (isRecord(rawMetadata) ? rawMetadata : {}) as CalendarMetadata;
  const rawIds = isRecord(metadata.ids) ? metadata.ids : {};
  const ids: NonNullable<MediaItem['ids']> = {
    simkl_id: entry.simkl_id,
    ...(typeof rawIds.slug === 'string' ? { slug: rawIds.slug } : {}),
    ...(typeof rawIds.imdb === 'string' ? { imdb: rawIds.imdb } : {}),
  };
  const rawEpisode = entry.episode;
  const episode = rawEpisode && {
    ...(typeof rawEpisode.season === 'number' ? { season: rawEpisode.season } : {}),
    ...(typeof rawEpisode.episode === 'number' ? { episode: rawEpisode.episode } : {}),
    ...(typeof rawEpisode.title === 'string' ? { title: rawEpisode.title } : {}),
  };

  return {
    ids,
    title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : 'Unknown title',
    ...(typeof metadata.year === 'number' ? { year: metadata.year } : {}),
    ...(typeof metadata.rank === 'number' && Number.isFinite(metadata.rank) ? { rank: metadata.rank } : {}),
    date: entry.date,
    ...(episode ? { episode } : {}),
  };
}

export async function getAiringItems(
  client: { request<T = unknown>(path: string, options: { method: 'GET'; authorization: 'none' }): Promise<T> },
  type: SimklAiringType,
  date?: string,
  sort: SimklAiringSort = 'time',
  now = new Date(),
  timeZone = 'UTC',
): Promise<CalendarItem[]> {
  const interval = resolveSimklCalendarDay(date, timeZone, now);
  const paths = simklCalendarPaths(type, date, interval);
  const payloads = await Promise.all(paths.map(async path =>
    parseCalendarPayload(await client.request<unknown>(path, {
      method: 'GET',
      authorization: 'none',
    }))
  ));

  const filtered: CalendarItem[] = [];
  const seen = new Set<string>();
  let invalidEntries = 0;
  let missingMetadata = 0;
  for (const payload of payloads) {
    for (const rawEntry of payload.calendar) {
      if (!isCalendarEntry(rawEntry)) {
        invalidEntries++;
        continue;
      }
      const instant = Date.parse(rawEntry.date);
      if (!Number.isFinite(instant)) {
        invalidEntries++;
        continue;
      }
      if (instant < interval.start || instant >= interval.end) continue;

      // Current and monthly calendar files may contain the same airing.
      const key = `${rawEntry.simkl_id}:${instant}:${rawEntry.episode?.season ?? ''}:${rawEntry.episode?.episode ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const metadata = payload.metadata[String(rawEntry.simkl_id)];
      if (!isRecord(metadata) || typeof metadata.title !== 'string' || !metadata.title.trim()) {
        missingMetadata++;
      }
      filtered.push(enrichCalendarEntry(rawEntry, metadata));
    }
  }
  if (invalidEntries > 0 || missingMetadata > 0) {
    console.warn('simkl.calendar.validation', {
      code: 'SIMKL_CALENDAR_PARTIAL_DATA', invalidEntries, missingMetadata,
    });
  }
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
  args: { date?: string; sort?: SimklAiringSort; timeZone?: string },
) {
  const items = await getAiringItems(client, type, args.date, args.sort, new Date(), args.timeZone);
  return { content: formatList(items, asAiring, 20, type).map(text => ({ type: 'text' as const, text })) };
}

