import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasValidMediaIds, RewatchService, type RewatchMediaType, type RewatchWriteMediaType, type RewatchStatus } from '../api/rewatches.js';
import { toMcpErrorResult } from '../api/errors.js';
import { SimklApiError } from '../api/client.js';

const mediaType = z.enum(['movies', 'shows', 'anime']);
const listMediaType = z.enum(['all', 'movies', 'shows', 'anime']);
const ids = z.record(z.string(), z.union([z.string(), z.number()])).refine(
  value => hasValidMediaIds(value),
  'at least one valid media identifier is required',
);
const episode = z.object({ number: z.number().int().positive(), watched_at: z.string().datetime().optional() }).passthrough();
const season = z.object({ number: z.number().int().nonnegative(), episodes: z.array(episode).optional() }).passthrough();
const date = z.string().datetime();

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function rewatchErrorResult(error: unknown, mutation = false) {
  if (error instanceof SimklApiError && (error.statusCode === 0 || error.statusCode < 400) && mutation) {
    return { isError: true, content: [{ type: 'text' as const, text: 'The Simkl write may have succeeded despite the connection failure. Read rewatch sessions and history before retrying.' }] };
  }
  if (error instanceof SimklApiError) return toMcpErrorResult(error);
  return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Simkl request failed' }] };
}

export function registerRewatchTools(server: McpServer, service: RewatchService, afterLibraryWrite?: () => Promise<void>): void {
  async function mutationResult(value: unknown) {
    if (afterLibraryWrite) {
      try { await afterLibraryWrite(); }
      catch { throw new Error('Upstream write succeeded, but library cache invalidation failed'); }
    }
    return jsonResult(value);
  }
  server.registerTool('simkl_start_rewatch', {
    description: 'Explicitly start or resume a Simkl rewatch session for a movie, TV show or anime already in the user history. Requires PRO/VIP. Simkl applies a two-day gap between repeat watches. The response includes the upstream rewatch_id and status; retain the ID for later updates.',
    inputSchema: {
      mediaType,
      ids,
      rewatch_id: z.number().int().positive().optional(),
      rewatch_status: z.enum(['active', 'closed', 'completed'] as const).optional(),
      watched_at: date.optional(),
      seasons: z.array(season).optional(),
    },
    annotations: { destructiveHint: true },
  }, async args => {
    try {
      return await mutationResult(await service.start({
        mediaType: args.mediaType as RewatchWriteMediaType,
        ids: args.ids,
        ...(args.rewatch_id !== undefined ? { rewatch_id: args.rewatch_id } : {}),
        ...(args.rewatch_status ? { rewatch_status: args.rewatch_status as RewatchStatus } : {}),
        ...(args.watched_at ? { watched_at: args.watched_at } : {}),
        ...(args.seasons ? { seasons: args.seasons } : {}),
      }));
    } catch (error) { return rewatchErrorResult(error, true); }
  });

  server.registerTool('simkl_update_rewatch', {
    description: 'Add viewing events to a specific rewatch session. Always supply the rewatch_id returned by Simkl. TV/anime completion is determined by Simkl when all aired regular episodes are covered.',
    inputSchema: {
      mediaType,
      ids,
      rewatch_id: z.number().int().positive(),
      rewatch_status: z.enum(['active', 'closed', 'completed'] as const).optional(),
      watched_at: date.optional(),
      seasons: z.array(season).optional(),
    },
    annotations: { destructiveHint: true },
  }, async args => {
    try {
      return await mutationResult(await service.update({
        mediaType: args.mediaType as RewatchWriteMediaType,
        ids: args.ids,
        rewatch_id: args.rewatch_id,
        ...(args.rewatch_status ? { rewatch_status: args.rewatch_status as RewatchStatus } : {}),
        ...(args.watched_at ? { watched_at: args.watched_at } : {}),
        ...(args.seasons ? { seasons: args.seasons } : {}),
      }));
    } catch (error) { return rewatchErrorResult(error, true); }
  });

  server.registerTool('simkl_get_rewatches', {
    description: 'Read compact rewatch sessions from the per-user activities-gated cache, separate from the canonical watchlist. No incremental sync parameters are accepted.',
    inputSchema: {
      mediaType: listMediaType,
      status: z.enum(['watching', 'plantowatch', 'hold', 'completed', 'dropped']),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async args => {
    try {
      return { content: [{ type: 'text' as const, text: await service.list({
        mediaType: args.mediaType as RewatchMediaType,
        status: args.status,
      }) }] };
    } catch (error) { return rewatchErrorResult(error); }
  });

  server.registerTool('simkl_stop_watching', {
    description: 'Stop watching and return the Simkl scrobble response. A 409 already_watched conflict is an already_recorded success with the original watched_at: do not retry. Set allow_rewatch=true only when the user explicitly chose to record this playback as a rewatch; it requires PRO/VIP and progress of at least 80%.',
    inputSchema: {
      body: z.record(z.string(), z.unknown()),
      allow_rewatch: z.boolean().optional().describe('Explicitly record this stop as a rewatch. Defaults to false.'),
    },
    annotations: { destructiveHint: true },
  }, async args => {
    try {
      return await mutationResult(await service.stop({ body: args.body, allow_rewatch: args.allow_rewatch }));
    } catch (error) {
      if (error instanceof SimklApiError && error.statusCode === 409) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: 'Simkl returned an unrecognized scrobble stop conflict (HTTP 409). The server could not validate an already-recorded response. Check the watch history before any manual retry; no automatic retry was performed.',
          }],
        };
      }
      return rewatchErrorResult(error, true);
    }
  });
}
