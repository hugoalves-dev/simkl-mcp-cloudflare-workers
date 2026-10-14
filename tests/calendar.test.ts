import { describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { getAiringItems, formatAiringTool, SimklCalendarPayloadError } from '../src/api/airing';
import { SimklClient } from '../src/api/client';
import { registerTools } from '../generated/tools';
import fixture from './fixtures/calendar-v2.json';
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

  test.each(['tv', 'anime'] as const)('maps %s on 15-03-2026 to the March archive', type => {
    expect(simklCalendarPath(type, '15-03-2026'))
      .toBe(`https://data.simkl.in/calendar/v2/2026/3/${type}.json`);
  });

  test('rejects impossible archive dates', () => {
    expect(() => simklCalendarPath('tv', '31-02-2026')).toThrow('Invalid calendar date');
  });
});


const sample = () => structuredClone(fixture);

describe('airing MCP date schema regression', () => {
  test.each(['simkl_get_airing_shows', 'simkl_get_airing_anime'])(
    '%s exposes arbitrary calendar dates as a plain string, not an enum',
    toolName => {
      const registered = new Map<string, any>();
      registerTools({
        registerTool(name: string, config: { inputSchema: unknown }) {
          registered.set(name, config.inputSchema);
        },
      } as any, {} as any, () => undefined);

      const inputSchema = registered.get(toolName);
      expect(inputSchema).toBeDefined();
      for (const date of [undefined, 'today', 'tomorrow', '15-03-2026', '22-08-2022']) {
        expect(inputSchema.safeParse({ date, sort: 'time' }).success).toBe(true);
      }

      const publicSchema = z.toJSONSchema(inputSchema) as { properties?: Record<string, any> };
      expect(publicSchema.properties?.date?.type).toBe('string');
      expect(publicSchema.properties?.date?.enum).toBeUndefined();
      expect(publicSchema.properties?.date?.pattern).toBeUndefined();
    },
  );
});

describe('Simkl calendar v2 payload regression', () => {
  test('joins entries with metadata and sorts a monthly archive by rank', async () => {
    const calls: Array<{ path: string; authorization: string }> = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = { request: async (path: string, opts: { authorization: string }) => {
        calls.push({ path, authorization: opts.authorization });
        return sample();
      } } as any;
      const result = await getAiringItems(client, 'tv', '22-08-2026', 'rank');
      expect(calls).toEqual([{
        path: 'https://data.simkl.in/calendar/v2/2026/8/tv.json', authorization: 'none',
      }]);
      expect(result.map(item => item.title)).toEqual(['Another Show', 'Over the Atlantic', 'Unknown title']);
      expect(result[0]?.ids?.simkl_id).toBe(42);
      expect(result[1]?.ids).toEqual({ simkl_id: 1157808, slug: 'over-the-atlantic' });
      expect(result[1]?.episode).toEqual({ season: 11, episode: 4, title: 'Episode 4' });
      expect(result[1]?.date).toBe('2026-08-22T20:00:00Z');
      expect(result[2]?.ids?.simkl_id).toBe(999);
      expect(warn.mock.calls).toEqual([[
        'simkl.calendar.validation',
        { code: 'SIMKL_CALENDAR_PARTIAL_DATA', invalidEntries: 0, missingMetadata: 1 },
      ]]);
    } finally {
      warn.mockRestore();
    }
  });

  test('filters the selected day and sorts airings chronologically', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await getAiringItems({ request: async () => sample() } as any, 'anime', '22-08-2026');
      expect(result.map(item => item.date)).toEqual([
        '2026-08-22T08:00:00Z', '2026-08-22T09:00:00Z', '2026-08-22T20:00:00Z',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('today and tomorrow select distinct days of the rolling v2 calendar', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = { request: async () => sample() } as any;
      const now = new Date('2026-08-22T12:00:00Z');
      expect(await getAiringItems(client, 'tv', 'today', 'rank', now)).toHaveLength(3);
      expect((await getAiringItems(client, 'tv', 'tomorrow', 'time', now))
        .map(item => item.episode?.episode)).toEqual([5]);
    } finally {
      warn.mockRestore();
    }
  });

  test('formats a correct Simkl URL, title, episode number and date', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await formatAiringTool({ request: async () => sample() } as any, 'tv', {
        date: '22-08-2026', sort: 'rank',
      });
      expect(result.content.length).toBe(3);
      expect(result.content.some(item => item.text.includes(
        '[SIMKL #1157808](https://simkl.com/tv/1157808/over-the-atlantic)',
      ))).toBe(true);
      expect(result.content.some(item => item.text.includes(
        'Over the Atlantic - ep 4 at 2026-08-22T20:00:00Z',
      ))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([null, [], {}, { calendar: [] }, { calendar: {}, metadata: {} }, { calendar: [], metadata: [] }])(
    'rejects malformed top-level v2 structure safely: %j', async value => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(getAiringItems({ request: async () => value } as any, 'tv', '22-08-2026'))
          .rejects.toBeInstanceOf(SimklCalendarPayloadError);
        expect(warn.mock.calls).toEqual([[
          'simkl.calendar.validation', { code: 'SIMKL_CALENDAR_INVALID_STRUCTURE' },
        ]]);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test('skips malformed calendar entries and logs only safe diagnostic counts', async () => {
    const data = sample() as { calendar: unknown[]; metadata: Record<string, unknown> };
    data.calendar.push({ simkl_id: 'private-malformed-id', date: '2026-08-22T09:00:00Z' });
    data.calendar.push({ simkl_id: 8, date: 'invalid-date' });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const items = await getAiringItems({ request: async () => data } as any, 'tv', '22-08-2026');
      expect(items).toHaveLength(3);
      expect(warn.mock.calls).toEqual([[
        'simkl.calendar.validation',
        { code: 'SIMKL_CALENDAR_PARTIAL_DATA', invalidEntries: 2, missingMetadata: 1 },
      ]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-malformed-id');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('airing MCP tools + SimklClient + Cache API regression', () => {
  test('today, tomorrow and archives return non-error content; cache uses MISS/STORE/HIT', async () => {
    const originalFetch = globalThis.fetch;
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const log = spyOn(console, 'info').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const entries = new Map<string, Response>();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    let stores = 0;

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const rolling = sample();
    rolling.calendar[0]!.date = today + 'T20:00:00Z';
    rolling.calendar[1]!.date = today + 'T08:00:00Z';
    rolling.calendar[2]!.date = tomorrow + 'T06:00:00Z';
    rolling.calendar[3]!.date = today + 'T09:00:00Z';

    try {
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
        default: {
          match: async (key: Request) => entries.get(key.url)?.clone(),
          put: async (key: Request, response: Response) => {
            stores++;
            entries.set(key.url, response.clone());
          },
        },
      } });
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = String(input);
        requests.push({ url: requestUrl, authorization: new Headers(init?.headers).get('Authorization') });
        return Response.json(new URL(requestUrl).pathname.includes('/2026/8/') ? sample() : rolling);
      }) as typeof fetch;

      const callbacks = new Map<string, (args: { date?: string; sort?: string }) => Promise<any>>();
      const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'client-id' });
      registerTools({
        registerTool(name: string, _: unknown, callback: any) { callbacks.set(name, callback); },
      } as any, client, () => 'private-user-token');

      const shows = callbacks.get('simkl_get_airing_shows')!;
      const anime = callbacks.get('simkl_get_airing_anime')!;
      const results = [
        await shows({ date: 'today', sort: 'time' }),
        await shows({ date: 'tomorrow', sort: 'rank' }),
        await shows({ date: '22-08-2026', sort: 'rank' }),
        await shows({ date: '22-08-2026', sort: 'popularity' }),
        await anime({ date: 'today' }),
      ];
      for (const result of results) {
        expect(result.isError).not.toBe(true);
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content[0].text).toContain('[SIMKL #');
      }
      expect(results[0].content.some((item: { text: string }) => item.text.includes('Another Show'))).toBe(true);
      expect(results[1].content[0].text).toContain('Over the Atlantic');
      expect(results[2].content.some((item: { text: string }) => item.text.includes('ep 4'))).toBe(true);
      expect(requests).toHaveLength(3); // rolling TV, archived TV, rolling anime
      expect(stores).toBe(3);
      expect(requests.every(req => req.authorization === null)).toBe(true);
      expect([...entries.keys()].every(key => !key.includes('private-user-token'))).toBe(true);
      expect(log.mock.calls.filter(call => call[0] === 'simkl.calendar.cache')
        .map(call => (call[1] as { event: string }).event))
        .toEqual(['MISS', 'STORE', 'HIT', 'MISS', 'STORE', 'HIT', 'MISS', 'STORE']);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
      else delete (globalThis as typeof globalThis & { caches?: CacheStorage }).caches;
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
