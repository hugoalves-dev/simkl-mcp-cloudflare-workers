import { SimklInputError } from './errors.js';

export type SimklCalendarType = 'tv' | 'anime' | 'movies';

const calendarFileByType: Record<SimklCalendarType, string> = {
  tv: 'tv',
  anime: 'anime',
  movies: 'movie_release',
};

const DAY_MS = 86_400_000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Simkl publishes monthly v2 archives from July 2024 through the current month + 3.
// Any other month is a CDN 404, so reject it locally instead of spending a request.
const FIRST_ARCHIVE_MONTH = 2024 * 12 + 6;
const FUTURE_ARCHIVE_MONTHS = 3;

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function monthLabel(index: number): string {
  return `${MONTH_NAMES[index % 12]} ${Math.floor(index / 12)}`;
}

export function simklCalendarArchiveRange(now = new Date()): { first: number; last: number } {
  return {
    first: FIRST_ARCHIVE_MONTH,
    last: monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1) + FUTURE_ARCHIVE_MONTHS,
  };
}

function isArchivedMonth(year: number, month: number, now: Date): boolean {
  const { first, last } = simklCalendarArchiveRange(now);
  const index = monthIndex(year, month);
  return index >= first && index <= last;
}

function validExplicitDate(date: string): { day: string; year: number; month: number } {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if (!match) throw new SimklInputError('Invalid calendar date: expected today, tomorrow, or DD-MM-YYYY');

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const validated = new Date(0);
  validated.setUTCFullYear(year, month - 1, day);
  if (year < 1 || validated.getUTCFullYear() !== year
    || validated.getUTCMonth() !== month - 1 || validated.getUTCDate() !== day) {
    throw new SimklInputError('Invalid calendar date');
  }
  return { day: validated.toISOString().slice(0, 10), year, month };
}

export function simklCalendarPath(type: SimklCalendarType, date?: string): string {
  const calendarFile = calendarFileByType[type];
  if (!calendarFile) throw new SimklInputError(`Unsupported calendar type: ${type}`);

  if (!date || date === 'today' || date === 'tomorrow') {
    return `https://data.simkl.in/calendar/v2/${calendarFile}.json`;
  }

  const { year, month } = validExplicitDate(date);
  return `https://data.simkl.in/calendar/v2/${year}/${month}/${calendarFile}.json`;
}

function localDay(formatter: Intl.DateTimeFormat, time: number): string {
  const parts = formatter.formatToParts(new Date(time));
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) throw new Error('Unable to resolve calendar time zone');
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// Locate the first UTC millisecond of a local day. Unlike adding 24 hours to
// midnight, this handles both 23-hour and 25-hour DST transition days.
function startOfLocalDay(formatter: Intl.DateTimeFormat, day: string): number {
  const utcMidnight = Date.parse(`${day}T00:00:00.000Z`);
  let low = utcMidnight - 2 * DAY_MS;
  let high = utcMidnight + 2 * DAY_MS;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDay(formatter, middle) < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

export interface SimklCalendarDay {
  day: string;
  start: number;
  end: number;
}

export function resolveSimklCalendarDay(
  date = 'today',
  timeZone = 'UTC',
  now = new Date(),
): SimklCalendarDay {
  // Explicitly require an IANA zone, not a machine-local zone or an offset.
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+)$/.test(timeZone)) {
    throw new SimklInputError('Invalid calendar time zone: expected an IANA time zone (e.g. America/Sao_Paulo)');
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      calendar: 'gregory', numberingSystem: 'latn',
    });
  } catch {
    throw new SimklInputError('Invalid calendar time zone: expected an IANA time zone (e.g. America/Sao_Paulo)');
  }

  let day: string;
  if (date === 'today' || date === 'tomorrow') {
    const currentDay = localDay(formatter, now.getTime());
    const utcDay = Date.parse(`${currentDay}T00:00:00.000Z`);
    day = new Date(utcDay + (date === 'tomorrow' ? DAY_MS : 0)).toISOString().slice(0, 10);
  } else {
    const explicit = validExplicitDate(date);
    if (!isArchivedMonth(explicit.year, explicit.month, now)) {
      const { first, last } = simklCalendarArchiveRange(now);
      throw new SimklInputError(`Calendar date ${date} is outside the Simkl calendar archive: use a date from ${monthLabel(first)} through ${monthLabel(last)}, or today/tomorrow.`);
    }
    day = explicit.day;
  }

  const nextDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
  return { day, start: startOfLocalDay(formatter, day), end: startOfLocalDay(formatter, nextDay) };
}

export function simklCalendarPaths(
  type: SimklCalendarType,
  date: string | undefined,
  interval: SimklCalendarDay,
  now = new Date(),
): string[] {
  const relative = !date || date === 'today' || date === 'tomorrow';
  const paths = relative ? [simklCalendarPath(type)] : [];
  if (interval.end <= interval.start) return paths;

  // The local day may cover two different UTC months, even for an explicit date.
  const months = new Set([
    new Date(interval.start).toISOString().slice(0, 7),
    new Date(interval.end - 1).toISOString().slice(0, 7),
  ]);
  // For relative days the rolling file remains the primary source. Add both
  // archives only when the UTC interval straddles a month boundary.
  if (!relative || months.size > 1) {
    for (const month of months) {
      const [year, monthNumber] = month.split('-');
      // An adjacent UTC month outside the archive (e.g. June 2024) does not exist.
      if (!isArchivedMonth(Number(year), Number(monthNumber), now)) continue;
      paths.push(simklCalendarPath(type, `01-${monthNumber}-${year}`));
    }
  }
  return [...new Set(paths)];
}
