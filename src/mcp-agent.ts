import { APP_NAME, APP_VERSION } from './app-info';
import type { SimklOAuthEnv } from './auth/simkl-oauth';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { SimklClient } from './api/client.js';
import { createLibraryAdapter } from './library/adapter';
import { registerCapabilities } from './register-capabilities';

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

  async init() {
    const client = new SimklClient({
      baseUrl: this.env?.SIMKL_API_BASE_URL || 'https://api.simkl.com',
      clientId: this.env?.SIMKL_CLIENT_ID || '',
    });
    const library = createLibraryAdapter(this.env, client, () => this.props);
    registerCapabilities(this.server, client, library, () => this.props?.simklToken);
  }
}
