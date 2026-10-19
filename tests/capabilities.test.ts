import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

test('published catalog matches real MCP discovery without credentials or upstream requests', async () => {
  const { discoverCapabilities } = await import('../scripts/capabilities');
  const catalog = await discoverCapabilities();
  expect(JSON.parse(await readFile('static/capabilities.json', 'utf8'))).toEqual(catalog);
  expect(new Set(catalog.tools.map(t => t.name)).size).toBe(catalog.tools.length);
  expect(catalog.tools.map(t => t.name)).toContain('simkl_my_stats');
  expect(catalog.tools.map(t => t.name)).toContain('simkl_start_rewatch');
  expect(catalog.tools.map(t => t.name)).toContain('simkl_search_by_text');
  expect(catalog.resourceTemplates.map(t => t.name).sort()).toEqual(['trending', 'watchlist']);
  expect(catalog.resources.length).toBeGreaterThan(0);
});

test('deployed agent tool and resource registrations match the public catalog', async () => {
  const { mock } = await import('bun:test');
  mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {}, RpcTarget: class {}, exports: {}, env: {} }));
  mock.module('cloudflare:email', () => ({ EmailMessage: class {} }));
  const { SimklMCP } = await import('../src/mcp-agent');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const agent = Object.create(SimklMCP.prototype);
  const server = new McpServer({ name: 'test', version: '1' });
  Object.defineProperties(agent, { server: { value: server }, env: { value: {} }, props: { value: {} } });
  await agent.init();
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    const catalog = JSON.parse(await readFile('static/capabilities.json', 'utf8'));
    expect((await client.listTools()).tools).toEqual(catalog.tools);
    expect((await client.listResources()).resources).toEqual(catalog.resources);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual(catalog.resourceTemplates);
  } finally { await client.close(); await server.close(); }
});

test('stats metadata prefers the cached own-account tool and restricts the direct tool to other users', async () => {
  const { discoverCapabilities } = await import('../scripts/capabilities');
  const { tools } = await discoverCapabilities();
  const mine = tools.find(tool => tool.name === 'simkl_my_stats');
  const other = tools.find(tool => tool.name === 'simkl_get_user_stats');

  expect(mine).toBeDefined();
  expect(mine!.description).toContain('cached');
  expect(mine!.description).toContain('current authenticated');
  expect(Object.keys(mine!.inputSchema.properties ?? {})).toEqual([]);

  expect(other).toBeDefined();
  expect(other!.description).toContain('another explicitly identified Simkl user');
  expect(other!.description).toContain('simkl_my_stats');
  const idDescription = other!.inputSchema.properties?.user_id?.description;
  expect(idDescription).toContain('simkl_my_stats');
  expect(idDescription).toContain('do not fetch /users/settings');
  expect(idDescription).not.toContain('first call');
});
