import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SimklClient } from './api/client.js';
import { simklTrendingPath } from './api/trending.js';
import { RewatchService } from './api/rewatches.js';
import { registerRewatchTools } from './tools/rewatches.js';
import { registerTools } from '../generated/tools.js';
import type { LibraryAdapter } from './library/adapter';
import { toMcpErrorResult } from './api/errors';
import { selectWatchlist, watchlistResourceContents } from './library/watchlist';
import { withRating } from './format/media';

// Both the deployed agent and build-time MCP discovery use this registration path.
export function registerCapabilities(server: McpServer, client: SimklClient, library: LibraryAdapter, getToken: () => string | undefined) {
    const rewatchService = new RewatchService(client, getToken, Date.now,
      (path, options) => library.write(path, options, options.token),
      token => library.getSettings(token),
      token => library.invalidateSettings(token),
      () => library.readRewatches());
    registerTools(server, client, getToken, {
      getWatchlist: async args => {
        const lines = selectWatchlist(await library.read(), args);
        return lines.length ? lines.join('\n') : 'no watchlist items matched';
      },
      write: (path, options) => library.write(path, options),
    });
    registerRewatchTools(server, rewatchService);
    registerCustomTools(server, library);
    registerResources(server, client, library);
}

function registerCustomTools(server: McpServer, library: LibraryAdapter) {
    server.registerTool('simkl_refresh_library', {
      description: 'Request a manual Simkl library refresh, limited to once every 60 seconds per account. Normal reads use the five-minute interval; post-write checks remain mandatory.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    }, async () => {
      try {
        const result = await library.refresh();
        if (result.status === 'suppressed') {
          return { content: [{ type: 'text' as const, text: `Manual Simkl library refresh skipped: only one forced refresh is allowed per 60 seconds per account. Retry in ${result.retryAfterSeconds} seconds. Normal cache freshness checks, including post-write checks, still apply.` }] };
        }
        return { content: [{ type: 'text' as const, text: 'Simkl library refreshed' }] };
      } catch (error) { return { ...toMcpErrorResult(error) }; }
    });
    // simkl_my_stats - get stats for current user
    server.registerTool(
      'simkl_my_stats',
      {
        description: 'Get watching statistics for the current authenticated user',
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const stats = await library.getStats();
          return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        } catch (error) { return { ...toMcpErrorResult(error) }; }
      }
    );
  }

function registerResources(server: McpServer, client: SimklClient, library: LibraryAdapter) {
    const watchlistTemplate = new ResourceTemplate(
      'simkl://watchlist/{type}/{status}',
      {
        list: async () => {
          const types = ['shows', 'movies', 'anime'];
          const statuses = ['watching', 'plantowatch', 'hold', 'completed', 'dropped'];

          return {
            resources: types.flatMap(type =>
              statuses.map(status => ({
                uri: `simkl://watchlist/${type}/${status}`,
                name: `${type} ${status}`,
                description: `${status} ${type}`,
                mimeType: 'text/plain' as const,
              }))
            )
          };
        },
        complete: {
          type: async () => ['shows', 'movies', 'anime'],
          status: async () => ['watching', 'plantowatch', 'hold', 'completed', 'dropped'],
        },
      }
    );

    server.registerResource(
      'watchlist',
      watchlistTemplate,
      {
        mimeType: 'text/plain',
        description: 'user watchlist by type and status',
      },
      async (uri, variables) => {
        const { type, status } = variables;
        return watchlistResourceContents(uri.toString(), type as string, status as string, await library.read());
      }
    );

    const trendingTemplate = new ResourceTemplate(
      'simkl://trending/{type}/{interval}',
      {
        list: async () => {
          const types = ['tv', 'movies', 'anime'];
          const intervals = ['daily', 'weekly', 'monthly'];

          return {
            resources: types.flatMap(type =>
              intervals.map(interval => ({
                uri: `simkl://trending/${type}/${interval}`,
                name: `trending ${type} (${interval})`,
                description: `${interval} trending ${type}`,
                mimeType: 'text/plain' as const,
              }))
            )
          };
        },
        complete: {
          type: async () => ['tv', 'movies', 'anime'],
          interval: async () => ['daily', 'weekly', 'monthly'],
        },
      }
    );

    server.registerResource(
      'trending',
      trendingTemplate,
      {
        mimeType: 'text/plain',
        description: 'trending content by type and interval',
      },
      async (uri, variables) => {
        const { type, interval } = variables;
        const response = await client.request<any[]>(simklTrendingPath(type as 'tv' | 'movies' | 'anime', interval as 'daily' | 'weekly' | 'monthly'), {
          method: 'GET',
          authorization: 'none',
        });

        const items = (response || []) as any[];
        const baseUri = uri.toString();

        // return empty content if no items
        if (items.length === 0) {
          return {
            contents: [{
              uri: baseUri,
              mimeType: 'text/plain',
              text: `no trending ${type} for ${interval}`,
            }],
          };
        }

        return {
          contents: items.map((item: any, index: number) => {
            const text = withRating(item, index, type as 'tv' | 'movies' | 'anime');

            return {
              uri: `${baseUri}#${index}`,
              mimeType: 'text/plain',
              text,
            };
          }),
        };
      }
    );
  }
