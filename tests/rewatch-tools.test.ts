import { describe, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { RewatchService } from '../src/api/rewatches';
import { registerRewatchTools } from '../src/tools/rewatches';
import { toolsWhitelist } from '../src/tools-config';
import { SimklApiError } from '../src/api/client';

describe('rewatch MCP tools', () => {
  test('registers explicit rewatch operations and owns the stop tool registration', async () => {
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = (async input => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname === '/users/settings') return Response.json({ account: { type: 'pro' } });
      return Response.json({ action: 'scrobble', progress: 95, rewatch_status: 'too_soon', rewatch_id: 7 });
    }) as typeof fetch;
    try {
      const registered = new Map<string, { definition: any; handler: (args: any) => Promise<any> }>();
      const server = { registerTool(name: string, definition: any, handler: (args: any) => Promise<any>) { registered.set(name, { definition, handler }); } };
      const service = new RewatchService(new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' }), () => 'token');
      registerRewatchTools(server as any, service);

      expect(registered.has('simkl_start_rewatch')).toBe(true);
      expect(registered.has('simkl_update_rewatch')).toBe(true);
      expect(registered.has('simkl_get_rewatches')).toBe(true);
      expect(Object.keys(registered.get('simkl_get_rewatches')!.definition.inputSchema).sort()).toEqual(['mediaType', 'status']);
      expect(registered.get('simkl_start_rewatch')!.definition.inputSchema.ids.safeParse({}).success).toBe(false);
      expect(registered.get('simkl_start_rewatch')!.definition.inputSchema.ids.safeParse({ unsupported: 'anything' }).success).toBe(false);
      expect(registered.get('simkl_start_rewatch')!.definition.inputSchema.ids.safeParse({ simkl: 1.5 }).success).toBe(false);
      expect(registered.get('simkl_update_rewatch')!.definition.inputSchema.rewatch_id.safeParse(0).success).toBe(false);
      expect(toolsWhitelist.find(config => config.path === '/scrobble/stop')?.omitFromGenerated).toBe(true);

      const response = await registered.get('simkl_stop_watching')!.handler({ body: { progress: 95 }, allow_rewatch: true });
      expect(JSON.parse(response.content[0].text).rewatch_status).toBe('too_soon');
      expect(requests.filter(url => url.pathname === '/scrobble/stop')[0].searchParams.get('allow_rewatch')).toBe('yes');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves shared AUTH V2 daily-limit guidance for stop errors', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
    client.request = async () => { throw new SimklApiError('429 Too Many Requests', 429, '{"error":"user_limit_exceeded"}', { retryAfter: '3600' }); };
    const registered = new Map<string, (args: any) => Promise<any>>();
    const mockServer = { registerTool(name: string, _definition: any, handler: (args: any) => Promise<any>) { registered.set(name, handler); } };
    registerRewatchTools(mockServer as any, new RewatchService(client, () => 'token'));
    const response = await registered.get('simkl_stop_watching')!({ body: {} });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('AUTH V2 daily allowance');
    expect(response.content[0].text).toContain('Retry-After: 3600 seconds');
  });

  test('preserves local rejection messages and warns before retrying ambiguous writes', async () => {
    const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'app' });
    const registered = new Map<string, (args: any) => Promise<any>>();
    const mockServer = { registerTool(name: string, _definition: any, handler: (args: any) => Promise<any>) { registered.set(name, handler); } };
    const service = new RewatchService(client, () => 'token');
    registerRewatchTools(mockServer as any, service);
    const completedShow = await registered.get('simkl_update_rewatch')!({ mediaType: 'shows', ids: { simkl: 2 }, rewatch_id: 1, rewatch_status: 'completed' });
    expect(completedShow.content[0].text).toContain('can only be set for movies');
    const missingDate = await registered.get('simkl_get_rewatches')!({ mediaType: 'all', status: 'completed' });
    expect(missingDate.content[0].text).toContain('Cached rewatch sessions are unavailable');
    client.request = async (endpoint: string) => {
      if (endpoint === '/users/settings') return { account: { type: 'pro' } } as any;
      throw new SimklApiError('simkl api request failed', 0, null);
    };
    const uncertain = await registered.get('simkl_start_rewatch')!({ mediaType: 'movies', ids: { simkl: 4 } });
    expect(uncertain.content[0].text).toContain('may have succeeded');
    expect(uncertain.content[0].text).toContain('before retrying');
    client.request = async () => { throw new SimklApiError('simkl api error: invalid json response', 201, '<truncated>'); };
    const unreadable = await registered.get('simkl_start_rewatch')!({ mediaType: 'movies', ids: { simkl: 5 } });
    expect(unreadable.content[0].text).toContain('may have succeeded');

    const originalFetch = globalThis.fetch;
    let postCount = 0;
    client.request = SimklClient.prototype.request.bind(client) as typeof client.request;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/users/settings') return Response.json({ account: { type: 'pro' } });
      if (init?.method === 'POST') postCount++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } }), { status: 201 });
    }) as typeof fetch;
    try {
      const streamFailure = await registered.get('simkl_start_rewatch')!({ mediaType: 'movies', ids: { simkl: 6 } });
      expect(postCount).toBe(1);
      expect(streamFailure.content[0].text).toContain('may have succeeded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
