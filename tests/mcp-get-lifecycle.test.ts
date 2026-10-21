import { describe, expect, it, mock, spyOn } from 'bun:test';
import { withoutIdleMcpListener } from '../src/mcp-listener';

function createHarness() {
  const delegate = { fetch: mock(async (_request: Request, _env: object, _ctx: ExecutionContext) =>
    Response.json({ transport: 'delegated' })) };
  const handler = withoutIdleMcpListener(delegate);
  const env = {};
  const ctx = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
  return { delegate, handler, env, ctx };
}

describe('issue #65: standalone GET /mcp lifecycle', () => {
  it('returns protocol-compliant 405 without starting the MCP transport', async () => {
    const { handler, delegate, env, ctx } = createHarness();
    const log = spyOn(console, 'info').mockImplementation(() => {});
    try {
      const response = await handler.fetch(new Request('https://example.test/mcp', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: 'Bearer should-not-be-logged',
          'mcp-session-id': 'private-session-id',
        },
      }), env, ctx);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST, DELETE, OPTIONS');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(await response.text()).toBe('');
      expect(delegate.fetch).not.toHaveBeenCalled();
      const logs = JSON.stringify(log.mock.calls);
      expect(logs).toContain('mcp_standalone_sse_not_supported');
      expect(logs).not.toContain('should-not-be-logged');
      expect(logs).not.toContain('private-session-id');
    } finally {
      log.mockRestore();
    }
  });

  it('preserves POST tool calls and initialization', async () => {
    const { handler, delegate, env, ctx } = createHarness();
    const response = await handler.fetch(new Request('https://example.test/mcp', {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transport: 'delegated' });
    expect(delegate.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves GET with Last-Event-ID for resumable response streams', async () => {
    const { handler, delegate, env, ctx } = createHarness();
    const response = await handler.fetch(new Request('https://example.test/mcp', {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': 'stream/42' },
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(delegate.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves OPTIONS, DELETE and unrelated paths', async () => {
    const { handler, delegate, env, ctx } = createHarness();
    for (const request of [
      new Request('https://example.test/mcp', { method: 'OPTIONS' }),
      new Request('https://example.test/mcp', { method: 'DELETE' }),
      new Request('https://example.test/sse'),
      new Request('https://example.test/mcp-extra'),
    ]) {
      expect((await handler.fetch(request, env, ctx)).status).toBe(200);
    }
    expect(delegate.fetch).toHaveBeenCalledTimes(4);
  });
});
