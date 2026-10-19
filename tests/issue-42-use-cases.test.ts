import { afterEach, expect, test } from 'bun:test';
import { SimklClient } from '../src/api/client';
import { CachedLibrary } from '../src/library/coordinator';
import { registerTools } from '../generated/tools';

type MockRequest = { path: string; method: string; body: string | undefined };
type ToolResult = { isError?: true; content: Array<{ type: 'text'; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function useCase(upstream: (request: MockRequest, attempt: number) => Response | Promise<Response>) {
  const requests: MockRequest[] = [];
  const waits: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      path: new URL(String(input)).pathname,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(request);
    return upstream(request, requests.length);
  }) as typeof fetch;

  const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'test-app' });
  // Use the same serialized-write path as the deployed MCP, without a real account or network.
  const cache = new CachedLibrary({
    async load() { return undefined; },
    async save() {},
  }, client, 300, Date.now, async milliseconds => { waits.push(milliseconds); });

  const tools = new Map<string, Handler>();
  registerTools({
    registerTool(name: string, _definition: unknown, handler: Handler) { tools.set(name, handler); },
  } as any, client, () => 'fake-test-token', {
    write: (path: string, options: { method: 'POST'; body?: unknown; query?: Record<string, string | number | undefined> }) =>
      cache.write('fake-test-token', path, options),
  });

  async function invoke(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const handler = tools.get(name);
    if (!handler) throw new Error(`Unknown test tool: ${name}`);
    return handler(args);
  }

  return { invoke, requests, waits };
}

const historyArgs = { movies: [{ ids: { simkl: 12345 } }] };

test('UC-42-01: an applied history POST returning 503 is not repeated and warns the MCP caller', async () => {
  let changesApplied = 0;
  const app = useCase(request => {
    expect(request.path).toBe('/sync/history');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body ?? '{}')).toEqual(historyArgs);
    changesApplied++; // Simkl applied the write, but its response failed.
    return Response.json({ error: 'internal_error' }, { status: 503 });
  });

  const result = await app.invoke('simkl_mark_watched', historyArgs);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('write may have succeeded');
  expect(result.content[0].text).toContain('history and rewatch sessions before retrying');
  expect(app.requests).toHaveLength(1);
  expect(changesApplied).toBe(1);
  expect(app.waits).toEqual([]);
});

test('UC-42-02: GET show detail recovers from two 5xx failures within bounded retries', async () => {
  const app = useCase((_request, attempt) => attempt < 3
    ? Response.json({ error: 'temporary' }, { status: 502 })
    : Response.json({ title: 'Test Show', ids: { simkl: 12345 } }));

  const result = await app.invoke('simkl_get_show_by_id', { id: '12345' });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain('Test Show');
  expect(app.requests.map(r => r.method)).toEqual(['GET', 'GET', 'GET']);
  expect(app.requests.map(r => r.path)).toEqual(['/tv/12345', '/tv/12345', '/tv/12345']);
});

test('UC-42-03: 429 daily quota for mutation is not retried or misreported as burst lock', async () => {
  const app = useCase(() => Response.json({ error: 'user_limit_exceeded' }, { status: 429 }));
  const result = await app.invoke('simkl_mark_watched', historyArgs);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('AUTH V2 daily allowance');
  expect(result.content[0].text).not.toContain('write is still running');
  expect(app.requests).toHaveLength(1);
  expect(app.waits).toEqual([]);
});

test('UC-42-04: 400 RATE_LIMIT write lock permits one serialized retry after one second', async () => {
  const app = useCase((_request, attempt) => attempt === 1
    ? Response.json({ error: 'RATE_LIMIT' }, { status: 400 })
    : Response.json({ added: { movies: 1 } }));

  const result = await app.invoke('simkl_mark_watched', historyArgs);
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain('"movies": 1');
  expect(app.requests.map(r => r.method)).toEqual(['POST', 'POST']);
  expect(app.waits).toEqual([1000]);
});

test('UC-42-05: 429 per-second burst limit permits exactly one serialized write retry', async () => {
  const app = useCase((_request, attempt) => attempt === 1
    ? Response.json({ error: 'rate_limit' }, { status: 429 })
    : Response.json({ added: {} }));

  const result = await app.invoke('simkl_mark_watched', historyArgs);
  expect(result.isError).toBeUndefined();
  expect(app.requests).toHaveLength(2);
  expect(app.waits).toEqual([1000]);
});

test('UC-42-06: ambiguous network failure on a mutation is not retried', async () => {
  const app = useCase(() => { throw new Error('connection reset after upstream received POST'); });
  const result = await app.invoke('simkl_mark_watched', historyArgs);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('write may have succeeded');
  expect(result.content[0].text).not.toContain('connection reset');
  expect(app.requests).toHaveLength(1);
  expect(app.waits).toEqual([]);
});

test('UC-42-07: a GET that always returns 503 stops after three attempts', async () => {
  const app = useCase(() => Response.json({ error: 'temporary' }, { status: 503 }));
  const result = await app.invoke('simkl_get_show_by_id', { id: '12345' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('HTTP 503');
  expect(app.requests).toHaveLength(3);
  expect(app.requests.every(r => r.method === 'GET')).toBe(true);
});
