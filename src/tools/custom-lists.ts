import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CustomListsService, customListErrorResult } from '../api/custom-lists.js';

// Enums mirror api/simkl-openapi.json; tests/custom-lists.test.ts fails if they drift.
export const CUSTOM_LIST_USER_SORTS = ['updated', 'created', 'name', 'likes', 'followers', 'items', 'popularity'] as const;
export const CUSTOM_LIST_PRIVACY = ['public', 'unlisted', 'private'] as const;
export const CUSTOM_LIST_MEDIA_TYPES = ['movies', 'tv', 'anime'] as const;
export const CUSTOM_LIST_PERMISSIONS = [
  'full', 'privacy', 'list_type', 'default_sort', 'title', 'description', 'public_tags', 'private_tags',
  'background', 'add', 'suggest', 'delete', 'rearrange', 'import', 'public_notes', 'read_private_notes',
  'edit_private_notes', 'comments',
] as const;

const listId = z.number().int().positive().describe('Numeric Simkl custom list ID.');
const page = z.number().int().min(1).optional().describe('1-based page; page × limit cannot exceed 10000.');
const limit = z.number().int().min(1).max(500).optional().describe('Items per page, 1-500. Defaults to 50.');
const direction = z.enum(['asc', 'desc']).optional();

const ids = z.record(z.string(), z.union([z.string(), z.number()]))
  .describe('Any supported write ID: simkl (or simkl_id), imdb, tmdb, tvdb, mal, anidb, anilist, kitsu, livechart, anisearch, animeplanet, netflix, letterboxd, traktslug, crunchyroll, hulu. Send every ID you have. slug is response-only and is rejected.');

const itemBase = {
  ids: ids.optional(),
  title: z.string().min(1).optional().describe('Title fallback when no ID is known; add year to disambiguate.'),
  year: z.number().int().optional(),
  season: z.number().int().min(0).optional().describe('Anime only: add the entry covering this season. 0 means no hint.'),
  seasons: z.array(z.object({ number: z.number().int().min(0) }).strict()).max(100).optional()
    .describe('Anime only: several seasons at once; each becomes its own entry.'),
};
const addItem = z.object({
  ...itemBase,
  note: z.object({
    public: z.string().max(4096).optional(),
    private: z.string().max(4096).optional(),
  }).strict().optional().describe('Public note shown to everyone who can see the list; private note for the owner and permitted collaborators.'),
  user_position: z.number().int().min(1).optional()
    .describe('1-based position in the list’s own order. Titles after it shift down; past the end means the end.'),
}).strict();
const removeItem = z.object(itemBase).strict();

const addItems = {
  movies: z.array(addItem).optional(),
  shows: z.array(addItem).optional(),
  anime: z.array(addItem).optional(),
};
const removeItems = {
  movies: z.array(removeItem).optional(),
  shows: z.array(removeItem).optional(),
  anime: z.array(removeItem).optional(),
};
const allowReorder = z.boolean().optional()
  .describe('Let the posted order move titles already on the list. Without it, existing titles stay put and only user_position moves a title.');

const tag = z.string().min(1).max(100).regex(/^[^,"'<>]+$/, 'tags cannot contain commas, quotes, < or >');
const details = {
  privacy: z.enum(CUSTOM_LIST_PRIVACY).optional(),
  description: z.object({
    short: z.string().max(140).optional(),
    full: z.string().optional(),
  }).strict().optional().describe('Send either key alone; the other is kept. "" clears one.'),
  note: z.string().optional().describe('Owner’s private note on the whole list. "" clears it.'),
  display_number: z.boolean().optional().describe('Show rank numbers beside titles.'),
  sort: z.object({
    by: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'sort token must be short lower-case letters, digits, _ or -')
      .describe('Order token, e.g. position (manual order), rating, title, added.'),
    direction: z.enum(['asc', 'desc']).optional(),
  }).strict().optional().describe('The list’s own default order. Refused on auto lists.'),
  tags: z.array(tag).max(20).optional().describe('REPLACES the whole public tag set; [] removes all tags.'),
  private_tags: z.array(tag).max(20).optional().describe('REPLACES the whole private tag set; [] removes all.'),
  collaborators: z.array(z.object({
    user: z.number().int().positive().describe('Simkl user ID the caller follows.'),
    permissions: z.array(z.enum(CUSTOM_LIST_PERMISSIONS)).optional().describe('Omit or [] for read-only access.'),
  }).strict()).max(10).optional()
    .describe('REPLACES the whole collaborator set: anyone omitted is removed, [] removes everyone. Adding someone new needs VIP.'),
};

const BETA = 'Simkl Custom Lists are a beta PRO/VIP feature and need the user’s AUTH V2 token.';
const NO_POLL = 'Call only on explicit user request: every call spends the user’s shared daily allowance, so never poll or re-read lists on a schedule.';
const WRITE = 'Requires the media:write scope. Writes for one account run one at a time; an ambiguous failure is never replayed automatically.';

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerCustomListTools(server: McpServer, service: CustomListsService): void {
  const read = <T>(operation: (args: T) => Promise<unknown>) => async (args: T) => {
    try { return json(await operation(args)); }
    catch (error) { return customListErrorResult(error, false); }
  };
  const write = <T>(operation: (args: T) => Promise<unknown>) => async (args: T) => {
    try { return json(await operation(args)); }
    catch (error) { return customListErrorResult(error, true); }
  };

  server.registerTool('simkl_get_user_custom_lists', {
    description: `List a user’s custom lists with pagination. Omit user_id for your own account (includes private/unlisted lists and pinned flags). ${BETA} ${NO_POLL}`,
    inputSchema: {
      user_id: z.number().int().positive().optional().describe('Numeric Simkl user ID. Omit for the authenticated account.'),
      page, limit, direction,
      sort: z.enum(CUSTOM_LIST_USER_SORTS).optional(),
      followed: z.boolean().optional().describe('Include lists the user follows.'),
      collaborants: z.boolean().optional().describe('Include lists the user collaborates on (own account only).'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, read(args => service.listUserLists(args)));

  server.registerTool('simkl_get_custom_list', {
    description: `Get one custom list’s details and a page of its titles. A free account receives an upgrade placeholder, reported as an error rather than list data. ${BETA} ${NO_POLL}`,
    inputSchema: {
      list_id: listId,
      page, limit, direction,
      sort: z.string().max(40).optional().describe('Free-form order token; unknown tokens silently fall back. Omit to use the owner’s order.'),
      extended: z.boolean().optional().describe('Add an overview to every item.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, read(args => service.getList(args)));

  server.registerTool('simkl_create_custom_list', {
    description: `Create a custom list. name and media_type are required; media_type cannot change later. New lists are public unless privacy is set. Plan limits: 30 lists on PRO, 1,000 on VIP. ${BETA} ${WRITE}`,
    inputSchema: {
      name: z.string().min(1).max(255),
      media_type: z.enum(CUSTOM_LIST_MEDIA_TYPES),
      ...details,
    },
    annotations: { destructiveHint: false },
  }, write(args => service.createList(args)));

  server.registerTool('simkl_update_custom_list', {
    description: `Edit a custom list’s details. Send only fields that change; omitted fields are kept. tags, private_tags and collaborators each REPLACE the whole set: read the list first and send the complete desired set. media_type cannot change; titles are edited with simkl_add_custom_list_items. ${BETA} ${WRITE}`,
    inputSchema: {
      list_id: listId,
      name: z.string().min(1).max(255).optional(),
      ...details,
    },
    annotations: { destructiveHint: true },
  }, write(args => service.updateList(args)));

  server.registerTool('simkl_delete_custom_list', {
    description: `Permanently delete a custom list with its titles, likes, follows and comments. There is no undo. Owner or a collaborator with full permission only. ${BETA} ${WRITE}`,
    inputSchema: { list_id: listId },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, write(args => service.deleteList(args)));

  server.registerTool('simkl_add_custom_list_items', {
    description: `Add titles to a custom list, move them with user_position, or set their notes, in one request (up to 1000 titles). New titles go to the end in posted order; titles already on the list keep their place unless user_position or allow_reorder is used. Titles of the wrong media type come back in wrong_type. ${BETA} ${WRITE}`,
    inputSchema: { list_id: listId, allow_reorder: allowReorder, ...addItems },
    annotations: { destructiveHint: false },
  }, write(args => service.addItems(args)));

  server.registerTool('simkl_remove_custom_list_items', {
    description: `Remove titles from a custom list (up to 1000). Titles not on the list come back in not_found. ${BETA} ${WRITE}`,
    inputSchema: { list_id: listId, ...removeItems },
    annotations: { destructiveHint: true },
  }, write(args => service.removeItems(args)));

  server.registerTool('simkl_add_favorites', {
    description: `Favorite titles (the heart on simkl.com). Each title goes to the account’s favorite list of its own media type, creating it if needed. Same ordering rules as simkl_add_custom_list_items. ${BETA} ${WRITE}`,
    inputSchema: { allow_reorder: allowReorder, ...addItems },
    annotations: { destructiveHint: false },
  }, write(args => service.addFavorites(args)));

  server.registerTool('simkl_remove_favorites', {
    description: `Unfavorite titles. Titles that are not favorites come back in not_found. ${BETA} ${WRITE}`,
    inputSchema: removeItems,
    annotations: { destructiveHint: true },
  }, write(args => service.removeFavorites(args)));
}
