import { describe, expect, spyOn, test } from 'bun:test';
import { formatAiringTool, getAiringItems } from '../src/api/airing';
import { resolveSimklCalendarDay, simklCalendarArchiveRange, simklCalendarPaths } from '../src/api/calendar';
import { toMcpErrorResult } from '../src/api/errors';

const now = new Date('2026-11-17T12:00:00Z');

describe('Calendar v2 archive bounds', () => {
  test('covers July 2024 through the current UTC month + 3', () => {
    expect(simklCalendarArchiveRange(now)).toEqual({ first: 2024 * 12 + 6, last: 2027 * 12 + 1 });
    expect(() => resolveSimklCalendarDay('01-07-2024', 'UTC', now)).not.toThrow();
    expect(() => resolveSimklCalendarDay('28-02-2027', 'UTC', now)).not.toThrow();
  });

  test.each(['30-06-2024', '01-03-2027', '15-01-2020'])('rejects %s locally with a clear MCP error', async date => {
    let requests = 0;
    const client = { request: async () => { requests++; return { calendar: [], metadata: {} }; } } as any;
    const error = await getAiringItems(client, 'tv', date, 'time', now).catch(caught => caught);
    expect(requests).toBe(0);
    const result = toMcpErrorResult(error);
    expect(result.content[0].text).toContain('outside the Simkl calendar archive');
    expect(result.content[0].text).toContain('July 2024 through February 2027');
  });

  test('invalid formats surface their own message instead of a generic failure', () => {
    const error = (() => { try { resolveSimklCalendarDay('2026-11-17', 'UTC', now); } catch (caught) { return caught; } })();
    expect(toMcpErrorResult(error).content[0].text).toContain('DD-MM-YYYY');
  });

  test('keeps unpadded months and skips an adjacent UTC month before the archive starts', () => {
    const interval = resolveSimklCalendarDay('01-07-2024', 'Asia/Tokyo', now);
    expect(simklCalendarPaths('anime', '01-07-2024', interval, now))
      .toEqual(['https://data.simkl.in/calendar/v2/2024/7/anime.json']);
    const crossing = resolveSimklCalendarDay('01-09-2026', 'Asia/Tokyo', now);
    expect(simklCalendarPaths('tv', '01-09-2026', crossing, now)).toEqual([
      'https://data.simkl.in/calendar/v2/2026/8/tv.json',
      'https://data.simkl.in/calendar/v2/2026/9/tv.json',
    ]);
  });

  test('relative days remain available near the upper bound', () => {
    const late = new Date('2027-02-28T23:30:00Z');
    expect(() => resolveSimklCalendarDay('tomorrow', 'UTC', late)).not.toThrow();
  });
});

describe('Calendar v2 entry shapes', () => {
  const payload = {
    calendar: [
      { simkl_id: 10, date: '2026-11-17T01:00:00Z', finale_type: null },
      { simkl_id: 11, date: '2026-11-17T02:00:00Z', finale_type: null, episode: { season: 0, episode: 3, title: 'OVA', url: 'https://simkl.com/x' } },
      { simkl_id: 12, date: '2026-11-17T03:00:00Z', finale_type: 9, episode: { episode: 7, title: null, url: 'https://simkl.com/y' } },
      { simkl_id: 13, date: '2026-11-17T04:00:00Z', episode: { season: 2, episode: null, title: null } },
      { simkl_id: 14, date: '2026-11-17T05:00:00Z', episode: { season: 1, episode: 1 } },
    ],
    metadata: {
      10: { title: 'Anime Film', anime_type: 'movie', ids: { simkl_id: 10, slug: 'anime-film' } },
      11: { title: 'Special Show', anime_type: 'ova', ids: { simkl_id: 11, slug: 'special-show' } },
      12: { title: 'Weekly', anime_type: 'tv', status: 'something-new', ids: { simkl_id: 12, slug: 'weekly', mal: null } },
      13: { title: 'Sparse', ids: { simkl_id: 13, slug: 'sparse' } },
      14: { title: 'Old Archive', ids: { simkl_id: 14, slug: 'old' }, watching: null },
    },
  };

  test('anime movies render as releases, specials keep their number, sparse entries stay readable', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await formatAiringTool({ request: async () => structuredClone(payload) } as any, 'anime', {
        date: '17-11-2026', sort: 'time',
      });
      const lines = result.content.map(item => item.text);
      expect(lines).toHaveLength(5);
      expect(lines[0]).toContain('Anime Film - movie release at 2026-11-17T01:00:00Z');
      expect(lines[0]).not.toContain('ep ?');
      expect(lines[1]).toContain('Special Show - special ep 3 at');
      expect(lines[2]).toContain('Weekly - ep 7 at');
      expect(lines[3]).toContain('Sparse - ep ? at');
      expect(lines[4]).toContain('Old Archive - ep 1 at');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('anime_type is preserved through the formatter input', async () => {
    const items = await getAiringItems({ request: async () => structuredClone(payload) } as any, 'anime', '17-11-2026', 'time', now);
    expect(items.map(item => item.anime_type)).toEqual(['movie', 'ova', 'tv', undefined, undefined]);
    expect(items[0].episode).toBeUndefined();
  });
});
