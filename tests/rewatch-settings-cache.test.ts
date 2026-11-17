import { expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCapabilities } from '../src/register-capabilities';
import type { LibraryAdapter } from '../src/library/adapter';

test('rewatch plan checks read account.type from the per-account settings cache, never /users/settings', async () => {
  const settingsReads: Array<string | undefined> = [];
  const writes: string[] = [];
  const library = {
    getSettings: async (token?: string) => { settingsReads.push(token); return { account: { type: 'vip' } }; },
    invalidateSettings: async () => {},
    write: async (path: string) => { writes.push(path); return { added: {} }; },
    readRewatches: async () => [],
  } as unknown as LibraryAdapter;
  const client = { request: async (path: string) => { throw new Error(`unexpected upstream request ${path}`); } } as any;
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = new McpServer({ name: 'test', version: '1' });
  const original = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, handler: any) => { handlers.set(name, handler); return original(name, config, handler); };
  registerCapabilities(server, client, library, () => 'token');

  for (let index = 0; index < 3; index++) {
    const result = await handlers.get('simkl_start_rewatch')!({ mediaType: 'movies', ids: { simkl: index + 1 } });
    expect(result.isError).not.toBe(true);
  }
  expect(settingsReads).toEqual(['token', 'token', 'token']);
  expect(writes).toEqual(['/sync/history', '/sync/history', '/sync/history']);
});
