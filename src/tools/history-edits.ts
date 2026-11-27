import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SimklApiError } from '../api/client';
import { toMcpErrorResult } from '../api/errors';
import { hasValidMediaIds } from '../api/rewatches';
import type { LibraryAdapter } from '../library/adapter';

const id = z.number().int().positive();
const target = {
  ids: z.record(z.string(), z.union([z.string(), z.number()])).refine(hasValidMediaIds, 'Supply a valid media ID, preferably ids.simkl'),
  title: z.string().optional(),
  year: z.number().int().optional(),
};
const utc = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)))
  .transform(value => new Date(value).toISOString());
const watchDate = utc.refine(value => value !== '1970-01-01T00:00:01.000Z', 'Simkl does not support editing to the unknown watch date');
const episode = z.strictObject({ number: z.number().int().nonnegative(), watched_at: watchDate });
const dateFields = { ...target, added_at: utc.optional(), watched_at: watchDate.optional(), rewatch_id: id.optional() };
const movieDate = z.strictObject(dateFields).refine(item => item.added_at || item.watched_at, 'Supply a date to edit');
const showDate = z.strictObject({
  ...dateFields,
  seasons: z.array(z.strictObject({ number: z.number().int().nonnegative(), episodes: z.array(episode).min(1) })).min(1).optional(),
  episodes: z.array(episode).min(1).optional(),
});
const show = showDate.refine(validShowDates, 'Supply a date or episodes. A show-level watched_at requires rewatch_id. Use seasons or episodes.');
const anime = showDate.extend({ use_tvdb_anime_seasons: z.boolean().optional() })
  .refine(validShowDates, 'Supply a date or episodes. An anime-level watched_at requires rewatch_id. Use seasons or episodes.');

function validShowDates(item: z.infer<typeof showDate>) {
  return (!item.watched_at || item.rewatch_id !== undefined) && !(item.episodes && item.seasons)
    && Boolean(item.added_at || item.watched_at || item.episodes || item.seasons);
}

const memoText = z.string().refine(text => {
  const lines = text.replace(/\r\n?/g, '\n');
  return Array.from(text).length <= 140 && lines.split('\n').length <= 6 && !lines.includes('\n\n\n');
}, 'Use at most 140 characters, five line breaks and two consecutive line breaks.').describe(
  'Simkl trims text and removes HTML tags and emoji. An empty string clears the memo.',
);
const memo = z.strictObject({
  ...target,
  memo: z.union([memoText, z.strictObject({ text: memoText, is_private: z.boolean().optional() })]),
});
function batch<M extends z.ZodType, S extends z.ZodType, A extends z.ZodType>(movie: M, show: S, anime: A) {
  return z.strictObject({
    movies: z.array(movie).min(1).optional(),
    shows: z.array(show).min(1).optional(),
    anime: z.array(anime).min(1).optional(),
  }).refine(value => value.movies || value.shows || value.anime, 'Supply at least one media item');
}
export const editWatchDatesInput = batch(movieDate, show, anime);
export const editMemosInput = batch(memo, memo, memo);

const entries = z.array(z.looseObject({}));
const count = z.number().int().nonnegative();
const updatedSchema = z.object({ statuses: entries, movies: count });
const resultSchema = z.object({
  not_found: z.looseObject({ movies: entries, shows: entries, episodes: entries }),
  errors: entries,
  cache_reconciliation: z.literal('pending').optional(),
});
const datesResult = resultSchema.extend({ updated: updatedSchema.extend({ episodes: count }) });
const memosResult = resultSchema.extend({ updated: updatedSchema.extend({ shows: count }) });
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerHistoryEditTools(
  server: McpServer, library: LibraryAdapter,
  getToken: () => string | undefined, getScope: () => string | undefined,
) {
  async function edit(path: string, body: unknown, rewatch = false) {
    const token = getToken();
    const failure = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });
    if (!token || !getScope()?.split(/[\s,]+/).includes('media:write')) {
      return failure('Reconnect your Simkl account and grant media:write to edit library items.');
    }
    try {
      if (rewatch) {
        const settings = await library.getSettings(token);
        const account = settings.account as { type?: string } | undefined;
        if (!['pro', 'vip'].includes(String(account?.type).toLowerCase())) {
          return failure('Editing rewatch sessions requires a Simkl PRO or VIP account.');
        }
      }
      const schema = path === '/sync/history/edit-dates' ? datesResult : memosResult;
      const result = schema.safeParse(await library.write(path, { method: 'POST', body }, token));
      if (!result.success) return failure('Simkl returned an unexpected edit response. Check the library before retrying.');
      const { updated, not_found, errors } = result.data;
      const changed = updated.statuses.length > 0;
      const refused = errors.length > 0 || Object.values(not_found).some(value => Array.isArray(value) && value.length);
      const data = { ...result.data, outcome: refused ? (changed ? 'partial_success' : 'no_changes') : (changed ? 'success' : 'no_changes') };
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      if (error instanceof SimklApiError && error.statusCode === 403 && error.upstreamCode === 'insufficient_scope') {
        return failure('Reconnect your Simkl account and grant media:write to edit library items.');
      }
      return { ...toMcpErrorResult(error) };
    }
  }
  server.registerTool('simkl_edit_watch_dates', {
    description: 'Edit dates on existing Simkl library items. Use a rewatch_id only after the user chooses an existing session. Simkl saves future dates as now. Rewatch edits must respect the two-day gap.',
    inputSchema: editWatchDatesInput,
    annotations,
  }, async body => edit('/sync/history/edit-dates', body,
    [...(body.movies ?? []), ...(body.shows ?? []), ...(body.anime ?? [])].some(item => item.rewatch_id !== undefined)));
  server.registerTool('simkl_edit_memos', {
    description: 'Set, change or clear memos on existing Simkl titles. A string preserves existing privacy. New memos are public by default; use {text, is_private: true} for private notes.',
    inputSchema: editMemosInput,
    annotations,
  }, async body => edit('/sync/history/edit-memos', body));
}
