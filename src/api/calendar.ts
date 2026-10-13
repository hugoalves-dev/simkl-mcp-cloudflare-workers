export type SimklCalendarType = 'tv' | 'anime' | 'movies';

const calendarFileByType: Record<SimklCalendarType, string> = {
  tv: 'tv',
  anime: 'anime',
  movies: 'movie_release',
};

export function simklCalendarPath(type: SimklCalendarType, date?: string): string {
  const calendarFile = calendarFileByType[type];
  if (!calendarFile) throw new Error(`Unsupported calendar type: ${type}`);

  if (!date || date === 'today' || date === 'tomorrow') {
    return `https://data.simkl.in/calendar/v2/${calendarFile}.json`;
  }

  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if (!match) throw new Error('Invalid calendar date: expected DD-MM-YYYY');

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const validatedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    validatedDate.getUTCFullYear() !== year ||
    validatedDate.getUTCMonth() !== month - 1 ||
    validatedDate.getUTCDate() !== day
  ) {
    throw new Error('Invalid calendar date');
  }

  return `https://data.simkl.in/calendar/v2/${year}/${month}/${calendarFile}.json`;
}
