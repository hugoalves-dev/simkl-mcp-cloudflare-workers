import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { toolsWhitelist } from '../src/tools-config.js';

const spec = JSON.parse(readFileSync('api/simkl-openapi.json', 'utf-8'));

function singularize(word: string): string {
  const rules: [RegExp, string][] = [
    [/movies$/i, 'movie'],
    [/shows$/i, 'show'],
    [/series$/i, 'series'],
    [/episodes$/i, 'episode'],
    [/anime$/i, 'anime'],
    [/ies$/i, 'y'],
    [/s$/i, ''],
  ];

  for (const [pattern, replacement] of rules) {
    if (pattern.test(word)) {
      return word.replace(pattern, replacement);
    }
  }
  return word;
}

function normalizePath(p: string) {
  return p.replace(/:(\w+)/g, '{$1}').replace(/\?{(\w+)}/g, '?{$1}');
}

function pathToToolName(path: string) {
  const nameOverrides: Record<string, string> = {
    '/search/:type': 'simkl_search_by_text',
    '/search/id': 'simkl_search_by_id',
    '/scrobble/start': 'simkl_start_watching',
    '/scrobble/pause': 'simkl_pause_watching',
    '/scrobble/stop': 'simkl_stop_watching',
    '/sync/add-to-list': 'simkl_add_to_watchlist',
    '/sync/history': 'simkl_mark_watched',
    '/sync/history/remove': 'simkl_remove_from_history',
    '/sync/ratings': 'simkl_add_rating',
    '/sync/ratings/remove': 'simkl_remove_rating',
    '/sync/all-items/:type/:status': 'simkl_get_watchlist',
    '/tv/trending/:interval': 'simkl_get_trending_shows',
    '/movies/trending/:interval': 'simkl_get_trending_movies',
    '/anime/trending/:interval': 'simkl_get_trending_anime',
    '/tv/:id': 'simkl_get_show_by_id',
    '/movies/:id': 'simkl_get_movie_by_id',
    '/anime/:id': 'simkl_get_anime_by_id',
    '/tv/episodes/:id': 'simkl_get_show_episodes',
    '/anime/episodes/:id': 'simkl_get_anime_episodes',
    '/tv/best/:filter': 'simkl_get_best_shows',
    '/anime/best/:filter': 'simkl_get_best_anime',
    '/tv/airing': 'simkl_get_airing_shows',
    '/anime/airing': 'simkl_get_airing_anime',
    '/tv/genres/:genre/:type/:country/:network/:year/:sort': 'simkl_get_shows_by_genre',
    '/anime/genres/:genre/:type/:network/:year/:sort': 'simkl_get_anime_by_genre',
    '/movies/genres/:genre/:type/:country/:year/:sort': 'simkl_get_movies_by_genre',
    '/users/:user_id/stats': 'simkl_get_user_stats',
  };

  const name = nameOverrides[path];
  if (!name) {
    throw new Error(`No name mapping found for path: ${path}`);
  }
  return name;
}

function resolveLocalReference(value: any): any {
  if (!value?.$ref?.startsWith('#/')) return value;

  const target = value.$ref.slice(2).split('/').reduce((current: any, segment: string) => {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return current?.[key];
  }, spec);

  if (!target) throw new Error(`Unable to resolve OpenAPI reference: ${value.$ref}`);
  return { ...target, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')) };
}

function extractPathParams(path: string): string[] {
  const matches = path.matchAll(/:(\w+)/g);
  return Array.from(matches, m => m[1]);
}

function convertSchemaToZod(schema: any, depth = 0): string {
  if (!schema || depth > 5) return 'z.unknown()';

  // handle references
  if (schema.$ref) return 'z.unknown()';

  // handle arrays
  if (schema.type === 'array') {
    const items = schema.items ? convertSchemaToZod(schema.items, depth + 1) : 'z.unknown()';
    return `z.array(${items})`;
  }

  // handle objects
  if (schema.type === 'object' && schema.properties) {
    const props = Object.entries(schema.properties)
      .map(([key, propSchema]: [string, any]) => {
        const zodType = convertSchemaToZod(propSchema, depth + 1);
        const required = schema.required?.includes(key);
        return `${key}: ${zodType}${required ? '' : '.optional()'}`;
      })
      .join(', ');
    return `z.object({ ${props} }).partial().passthrough()`;
  }

  // handle primitives
  if (schema.enum) {
    return `z.enum([${schema.enum.map((v: string) => `'${v}'`).join(', ')}])`;
  }

  switch (schema.type) {
    case 'string': return 'z.string()';
    case 'number':
    case 'integer': return 'z.number()';
    case 'boolean': return 'z.boolean()';
    case 'object': return 'z.object({}).passthrough()';
    default: return 'z.unknown()';
  }
}

function generateParamSchema(path: string, params: any[], omitParams: string[] = [], extraQueryParams: string[] = [], batchArrayFields: string[] = [], legacyEpisodeAlias = false) {
  const fields: string[] = [];
  const pathParams = extractPathParams(path);
  const flattenedFields: Record<string, string> = {};

  // add path parameters first
  for (const pathParam of pathParams) {
    if (omitParams.includes(pathParam)) continue;

    // check if it exists in params array
    const existing = params.find(p => p.name === pathParam && p.in === 'path');
    if (existing) {
      // use the existing definition
      let zodType: string;
      if (existing.schema?.enum) {
        zodType = `z.enum([${existing.schema.enum.map((v: string) => `'${v}'`).join(', ')}])`;
      } else if (existing.schema?.type === 'number') {
        zodType = 'z.number()';
      } else {
        zodType = 'z.string()';
      }
      const desc = existing.description ? `.describe('${existing.description.replace(/'/g, "\\'").replace(/\n/g, ' ').substring(0, 200)}')` : '';
      fields.push(`      ${pathParam}: ${zodType}${desc}`);
    } else {
      // infer as string (most common case)
      fields.push(`      ${pathParam}: z.string()`);
    }
  }

  for (const param of params) {
    if (param.in === 'header' || param.in === 'path'
      || ['client_id', 'app-name', 'app-version'].includes(param.name)
      || omitParams.includes(param.name)) {
      continue;
    }

    const schema = param.schema || {};

    // flatten array fields in body
    if (param.in === 'body' && schema.type === 'object' && schema.properties) {
      let hasArrayFields = false;
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const ps = propSchema as any;
        if (batchArrayFields.includes(propName) && ps.type === 'array') {
          fields.push(`      ${propName}: ${convertSchemaToZod(ps, 1)}.optional()`);
          flattenedFields[`@batch:${propName}`] = propName;
          hasArrayFields = true;
          continue;
        }
        // check if this is an array of objects
        if (ps.type === 'array' && ps.items?.type === 'object') {
          hasArrayFields = true;
          // flatten: convert array to single object
          const singularName = singularize(propName);
          const itemSchema = convertSchemaToZod(ps.items, 1);
          fields.push(`      ${singularName}: ${itemSchema}.optional()`);
          flattenedFields[singularName] = propName;
        }
      }
      // if we found array fields to flatten, skip normal body processing
      if (hasArrayFields) {
        continue;
      }
    }

    const name = param.in === 'body' ? 'body' : param.name;
    const required = param.required !== false && param.in !== 'query';

    let zodType: string;

    // use schema converter for body and complex schemas
    if (param.in === 'body' || (schema.type === 'object' && schema.properties)) {
      zodType = convertSchemaToZod(schema);
    } else if (schema.enum) {
      zodType = `z.enum([${schema.enum.map((v: string) => `'${v}'`).join(', ')}])`;
    } else if (schema.type === 'integer' || schema.type === 'number') {
      zodType = 'z.number()';
    } else if (schema.type === 'boolean') {
      zodType = 'z.boolean()';
    } else if (schema.type === 'string') {
      zodType = 'z.string()';
    } else if (schema.type === 'array') {
      zodType = schema.items ? `z.array(${convertSchemaToZod(schema.items)})` : 'z.array(z.unknown())';
    } else {
      zodType = 'z.unknown()';
    }

    if (!required) zodType += '.optional()';
    if (param.description) {
      const desc = param.description.replace(/'/g, "\\'").replace(/\n/g, ' ').substring(0, 200);
      zodType += `.describe('${desc}')`;
    }

    fields.push(`      ${name}: ${zodType}`);
  }

  if (legacyEpisodeAlias) {
    fields.push('      episode: z.object({}).passthrough().optional()');
    flattenedFields.episode = 'episodes';
  }

  for (const name of extraQueryParams) {
    if (params.some((param: any) => param.name === name)) continue;
    const zodType = name === 'page'
      ? "z.number().int().min(1).max(20).optional().describe('Page number, capped at 20.')"
      : "z.number().int().min(1).max(60).optional().describe('Items per page, capped at 60.')";
    fields.push(`      ${name}: ${zodType}`);
  }

  return {
    schema: fields.length > 0 ? `{\n${fields.join(',\n')}\n    }` : '{}',
    flattenedFields
  };
}

function generateAnnotations(method: string, path: string): string {
  const annotations: string[] = [];
  const methodLower = method.toLowerCase();

  // readOnlyHint for GET methods
  if (methodLower === 'get') {
    annotations.push('readOnlyHint: true');
  }

  // destructiveHint for DELETE or endpoints that remove/delete
  if (methodLower === 'delete' || path.includes('remove') || path.includes('delete')) {
    annotations.push('destructiveHint: true');
  }

  // idempotentHint
  if (methodLower === 'get' || methodLower === 'put' || methodLower === 'delete') {
    annotations.push('idempotentHint: true');
  }

  return annotations.length > 0 ? `annotations: { ${annotations.join(', ')} }` : '';
}

function generateHandler(path: string, method: string, params: any[], responseFormat: any, toolName: string, flattenedFields: Record<string, string>, requestPath?: { helper: string; args: string[] }, authorization?: string, extraQueryParams: string[] = []) {
  const queryParams = [...new Set([
    ...params.filter((p: any) => p.in === 'query' && !['client_id', 'app-name', 'app-version'].includes(p.name)).map((p: any) => p.name),
    ...extraQueryParams,
  ])];
  const hasBody = method === 'post' || method === 'put' || method === 'patch';

  let pathTemplate = path
    .replace(/:(\w+)/g, '${encodePathValue(args.$1, "$1")}')
    .replace(/\?{(\w+)}/g, '');
  const requestPathExpression = requestPath
    ? `${requestPath.helper}(${requestPath.args.join(', ')})`
    : `\`${pathTemplate}\``;

  const parts: string[] = [`method: '${method.toUpperCase()}'`];

  if (queryParams.length > 0) {
    const queryObj = queryParams.map(p => `${p}: args.${p}`).join(', ');
    parts.push(`query: { ${queryObj} }`);
  }

  if (hasBody) {
    // if we have flattened fields, construct body from them
    if (Object.keys(flattenedFields).length > 0) {
      const bodyConstruction = Object.entries(flattenedFields)
        .map(([singular, plural]) => singular.startsWith('@batch:')
          ? `...(args.${plural} !== undefined ? { ${plural}: args.${plural} } : {})`
          : singular === 'episode'
            ? `...(args.episodes === undefined && args.episode !== undefined ? { ${plural}: [args.episode] } : {})`
            : `...(args.${singular} !== undefined ? { ${plural}: [args.${singular}] } : {})`)
        .join(', ');
      parts.push(`body: { ${bodyConstruction} }`);
    } else {
      parts.push('body: args.body');
    }
  }

  if (authorization !== undefined) {
    parts.push(`authorization: '${authorization}'`);
  }

  const formatResponse = responseFormat?.type === 'json'
    ? 'JSON.stringify(result, null, 2)'
    : `formatters['${toolName}'](result, args)`;
  const mutation = ['/scrobble/start', '/scrobble/pause', '/sync/add-to-list', '/sync/history', '/sync/history/remove', '/sync/ratings', '/sync/ratings/remove'].includes(path) && method === 'post';
  const request = mutation
    ? `await requestWrite(client, hooks, ${requestPathExpression}, {\n        ${parts.join(',\n        ')}\n      }, getToken())`
    : `await client.request(${requestPathExpression}, {\n        ${parts.join(',\n        ')},\n        token: getToken()\n      })`;

  return `async (args: any) => {
    try {
      const result = ${toolName === 'simkl_get_watchlist' ? 'hooks.getWatchlist ? await hooks.getWatchlist(args) : ' : ''}${request};${mutation ? '\n' : '\n\n'}      const formatted = ${formatResponse};
      return {
        content: Array.isArray(formatted)
          ? formatted.map((text: string) => ({ type: 'text', text }))
          : [{ type: 'text', text: formatted }]
      };
    } catch (error) {
      ${mutation ? "if (error instanceof LibraryWriteInvalidationError) return { isError: true, content: [{ type: 'text', text: error.message }] };\n      " : ''}if (error instanceof LibraryQueryError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      return toMcpErrorResult(error);
    }
    }`;
}

const tools: string[] = [];
const formatters: string[] = [];

for (const config of toolsWhitelist) {
  if (config.omitFromGenerated) continue;
  if (config.custom) {
    tools.push(`
    server.registerTool(
      '${config.custom.name}',
      { description: '${(config.description || '').replace(/'/g, "\\'")}', inputSchema: ${config.custom.schema}, annotations: { readOnlyHint: true, idempotentHint: true } },
      ${config.custom.handler}
    );`);
    continue;
  }

  const normalized = normalizePath(config.schemaPath || config.path);
  const pathEntry = spec.paths[normalized];
  const schemaMethod = config.schemaMethod || config.method;

  if (!pathEntry || !pathEntry[schemaMethod]) {
    throw new Error(`OpenAPI operation not found for ${config.method.toUpperCase()} ${normalized}`);
  }

  const operation = pathEntry[schemaMethod];
  let params = (operation.parameters || []).map(resolveLocalReference);

  if (operation.requestBody) {
    const requestBody = resolveLocalReference(operation.requestBody);
    const bodySchema = resolveLocalReference(requestBody.content?.['application/json']?.schema) || { type: 'object' };
    params.push({ name: 'body', in: 'body', required: true, schema: bodySchema });
  }

  const toolName = pathToToolName(config.path);

  if (config.responseFormat?.type === 'simple') {
    formatters.push(`  '${toolName}': ${config.responseFormat.template.toString()}`);
  }

  const { schema, flattenedFields } = generateParamSchema(config.path, params, config.omitParams, config.extraQueryParams, config.batchArrayFields, config.legacyEpisodeAlias);
  const handler = generateHandler(config.path, config.method, params, config.responseFormat, toolName, flattenedFields, config.requestPath, config.authorization, config.extraQueryParams);

  // extract clean description
  const summary = operation.summary || '';
  const description = operation.description || '';
  const cleanDesc = (config.description || summary || description.split('\n')[0] || '')
    .replace(/<[^>]*>/g, '')  // remove html tags
    .replace(/&#\d+;/g, '')   // remove html entities
    .trim()
    .substring(0, config.description ? 1200 : 200);

  // generate annotations
  const annotations = generateAnnotations(config.method, config.path);

  // build config object
  const configParts = [
    `description: '${cleanDesc.replace(/'/g, "\\'")}'`,
    `inputSchema: ${schema}`,
  ];
  if (annotations) {
    configParts.push(annotations);
  }

  tools.push(`
    server.registerTool(
      '${toolName}',
      { ${configParts.join(', ')} },
      ${handler}
    );`);
}

const output = `// AUTOGENERATED - DO NOT EDIT
// generated from api/simkl-openapi.json + src/tools-config.ts
// @ts-nocheck

import { z } from 'zod';
import { asAiring, formatList, withImdb, withRating } from '../src/format/media.js';
${toolsWhitelist.some(config => config.requestPath?.helper === 'simklTrendingPath') ? "import { simklTrendingPath } from '../src/api/trending.js';" : ''}
import { toMcpErrorResult } from '../src/api/errors.js';
import { LibraryQueryError } from '../src/library/watchlist.js';
import { LibraryWriteInvalidationError } from '../src/library/errors.js';
${toolsWhitelist.some(config => config.custom) ? "import { getTrendingByGenre } from '../src/api/trending.js';" : ''}

const formatters: Record<string, (result: any, args: any) => string> = {
${formatters.join(',\n')}
};

function encodePathValue(value: unknown, name: string) {
  if (value === undefined || value === null) {
    throw new Error(\`missing required path parameter: \${name}\`);
  }
  return encodeURIComponent(String(value));
}

export interface LibraryToolHooks {
  getWatchlist?: (args: Record<string, unknown>) => Promise<string>;
  afterLibraryWrite?: () => Promise<void>;
  write?: (path: string, options: { method: 'POST'; query?: Record<string, string | number | undefined>; body?: unknown }) => Promise<unknown>;
}
async function requestWrite(client: any, hooks: LibraryToolHooks, path: string, options: { method: 'POST'; query?: Record<string, string | number | undefined>; body?: unknown; authorization?: 'bearer' | 'none' }, token: string | undefined) {
  if (hooks.write) return hooks.write(path, options);
  const result = await client.request(path, { ...options, token });
  if (hooks.afterLibraryWrite) {
    try { await hooks.afterLibraryWrite(); }
    catch { throw new LibraryWriteInvalidationError(); }
  }
  return result;
}
export function registerTools(server: McpServer, client: any, getToken: () => string | undefined, hooks: LibraryToolHooks = {}) {
${tools.join('\n')}
}
`;

mkdirSync('generated', { recursive: true });
writeFileSync('generated/tools.ts', output.replace(/[ \t]+$/gm, ''));
console.log(`generated ${tools.length} tools → generated/tools.ts`);
