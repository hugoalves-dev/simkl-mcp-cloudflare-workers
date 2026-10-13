import { APP_NAME, APP_VERSION } from './app-info';
import type { SimklOAuthEnv } from './auth/simkl-oauth';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { SimklClient } from './api/client.js';
import { simklTrendingPath } from './api/trending.js';
import { RewatchService } from './api/rewatches.js';
import { registerRewatchTools } from './tools/rewatches.js';
import { registerTools } from '../generated/tools.js';
import { createLibraryAdapter, type LibraryAdapter } from './library/adapter';
import { toMcpErrorResult } from './api/errors';
import { selectWatchlist, watchlistResourceContents } from './library/watchlist';

interface Env extends WorkerEnv, SimklOAuthEnv {}

interface SimklAuthProps extends Record<string, unknown> {
  simklToken: string;
  simklUserId?: string;
}

export class SimklMCP extends McpAgent<Env, unknown, SimklAuthProps> {
  server = new McpServer({
    name: `${APP_NAME}-server`,
    version: APP_VERSION,
  });

  private client!: SimklClient;
  private library!: LibraryAdapter;
  private get simklToken(): string | undefined {
    return this.props?.simklToken;
  }

  async init() {
    this.client = new SimklClient({
      baseUrl: this.env?.SIMKL_API_BASE_URL || 'https://api.simkl.com',
      clientId: this.env?.SIMKL_CLIENT_ID || '',
    });

    this.library = createLibraryAdapter(this.env, this.client, () => this.props);
    const rewatchService = new RewatchService(this.client, () => this.simklToken, Date.now, (path, options) =>
      this.library.write(path, options, options.token));
    registerTools(this.server, this.client, () => this.simklToken, {
      getWatchlist: async args => {
        const lines = selectWatchlist(await this.library.read(), args);
        return lines.length ? lines.join('\n') : 'no watchlist items matched';
      },
      write: (path, options) => this.library.write(path, options),
    });
    registerRewatchTools(this.server, rewatchService);
    this.registerCustomTools();
    this.registerResources();
  }

  private registerCustomTools() {
    this.server.registerTool('simkl_refresh_library', {
      description: 'Force an incremental refresh of the authenticated Simkl library, bypassing the activities check interval',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    }, async () => {
      try {
        await this.library.read(true);
        return { content: [{ type: 'text' as const, text: 'Simkl library refreshed' }] };
      } catch (error) { return { ...toMcpErrorResult(error) }; }
    });
    // simkl_my_stats - get stats for current user
    this.server.registerTool(
      'simkl_my_stats',
      {
        description: 'Get watching statistics for the current authenticated user',
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const stats = await this.library.getStats();
          return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        } catch (error) { return { ...toMcpErrorResult(error) }; }
      }
    );
  }

  private registerResources() {
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

    this.server.registerResource(
      'watchlist',
      watchlistTemplate,
      {
        mimeType: 'text/plain',
        description: 'user watchlist by type and status',
      },
      async (uri, variables) => {
        const { type, status } = variables;
        return watchlistResourceContents(uri.toString(), type as string, status as string, await this.library.read());
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
                mimeType: 'application/json' as const,
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

    this.server.registerResource(
      'trending',
      trendingTemplate,
      {
        mimeType: 'text/plain',
        description: 'trending content by type and interval',
      },
      async (uri, variables) => {
        const { type, interval } = variables;
        const response = await this.client.request<any[]>(simklTrendingPath(type as 'tv' | 'movies' | 'anime', interval as 'daily' | 'weekly' | 'monthly'), {
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
            const simklId = item.ids?.simkl || item.ids?.simkl_id || 'unknown';
            const title = item.title || 'unknown';
            const year = item.year || 'N/A';
            const rating = item.ratings?.simkl?.rating || 'N/A';
            const text = `${index}: [SIMKL #${simklId}] - ${title} (${year}) - rating: ${rating}`;

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
}
