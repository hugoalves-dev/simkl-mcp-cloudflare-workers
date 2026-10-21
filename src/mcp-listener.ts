import { routes } from './http-routes';

/**
 * A standalone Streamable HTTP GET is an optional server-to-client listener.
 * Simkl MCP does not push out-of-band messages; all registered tools/resources
 * respond to client POSTs. Avoid creating a long-lived WebSocket/SSE bridge
 * solely for an idle listener, which can outlive client disconnects.
 *
 * Keep Last-Event-ID requests on the original handler: they may be attempting
 * to resume an interrupted request/response stream.
 *
 * This wrapper MUST be installed inside OAuthProvider.apiHandlers, never
 * before OAuth authentication.
 */
export function withoutIdleMcpListener<Env>(
  handler: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> },
) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      if (
        request.method !== 'GET'
        || new URL(request.url).pathname !== routes.mcp
        || request.headers.get('last-event-id')
      ) {
        return handler.fetch(request, env, ctx);
      }

      // Log only the fixed route/method and event, never credentials or session IDs.
      console.info({
        event: 'mcp_standalone_sse_not_supported',
        method: 'GET',
        path: routes.mcp,
        reason: 'no_server_initiated_messages',
      });

      // MCP Streamable HTTP explicitly allows 405 when the server has no
      // independent SSE stream. POST /mcp and legacy /sse stay untouched.
      return new Response(null, {
        status: 405,
        headers: {
          Allow: 'POST, DELETE, OPTIONS',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version',
          'Access-Control-Expose-Headers': 'mcp-session-id',
        },
      });
    },
  };
}
