import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import authHandler from '../src/auth-handler';
import type { SimklAuthProps } from '../src/auth/simkl-oauth.js';

let createSimklTokenExchangeCallback: typeof import('../src/index.js').createSimklTokenExchangeCallback;
let createOAuthProvider: typeof import('../src/index.js').createOAuthProvider;
let OAuthProvider: typeof import('@cloudflare/workers-oauth-provider').OAuthProvider;

const env = (id: string, secret: string) => ({
  SIMKL_CLIENT_ID: id,
  SIMKL_CLIENT_SECRET: secret,
  OAUTH_REDIRECT_URI: 'https://example.test/callback',
});

function props(expiresAt: number, refreshToken = 'refresh-old'): SimklAuthProps {
  return {
    simklToken: 'access-old',
    simklRefreshToken: refreshToken,
    simklExpiresAt: expiresAt,
    simklRefreshExpiresAt: expiresAt + 180 * 24 * 60 * 60 * 1000,
    simklScope: 'media:read',
    custom: 'preserved',
    simklUserId: '42',
  };
}

function tokenResponse(accessToken: string, refreshToken?: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function discoveryResponse() {
  return new Response(JSON.stringify({
    issuer: 'https://simkl.com',
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: 'https://simkl.com/oauth2/authorize',
    token_endpoint: 'https://api.simkl.com/oauth/token',
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function refreshFetchStub(tokenHandler: typeof fetch = (() => Promise.resolve(tokenResponse('access-new', 'refresh-new', 120))) as typeof fetch) {
  return mock(((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/.well-known/oauth-authorization-server')) return Promise.resolve(discoveryResponse());
    return tokenHandler(input, init);
  }) as typeof fetch) as typeof fetch;
}

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

class MemoryKV {
  private values = new Map<string, string>();

  async get(key: string, options?: { type?: 'text' | 'json' }) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return options?.type === 'json' ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

beforeEach(() => { Date.now = () => 1_000_000; });
beforeAll(async () => {
  mock.module('cloudflare:workers', () => ({
    WorkerEntrypoint: class {},
    DurableObject: class {},
    RpcTarget: class {},
    exports: {},
    env: {},
  }));
  mock.module('cloudflare:email', () => ({ EmailMessage: class {} }));
  ({ OAuthProvider } = await import('@cloudflare/workers-oauth-provider'));
  ({ createSimklTokenExchangeCallback, createOAuthProvider } = await import('../src/index.js'));
});
afterAll(() => mock.restore());
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

describe('Simkl provider token exchange callback', () => {
  it('uses the initial authorization token expiry without an upstream request', async () => {
    globalThis.fetch = mock(() => { throw new Error('unexpected fetch'); }) as typeof fetch;
    const initial = props(Date.now() + 12_345);
    const result = await createSimklTokenExchangeCallback(env('client', 'secret'))({
      grantType: 'authorization_code', clientId: 'local-client', userId: 'simkl-user', scope: [], props: initial,
    });
    expect(result.newProps).toEqual(initial);
    expect(result.accessTokenTTL).toBe(12);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not refresh a valid token and bounds its TTL to the stored expiry', async () => {
    globalThis.fetch = mock(() => { throw new Error('unexpected fetch'); }) as typeof fetch;
    const current = props(Date.now() + 90_987);
    const result = await createSimklTokenExchangeCallback(env('client', 'secret'))({
      grantType: 'refresh_token', clientId: 'local-client', userId: 'simkl-user', scope: [], props: current,
    });
    expect(result.newProps).toEqual(current);
    expect(result.accessTokenTTL).toBe(90);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([['inside safety window', 50_000], ['expired', -1_000]])('refreshes when token is %s', async (_label, remaining) => {
    globalThis.fetch = refreshFetchStub();
    const current = props(Date.now() + remaining);
    const result = await createSimklTokenExchangeCallback(env('client', 'secret'))({
      grantType: 'refresh_token', clientId: 'local-client', userId: 'simkl-user', scope: [], props: current,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const tokenCall = globalThis.fetch.mock.calls.find(([input]) => !String(input).includes('/.well-known/oauth-authorization-server'));
    expect(tokenCall).toBeDefined();
    expect(atob(new Headers(tokenCall?.[1]?.headers).get('Authorization')!.slice('Basic '.length))).toBe('client:secret');
    expect(result.accessTokenTTL).toBe(120);
    expect(result.newProps).toMatchObject({
      simklToken: 'access-new', simklRefreshToken: 'refresh-new', custom: 'preserved', simklUserId: '42',
      simklScope: 'media:read',
    });
  });

  it('coalesces simultaneous refreshes from separate request callbacks and preserves the old refresh token', async () => {
    let resolveResponse!: (response: Response) => void;
    let authorization: string | null = null;
    let tokenRequests = 0;
    let resolveTokenRequestStarted!: () => void;
    const tokenRequestStarted = new Promise<void>(resolve => { resolveTokenRequestStarted = resolve; });
    globalThis.fetch = refreshFetchStub(((_input: RequestInfo | URL, init?: RequestInit) => {
      tokenRequests += 1;
      authorization = new Headers(init?.headers).get('Authorization');
      resolveTokenRequestStarted();
      return new Promise<Response>(resolve => { resolveResponse = resolve; });
    }) as typeof fetch);
    const callbackA = createSimklTokenExchangeCallback(env('request-a', 'secret-a'));
    const callbackB = createSimklTokenExchangeCallback(env('request-b', 'secret-b'));
    const options = { grantType: 'refresh_token' as const, clientId: 'local-client', userId: 'simkl-user', scope: [], props: props(Date.now()) };
    const first = callbackA(options);
    const second = callbackB(options);
    await tokenRequestStarted;
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(tokenRequests).toBe(1);
    expect(atob(authorization!.slice('Basic '.length))).toBe('request%2Da:secret%2Da');
    resolveResponse(tokenResponse('access-new'));
    const [a, b] = await Promise.all([first, second]);
    expect(a.newProps).toEqual(b.newProps);
    expect(a.newProps).toMatchObject({ simklRefreshToken: 'refresh-old', simklToken: 'access-new' });
  });

  it('reports a sanitized failure without exposing credentials or refresh tokens', async () => {
    globalThis.fetch = refreshFetchStub((() => Promise.resolve(new Response('failure', { status: 401 }))) as typeof fetch);
    const secretEnv = env('client-secret-id', 'very-secret-client-secret');
    const callback = createSimklTokenExchangeCallback(secretEnv);
    const error = await callback({
      grantType: 'refresh_token', clientId: 'local-client', userId: 'simkl-user', scope: [], props: props(Date.now()),
    }).catch(caught => caught as Error);
    expect(error.message).toBe('Unable to refresh Simkl token');
    expect(error.message).not.toMatch(/very-secret-client-secret|refresh-old/);
    const tokenCall = globalThis.fetch.mock.calls.find(([input]) => !String(input).includes('/.well-known/oauth-authorization-server'));
    expect(String(tokenCall?.[1]?.headers)).not.toContain('very-secret-client-secret');
  });

  it('binds each callback to the Worker env supplied when its provider is created', async () => {
    let authorization: string | null = null;
    globalThis.fetch = refreshFetchStub(((_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(tokenResponse('access-new', 'refresh-new'));
    }) as typeof fetch);
    const opts = { grantType: 'refresh_token' as const, clientId: 'local-client', userId: 'simkl-user', scope: [], props: props(Date.now()) };
    const firstRequestCallback = createSimklTokenExchangeCallback(env('first-client', 'first-secret'));
    const secondRequestCallback = createSimklTokenExchangeCallback(env('second-client', 'second-secret'));
    await firstRequestCallback(opts);
    const firstAuthorization = authorization;
    expect(atob(firstAuthorization!.slice('Basic '.length))).toBe('first%2Dclient:first%2Dsecret');
    await secondRequestCallback(opts);
    expect(authorization).not.toBe(firstAuthorization);
    expect(atob(authorization!.slice('Basic '.length))).toBe('second%2Dclient:second%2Dsecret');
  });

  it('routes a request through the provider created for its Worker env', async () => {
    const provider = createOAuthProvider({
      ...env('worker-client', 'worker-secret'),
      OAUTH_KV: {} as KVNamespace,
    });
    const response = await provider.fetch(
      new Request('https://worker.test/health'),
      { OAUTH_KV: {} as KVNamespace },
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'simkl-mcp' });
  });
});

describe('OAuthProvider MCP resource audience', () => {
  it.each([false, true])('runs callback, client PKCE, token replay and authenticated resource (invalid PKCE: %s)', async (invalidPkce) => {
    const kv = new MemoryKV();
    const env: any = { ...{ SIMKL_CLIENT_ID: 'simkl-client', SIMKL_CLIENT_SECRET: 'simkl-secret', OAUTH_REDIRECT_URI: 'https://worker.test/oauth/callback' }, OAUTH_KV: kv };
    let upstreamChallenge: string;
    globalThis.fetch = refreshFetchStub((async (input, init) => {
      if (String(input).includes('/users/settings')) return Response.json({ account: { id: 42 } });
      const form = new URLSearchParams(String(init?.body));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')!));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      expect(challenge).toBe(upstreamChallenge);
      expect(form.get('redirect_uri')).toBe(env.OAUTH_REDIRECT_URI);
      expect(form.get('code')).toBe('simkl-one-time-code');
      return tokenResponse('simkl-access', 'simkl-refresh');
    }) as typeof fetch);
    const provider = new OAuthProvider({
      apiHandlers: { '/mcp': { fetch: async () => new Response('handled') } },
      defaultHandler: authHandler as any,
      tokenExchangeCallback: createSimklTokenExchangeCallback(env),
      authorizeEndpoint: '/auth/simkl',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
    });
    const context = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
    const fetchProvider = (request: Request) => provider.fetch(request, env, context);

    const registrationResponse = await fetchProvider(new Request('https://worker.test/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://chat.example/callback'], token_endpoint_auth_method: 'none' }),
    }));
    const { client_id: clientId } = await registrationResponse.json() as { client_id: string };
    const verifier = 'mcp-audience-test-verifier-012345678901234567890';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const resource = 'https://worker.test/mcp';
    const authorizationUrl = new URL('https://worker.test/auth/simkl');
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://chat.example/callback',
      scope: 'read',
      state: 'state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
    }).toString();
    const authorizationResponse = await fetchProvider(new Request(authorizationUrl));
    expect(authorizationResponse.status).toBe(302);
    const simklRedirect = new URL(authorizationResponse.headers.get('location')!);
    expect(simklRedirect.searchParams.get('redirect_uri')).toBe(env.OAUTH_REDIRECT_URI);
    upstreamChallenge = simklRedirect.searchParams.get('code_challenge')!;
    const callback = new URL(env.OAUTH_REDIRECT_URI);
    callback.search = new URLSearchParams({ code: 'simkl-one-time-code', state: simklRedirect.searchParams.get('state')!, iss: 'https://simkl.com' }).toString();
    const completed = await fetchProvider(new Request(callback));
    expect(completed.status).toBe(302);
    const chatRedirect = new URL(completed.headers.get('location')!);
    expect(chatRedirect.origin + chatRedirect.pathname).toBe('https://chat.example/callback');
    expect(chatRedirect.searchParams.get('state')).toBe('state');
    const code = chatRedirect.searchParams.get('code')!;
    expect((await fetchProvider(new Request(callback))).status).toBe(400);

    const tokenRequest = new Request('https://worker.test/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: 'https://chat.example/callback',
        code_verifier: invalidPkce ? 'incorrect-verifier-012345678901234567890123456789' : verifier,
        resource,
      }),
    });
    const exchanged = await fetchProvider(tokenRequest.clone());
    if (invalidPkce) {
      expect(exchanged.status).toBe(400);
      return;
    }
    expect(exchanged.status).toBe(200);
    expect((await fetchProvider(tokenRequest.clone())).status).toBe(400);
    const { access_token: accessToken } = await exchanged.json() as { access_token: string };

    const mcpResponse = await fetchProvider(new Request('https://worker.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }));
    expect(mcpResponse.status).toBe(200);
    expect(await mcpResponse.text()).toBe('handled');
  });
});
