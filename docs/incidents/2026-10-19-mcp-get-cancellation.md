# Issue #65: canceled GET /mcp listener tasks (2026-10-19)

## Evidence from Cloudflare Workers Observability

Worker: `simkl-mcp`. The incident was observed on two deployment versions.

| Trace ID | UTC | Parent GET outcome | Wall time | DO fetch outcome |
| --- | --- | --- | --- | --- |
| `20d53d8b4ee6810ec264748f233d0624` | 2026-10-19 20:05:41.244 | canceled + waitUntil warning | 31,710 ms | canceled, 7 ms |
| `4736dab1e4605f338ebbd5f581bb1e42` | 2026-10-19 20:06:52.214 | canceled + waitUntil warning | 31,500 ms | canceled, 1 ms |
| `364475befe784c86b855c35be002f117` | 2026-10-19 19:31:21.306 | canceled + waitUntil warning | 31,001 ms | canceled, 40 ms |

All three traces contain `GET /mcp` from an MCP client, an internal `SimklMCP` Durable Object WebSocket upgrade, and completed `SimklMCP.jsrpc` calls before cancellation. The warning is on the **stateless Worker** invocation, not a failed Simkl API write.

## Analysis and scope

- No application-owned `ctx.waitUntil()` calls were found in `src/index.ts`, `src/mcp-agent.ts`, the authentication handler, or the library/DO implementation. The request traverses `OAuthProvider` into `McpAgent.serve('/mcp')`.
- The legacy `McpAgent` implementation bridges Streamable HTTP/SSE to an internal Durable Object WebSocket. A standalone GET creates an open listener, despite this project not using server-initiated messages. The cancellation pattern and roughly 30-second lifetime strongly indicate disconnected idle listener cleanup rather than a failed library operation.
- Cloudflare allows `waitUntil` up to 30 seconds after the response/client disconnects, after which pending work is canceled.
- The MCP Streamable HTTP protocol expressly allows HTTP 405 for GET when a server does not offer an independent server-to-client SSE listener.
- This evidence **does not prove** what internal promise was left pending, nor rule out all possible data loss elsewhere. These traces contain no library write failures. Do not conflate this issue with the 409 scrobble handling in #43/#64.

## Narrow fix

Return authenticated `405 Method Not Allowed` for standalone `GET /mcp` without `Last-Event-ID`. This response is produced *inside* `OAuthProvider.apiHandlers`, maintaining the OAuth boundary.

Preserved behaviors:
- `POST /mcp`: initialization, tool calls, response streaming, notifications
- `GET /mcp` with `Last-Event-ID`: attempt to resume an interrupted stream
- `DELETE /mcp` and `OPTIONS /mcp`
- legacy `GET /sse`
- Simkl OAuth and library Durable Object operations

Structured log: `mcp_standalone_sse_not_supported`. Its fields are static, without headers, tokens, user IDs or sessions. This avoids suppressing any runtime warnings for unrelated work.

**Trade-off:** independent server-pushed MCP messages are disabled at `/mcp` (not used by the current tool/resource implementation). If the service adds server-initiated requests or change notifications later, revisit this decision or migrate to the stateless `createMcpHandler` protocol path with deliberate transport choices.

## Validation

CI: `bun run typecheck`, `bun test` (including `tests/mcp-get-lifecycle.test.ts`), `node tests/library-runtime/smoke.mjs`.

After deploying this PR to a preview environment, exercise a real authenticated MCP client: initialize, list tools, read a resource, invoke a harmless read-only tool, disconnect/reconnect, and issue GET /mcp. Verify:
1. Unauthenticated GET is denied by OAuth, not exposed as a public route.
2. Authenticated standalone GET yields 405 immediately, with no downstream DO WebSocket upgrade.
3. POST tool calls still complete; a GET with Last-Event-ID stays delegated.
4. No new warnings with event `mcp_standalone_sse_not_supported` and the same canceled-waitUntil trace profile after idle disconnects.
5. Inspect neighboring logs for failed writes/DO storage calls independently, without assuming their absence from the GET trace proves global persistence safety.

Do not claim a production verification until the preview has been exercised and Cloudflare logs have been queried.

References: [Cloudflare waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil), [MCP Streamable HTTP (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [Cloudflare legacy McpAgent transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/).
