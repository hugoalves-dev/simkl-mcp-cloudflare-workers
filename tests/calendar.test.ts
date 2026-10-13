import { describe, expect, test } from 'bun:test';
import { getAiringItems } from '../src/api/airing';
import { simklCalendarPath } from '../src/api/calendar';

describe('simklCalendarPath', () => {
  test.each([
    ['tv', undefined, 'tv.json'],
    ['anime', 'today', 'anime.json'],
    ['movies', 'tomorrow', 'movie_release.json'],
  ] as const)('maps %s %s to the v2 rolling calendar', (type, date, file) => {
    expect(simklCalendarPath(type, date)).toBe(`https://data.simkl.in/calendar/v2/${file}`);
  });

  test.each([
    ['tv', '22-08-2026', 'tv.json'],
    ['anime', '22-08-2026', 'anime.json'],
    ['movies', '22-08-2026', 'movie_release.json'],
  ] as const)('maps %s %s to a monthly v2 archive', (type, date, file) => {
    expect(simklCalendarPath(type, date)).toBe(`https://data.simkl.in/calendar/v2/2026/8/${file}`);
  });

  test('rejects impossible archive dates', () => {
    expect(() => simklCalendarPath('tv', '31-02-2026')).toThrow('Invalid calendar date');
  });
});

describe('getAiringItems', () => {
  test('filters the selected day, sorts by requested field, and uses no user token', async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const client = {
      request: async (url: string, options: any) => {
        calls.push({ url, authorization: options.authorization });
        return [
          { title: 'Later', date: '2026-08-22T20:00:00-04:00', rank: 9 },
          { title: 'Previous day', date: '2026-08-21T23:00:00-04:00', rank: 1 },
          { title: 'Earlier', date: '2026-08-22T08:00:00-04:00', rank: 4 },
        ];
      },
    } as any;

    const result = await getAiringItems(client, 'tv', '22-08-2026', 'rank');
    expect(calls).toEqual([{ url: 'https://data.simkl.in/calendar/v2/2026/8/tv.json', authorization: 'none' }]);
    expect(result.map(item => item.title)).toEqual(['Earlier', 'Later']);
  });

  test('uses the rolling calendar and filters today when no date is supplied', async () => {
    const client = {
      request: async () => [
        { title: 'Today', date: '2026-08-22T08:00:00-04:00' },
        { title: 'Tomorrow', date: '2026-08-23T08:00:00-04:00' },
      ],
    } as any;

    const result = await getAiringItems(client, 'anime', undefined, 'time', new Date('2026-08-22T12:00:00Z'));
    expect(result.map(item => item.title)).toEqual(['Today']);
  });
});
