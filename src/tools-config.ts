import { formatList, withImdb, withRating } from './format/media.js';

type ResponseFormat =
  | { type: 'simple', template: (result: any, args: any) => string | string[] }
  | { type: 'json', mediaType?: 'tv' | 'movies' | 'anime', tvFinaleDescriptions?: boolean };

interface ToolConfig {
  path: string;
  schemaPath?: string;
  method: string;
  schemaMethod?: string;
  authorization?: 'bearer' | 'none';
  requestPath?: { helper: string; args: string[] };
  name?: string;
  responseFormat?: ResponseFormat;
  omitParams?: string[];
  omitFromGenerated?: boolean;
  description?: string;
  parameterDescriptions?: Record<string, string>;
  extraQueryParams?: string[];
  batchArrayFields?: string[];
  legacyEpisodeAlias?: boolean;
  custom?: {
    name: string;
    schema: string;
    handler: string;
    imports?: string[];
  };
}

export const toolsWhitelist: ToolConfig[] = [
  {
    path: '/discover/trending/:type/genre/:genre',
    method: 'get',
    description: 'Get monthly trending titles for one genre from Simkl’s public CDN. Rankings are updated daily, contain up to 500 titles, and have no upstream pagination. The CDN request needs no user token and uses no Simkl daily quota or per-second rate. Supply an exact genre slug from the selected media type’s genre index; returns up to maxResults rich items without fetching details per title.',
    custom: {
      name: 'simkl_get_trending_by_genre',
      schema: "z.object({ type: z.enum(['tv', 'movies', 'anime']), genre: z.string().min(1).max(100), maxResults: z.number().int().min(1).max(100).optional() })",
      imports: ["import { getTrendingByGenre } from '../src/api/trending.js';"],
      handler: `async (args: any) => {
        try {
          const result = await getTrendingByGenre(client, args.type, args.genre, args.maxResults);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return toMcpErrorResult(error);
        }
      }`,
    },
  },
  // search
  { path: '/search/:type', method: 'get', responseFormat: {
    type: 'simple',
    template: (results: any, args: any) => results.length > 0
      ? formatList(results, withImdb, 10, args.type)
      : [`no results for "${args.q}"`]
  }},
  {
    path: '/search/id',
    method: 'get',
    description: 'Resolve a supported media ID through Simkl’s public redirect endpoint, then return the matching cached detail record.',
    custom: {
      name: 'simkl_search_by_id',
      schema: "z.object({ simkl: z.number().int().positive().optional(), hulu: z.number().int().positive().optional(), netflix: z.number().int().positive().optional(), mal: z.number().int().positive().optional(), tvdb: z.string().optional(), tmdb: z.number().int().positive().optional(), imdb: z.string().regex(/^tt\\d+$/).optional(), anidb: z.number().int().positive().optional(), crunchyroll: z.string().optional(), anilist: z.number().int().positive().optional(), kitsu: z.number().int().positive().optional(), livechart: z.number().int().positive().optional(), anisearch: z.number().int().positive().optional(), animeplanet: z.string().optional(), anfo: z.string().optional(), ann: z.number().int().positive().optional(), tvcom: z.string().optional(), zap2it: z.string().optional(), traktslug: z.string().optional(), letterboxd: z.string().optional(), boxd: z.string().optional(), mdl: z.string().optional(), type: z.enum(['show', 'tv', 'movie', 'anime']).optional(), title: z.string().optional(), year: z.number().int().optional(), season: z.number().int().positive().optional(), episode: z.number().int().positive().optional() })",
      imports: ["import { getMediaById } from '../src/api/id-lookup.js';"],
      handler: `async (args: any) => {
        try {
          const result = await getMediaById(client, args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return toMcpErrorResult(error);
        }
      }`,
    },
  },

  // scrobble
  { path: '/scrobble/start', method: 'post', responseFormat: {
    type: 'simple',
    template: (_: any, args: any) => `started: ${args.movie?.title || args.show?.title}`
  }},
  { path: '/scrobble/pause', method: 'post', responseFormat: {
    type: 'simple',
    template: (_: any, args: any) => {
      const body = args.body || args;
      const title = body.movie?.title || body.show?.title || body.anime?.title;
      return `paused at ${body.progress}%${title ? `: ${title}` : ''}`;
    }
  }},
  { path: '/scrobble/stop', method: 'post', omitFromGenerated: true, responseFormat: {
    type: 'simple',
    template: (_: any, args: any) => `stopped: ${args.movie?.title || args.show?.title}`
  }},

  // sync
  { path: '/sync/add-to-list', method: 'post', responseFormat: {
    type: 'simple',
    template: (_: any, args: any) => `added to watchlist: ${(args.movie || args.show || args.anime)?.title}`
  }},
  { path: '/sync/history', method: 'post', batchArrayFields: ['movies', 'shows', 'anime', 'episodes'], legacyEpisodeAlias: true, description: 'Add one or more items to history in a single request using movies[], shows[], anime[], and/or episodes[]. The legacy single episode argument remains supported.', responseFormat: { 'type': 'json' }},
  { path: '/sync/history/remove', method: 'post', batchArrayFields: ['movies', 'shows', 'anime', 'episodes'], legacyEpisodeAlias: true, description: 'Remove one or more items from history in a single request using movies[], shows[], anime[], and/or episodes[]. The legacy single episode argument remains supported.', responseFormat: { 'type': 'json' }},
  { path: '/sync/ratings', method: 'post', responseFormat: { 'type': 'json' }},
  { path: '/sync/ratings/remove', method: 'post', responseFormat: { 'type': 'json' }},

  // discovery
  { path: '/tv/trending/:interval', schemaPath: '/discover/trending/{type}/{file}.json', method: 'get', authorization: 'none', requestPath: { helper: 'simklTrendingPath', args: ["'tv'", 'args.interval'] }, responseFormat: {
    type: 'simple',
    template: (results: any) => formatList(results, undefined, 20, 'tv')
  }},
  { path: '/movies/trending/:interval', schemaPath: '/discover/trending/{type}/{file}.json', method: 'get', authorization: 'none', requestPath: { helper: 'simklTrendingPath', args: ["'movies'", 'args.interval'] }, responseFormat: {
    type: 'simple',
    template: (results: any) => formatList(results, undefined, 20, 'movies')
  }},
  { path: '/anime/trending/:interval', schemaPath: '/discover/trending/{type}/{file}.json', method: 'get', authorization: 'none', requestPath: { helper: 'simklTrendingPath', args: ["'anime'", 'args.interval'] }, responseFormat: {
    type: 'simple',
    template: (results: any) => formatList(results, undefined, 20, 'anime')
  }},

  { path: '/tv/:id', method: 'get', authorization: 'none', responseFormat: { type: 'json', mediaType: 'tv' }},
  { path: '/movies/:id', method: 'get', authorization: 'none', responseFormat: { type: 'json', mediaType: 'movies' }},
  { path: '/anime/:id', method: 'get', authorization: 'none', responseFormat: { type: 'json', mediaType: 'anime' }},

  { path: '/tv/episodes/:id', method: 'get', authorization: 'none', description: 'List TV episodes with finale_type_description (Mid-season Finale, Season Finale, Series Finale, or Not a finale). Simkl's null finale_type means Not a finale; numeric finale_type codes are omitted from the MCP response. Anime is unaffected.', responseFormat: { type: 'json', tvFinaleDescriptions: true }},
  { path: '/anime/episodes/:id', method: 'get', authorization: 'none', responseFormat: { type: 'json' }},

  { path: '/tv/best/:filter', method: 'get', responseFormat: {
    type: 'simple',
    template: (results: any) => formatList(results, withRating, 20, 'tv')
  }},
  { path: '/anime/best/:filter', method: 'get', responseFormat: {
    type: 'simple',
    template: (results: any) => formatList(results, withRating, 20, 'anime')
  }},

  {
    path: '/tv/airing',
    method: 'get',
    description: 'Get TV episode airings for a local calendar day from Simkl’s free v2 calendar file. Optional IANA timeZone; defaults to UTC.',
    custom: {
      name: 'simkl_get_airing_shows',
      schema: "z.object({ date: z.string().optional().describe('Optional: today, tomorrow, or DD-MM-YYYY (e.g. 15-03-2026); selected in timeZone.'), sort: z.enum(['time', 'rank', 'popularity']).optional(), timeZone: z.string().optional().describe('IANA time zone (e.g. America/Sao_Paulo). Defaults to UTC.') })",
      imports: ["import { formatAiringTool } from '../src/api/airing.js';"],
      handler: `async (args: any) => {
        try {
          return await formatAiringTool(client, 'tv', args);
        } catch (error) {
          return toMcpErrorResult(error);
        }
      }`,
    },
  },
  {
    path: '/anime/airing',
    method: 'get',
    description: 'Get anime episode airings for a local calendar day from Simkl’s free v2 calendar file. Optional IANA timeZone; defaults to UTC.',
    custom: {
      name: 'simkl_get_airing_anime',
      schema: "z.object({ date: z.string().optional().describe('Optional: today, tomorrow, or DD-MM-YYYY (e.g. 15-03-2026); selected in timeZone.'), sort: z.enum(['time', 'rank', 'popularity']).optional(), timeZone: z.string().optional().describe('IANA time zone (e.g. America/Sao_Paulo). Defaults to UTC.') })",
      imports: ["import { formatAiringTool } from '../src/api/airing.js';"],
      handler: `async (args: any) => {
        try {
          return await formatAiringTool(client, 'anime', args);
        } catch (error) {
          return toMcpErrorResult(error);
        }
      }`,
    },
  },

  // genre filtering
  { path: '/tv/genres/:genre/:type/:country/:network/:year/:sort', method: 'get', extraQueryParams: ['page', 'limit'], description: 'Live TV genre browsing supports other sorts and country, network, and year filters. Under AUTH V2 it requires the user access token and consumes the user’s daily allowance; live requests also count toward the per-second limit. Pagination is capped at page 20 and 60 items per page. Prefer simkl_get_trending_by_genre for this month’s most watched titles in one genre (daily-updated CDN file, no token or upstream quota).', responseFormat: {
    type: 'simple',
    template: (results: any) => Array.isArray(results) ? formatList(results, undefined, 20, 'tv') : ['no results for this genre']
  }},
  { path: '/anime/genres/:genre/:type/:network/:year/:sort', method: 'get', extraQueryParams: ['page', 'limit'], description: 'Live anime genre browsing supports other sorts and network and year filters. Under AUTH V2 it requires the user access token and consumes the user’s daily allowance; live requests also count toward the per-second limit. Pagination is capped at page 20 and 60 items per page. Prefer simkl_get_trending_by_genre for this month’s most watched titles in one genre (daily-updated CDN file, no token or upstream quota).', responseFormat: {
    type: 'simple',
    template: (results: any) => Array.isArray(results) ? formatList(results, undefined, 20, 'anime') : ['no results for this genre']
  }},
  { path: '/movies/genres/:genre/:type/:country/:year/:sort', method: 'get', extraQueryParams: ['page', 'limit'], description: 'Live movie genre browsing supports other sorts and country and year filters. Under AUTH V2 it requires the user access token and consumes the user’s daily allowance; live requests also count toward the per-second limit. Pagination is capped at page 20 and 60 items per page. Prefer simkl_get_trending_by_genre for this month’s most watched titles in one genre (daily-updated CDN file, no token or upstream quota).', responseFormat: {
    type: 'simple',
    template: (results: any) => Array.isArray(results) ? formatList(results, undefined, 20, 'movies') : ['no results for this genre']
  }},

  // user stats
  {
    path: '/users/:user_id/stats',
    method: 'get',
    description: 'Get watch statistics for another explicitly identified Simkl user. For your own authenticated account, use simkl_my_stats instead: it reads the per-account cache without a settings lookup.',
    parameterDescriptions: {
      user_id: 'Numeric Simkl ID of another explicitly identified user. For your own account, use simkl_my_stats with no arguments; do not fetch /users/settings.',
    },
    responseFormat: { type: 'json' },
  },

  // watchlist (cached library)
  {
    path: '/sync/all-items/:type/:status',
    method: 'get',
    description: 'Search the authenticated user’s cached watchlist. Filters by media type, status, and title, then returns compact matching items with progress, next episode, rating, and a Simkl link.',
    custom: {
      name: 'simkl_get_watchlist',
      schema: "z.object({ type: z.enum(['shows', 'movies', 'anime']).optional(), status: z.enum(['watching', 'plantowatch', 'hold', 'completed', 'dropped']).optional(), title: z.string().optional().describe('Case-insensitive title substring.'), limit: z.number().int().min(1).max(100).optional().describe('Maximum results; defaults to 50.'), offset: z.number().int().min(0).optional().describe('Zero-based number of matching results to skip; defaults to 0.') }).strict()",
      handler: `async (args: any) => {
        try {
          if (!hooks.getWatchlist) throw new Error('Cached watchlist is unavailable');
          return { content: [{ type: 'text', text: await hooks.getWatchlist(args) }] };
        } catch (error) {
          if (error instanceof LibraryQueryError) return { isError: true, content: [{ type: 'text', text: error.message }] };
          return toMcpErrorResult(error);
        }
      }`,
    },
  },
];
