import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCapabilities } from '../src/register-capabilities';
import type { SimklClient } from '../src/api/client';
import type { LibraryAdapter } from '../src/library/adapter';
import { endpoints } from '../src/http-routes';
import { APP_NAME, APP_VERSION } from '../src/app-info';

export async function discoverCapabilities() {
  // Fail closed if registration ever tries to access user data. Only list APIs run.
  const unavailable = new Proxy({}, { get() { throw new Error('Discovery must not access runtime services'); } });
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION });
  registerCapabilities(server, unavailable as SimklClient, unavailable as LibraryAdapter, () => undefined);
  const client = new Client({ name: 'public-catalog-build', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    return { schemaVersion: 1, endpoints, tools: tools.tools, resources: resources.resources, resourceTemplates: templates.resourceTemplates };
  } finally {
    await client.close();
    await server.close();
  }
}

if (import.meta.main) {
  await Bun.write('static/capabilities.json', JSON.stringify(await discoverCapabilities(), null, 2) + '\n');
}
