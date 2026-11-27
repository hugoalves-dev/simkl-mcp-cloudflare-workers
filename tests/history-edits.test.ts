import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LibraryAdapter } from '../src/library/adapter';
import { selectWatchlist } from '../src/library/watchlist';
import { editMemosInput, editWatchDatesInput, registerHistoryEditTools } from '../src/tools/history-edits';

const ids = { simkl: 42 };
const timestamp = '2026-10-15T20:00:00-03:00';
const normalized = '2026-10-15T23:00:00.000Z';
const empty = { shows: [], movies: [], episodes: [] };

test('date batches normalize UTC and accept movie, episode, anime and session edits', () => {
  const episode = { number: 2, watched_at: timestamp };
  const parsed = editWatchDatesInput.parse({
    movies: [{ ids, watched_at: timestamp }, { ids, rewatch_id: 9, added_at: timestamp }],
    shows: [{ ids, episodes: [episode] }],
    anime: [{ ids, rewatch_id: 10, use_tvdb_anime_seasons: true, seasons: [{ number: 1, episodes: [episode] }] }],
  });
  expect(parsed.movies?.[0].watched_at).toBe(normalized);
  expect(parsed.movies?.[1].added_at).toBe(normalized);
  expect(parsed.shows?.[0].episodes?.[0].watched_at).toBe(normalized);
  expect(parsed.anime?.[0].seasons?.[0].episodes[0].watched_at).toBe(normalized);
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-15', '1970-01-01T01:00:01+01:00']) {
    expect(editWatchDatesInput.safeParse({ movies: [{ ids, watched_at: value }] }).success).toBe(false);
  }
  expect(editWatchDatesInput.safeParse({ shows: [{ ids, watched_at: timestamp }] }).success).toBe(false);
});

test('memo requests preserve omission and accept explicit privacy and clearing', () => {
  const request = {
    movies: [{ ids, memo: 'Preserve privacy' }],
    shows: [{ ids, memo: { text: 'Private', is_private: true } }],
    anime: [{ ids, memo: '' }, { ids, memo: { text: 'Public', is_private: false } }],
  };
  expect(editMemosInput.parse(request)).toEqual(request);
  for (const memo of [{ text: 'Private', is_private: 'true' }, 'a\nb\nc\nd\ne\nf\ng', 'a\n\n\nb', 'a'.repeat(141)]) {
    expect(editMemosInput.safeParse({ movies: [{ ids, memo }] }).success).toBe(false);
  }
  expect(editMemosInput.safeParse({ movies: [{ ids, rewatch_id: 9, memo: '' }] }).success).toBe(false);
});

test('memo reads distinguish omitted, cleared and private memo fields', () => {
  const movie = { movie: { ids }, status: 'completed' };
  const items = { shows: [], anime: [], movies: [movie, { ...movie, memo: {} }, { ...movie, memo: { text: 'Private', is_private: true } }] };
  expect(selectWatchlist(items, {}).every(line => !line.includes('memo:'))).toBe(true);
  const [unfetched, cleared, privateMemo] = selectWatchlist(items, { memos: 'yes' });
  expect(unfetched).toContain('memo: unavailable');
  expect(cleared).toContain('memo: {}');
  expect(privateMemo).toContain('memo: {"text":"Private","is_private":true}');
});

test('registered tools gate writes by scope and preserve mixed 201 results', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let scope = 'media:read';
  const refusal = { request: { ids, rewatch_id: 10 }, error: { code: 'too_soon', ref_date: normalized, min_gap_days: 2 } };
  const result = {
    updated: { movies: 1, episodes: 0, statuses: [{ request: { ids, type: 'movie' } }] },
    not_found: { ...empty, movies: [{ ids: { simkl: 7 } }] },
    errors: [refusal],
  };
  const calls: unknown[] = [];
  registerHistoryEditTools(server, {
    getSettings: async () => ({ account: { type: 'vip' } }),
    write: async (...args: unknown[]) => { calls.push(args); return result; },
  } as unknown as LibraryAdapter, () => 'token', () => scope);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = { name: 'simkl_edit_watch_dates', arguments: { movies: [{ ids, rewatch_id: 10, watched_at: timestamp }] } };
    expect((await client.callTool(request)).isError).toBe(true);
    expect(calls).toEqual([]);
    scope = 'media:read media:write';
    expect((await client.callTool(request)).structuredContent).toEqual({ ...result, outcome: 'partial_success' });
    expect(calls).toEqual([['/sync/history/edit-dates', {
      method: 'POST', body: { movies: [{ ids, rewatch_id: 10, watched_at: normalized }] },
    }, 'token']]);
  } finally {
    await client.close();
    await server.close();
  }
});
