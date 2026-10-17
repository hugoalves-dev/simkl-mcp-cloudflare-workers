import { routes } from './http-routes';
import {
  SimklOAuthError,
  createPkcePair,
  exchangeAuthorizationCode,
  type SimklAuthProps,
  type SimklOAuthEnv,
} from './auth/simkl-oauth';
import { APP_NAME, APP_VERSION, USER_AGENT } from './app-info';
import { normalizeSimklId } from './library/identity.js';

interface Env extends WorkerEnv, SimklOAuthEnv {
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<unknown>;
    completeAuthorization(input: { request: unknown; userId: string; scope: string[]; props: SimklAuthProps }): Promise<{ redirectTo: string }>;
  };
}

interface PendingOAuthState {
  oauthRequest: unknown;
  codeVerifier: string;
  createdAt: number;
}

const SIMKL_ISSUER = 'https://simkl.com';
const SIMKL_AUTHORIZATION_ENDPOINT = 'https://simkl.com/oauth2/authorize';
const SIMKL_SCOPE = 'media:read media:write';

function normalizeScopes(scope: unknown): string[] {
  if (Array.isArray(scope)) return scope.flatMap(value => String(value).split(/[\s,]+/).filter(Boolean));
  if (typeof scope === 'string') return scope.split(/[\s,]+/).filter(Boolean);
  return [];
}

function isPendingOAuthState(value: unknown): value is PendingOAuthState {
  if (typeof value !== 'object' || value === null) return false;
  const pending = value as Record<string, unknown>;
  return typeof pending.codeVerifier === 'string'
    && pending.codeVerifier.length >= 43
    && pending.codeVerifier.length <= 128
    && /^[A-Za-z0-9._~-]+$/.test(pending.codeVerifier)
    && typeof pending.createdAt === 'number'
    && Number.isFinite(pending.createdAt)
    && pending.createdAt <= Date.now()
    && Date.now() - pending.createdAt < 600_000
    && 'oauthRequest' in pending;
}

async function fetchSimklUserId(simklToken: string, env: Env): Promise<string | undefined> {
  const baseUrl = env.SIMKL_API_BASE_URL || 'https://api.simkl.com';
  const settingsUrl = new URL('/users/settings', baseUrl);
  settingsUrl.searchParams.set('client_id', env.SIMKL_CLIENT_ID);
  settingsUrl.searchParams.set('app-name', APP_NAME);
  settingsUrl.searchParams.set('app-version', APP_VERSION);
  try {
    const response = await fetch(settingsUrl.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${simklToken}`, 'User-Agent': USER_AGENT },
    });
    if (!response.ok) return undefined;
    const settings = await response.json() as { account?: { id?: string | number } };
    const id = settings?.account?.id;
    return normalizeSimklId(id);
  } catch {
    return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const traceId = crypto.randomUUID();
    const failure = (stage: string, httpStatus: number, errorCode: string, message: string, upstreamStatus?: number) => {
      console.error({ event: 'oauth_failure', stage, httpStatus, errorCode, traceId,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
      return new Response(message, { status: httpStatus, headers: { 'X-Trace-Id': traceId, 'Cache-Control': 'no-store' } });
    };
    if (url.pathname === routes.authorize) {
      let stage = 'parse_authorization';
      try {
        const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const state = crypto.randomUUID();
        const { codeVerifier, codeChallenge } = await createPkcePair();
        const pending: PendingOAuthState = { oauthRequest, codeVerifier, createdAt: Date.now() };
        stage = 'store_state';
        await env.OAUTH_KV.put(`oauth_state:${state}`, JSON.stringify(pending), { expirationTtl: 600 });
        const authorizationUrl = new URL(SIMKL_AUTHORIZATION_ENDPOINT);
        authorizationUrl.searchParams.set('response_type', 'code');
        authorizationUrl.searchParams.set('client_id', env.SIMKL_CLIENT_ID);
        authorizationUrl.searchParams.set('redirect_uri', env.OAUTH_REDIRECT_URI);
        authorizationUrl.searchParams.set('state', state);
        authorizationUrl.searchParams.set('scope', SIMKL_SCOPE);
        authorizationUrl.searchParams.set('code_challenge', codeChallenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');
        return Response.redirect(authorizationUrl.toString(), 302);
      } catch {
        return failure(stage, 500, 'authorization_start_failed', 'Unable to start authorization');
      }
    }

    if (url.pathname === routes.callback) {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (url.searchParams.has('error') || !code || !state || url.searchParams.get('iss') !== SIMKL_ISSUER) {
        return failure('authorization_response', 400, 'invalid_authorization_response', 'Invalid authorization response');
      }
      let stage = 'load_state';
      try {
        const key = `oauth_state:${state}`;
        const stored = await env.OAUTH_KV.get(key);
        if (!stored) return failure('state_validation', 400, 'invalid_or_expired_state', 'Invalid or expired authorization state');

        let pending: unknown;
        try {
          pending = JSON.parse(stored);
        } catch {
          await env.OAUTH_KV.delete(key);
          return failure('state_validation', 400, 'invalid_or_expired_state', 'Invalid or expired authorization state');
        }
        if (!isPendingOAuthState(pending)) {
          await env.OAUTH_KV.delete(key);
          return failure('state_validation', 400, 'invalid_or_expired_state', 'Invalid or expired authorization state');
        }

        // Simkl consumes authorization codes when an exchange is attempted. Delete
        // state first so a later sequential callback cannot retry that code. KV
        // is eventually consistent; Simkl also enforces single-use codes upstream.
        stage = 'consume_state';
        await env.OAUTH_KV.delete(key);
        stage = 'token_exchange';
        const tokenSet = await exchangeAuthorizationCode({ code, codeVerifier: pending.codeVerifier, issuer: url.searchParams.get('iss')! }, env);
        const props: SimklAuthProps = {
          simklToken: tokenSet.accessToken,
          simklRefreshToken: tokenSet.refreshToken,
          simklExpiresAt: tokenSet.expiresAt,
          simklRefreshExpiresAt: tokenSet.refreshExpiresAt,
          ...(tokenSet.scope ? { simklScope: tokenSet.scope } : {}),
        };
        const requestedScopes = normalizeScopes((pending.oauthRequest as { scope?: unknown } | null)?.scope);
        const grantedScopes = requestedScopes.length ? requestedScopes : ['public'];
        stage = 'user_settings';
        const simklUserId = await fetchSimklUserId(tokenSet.accessToken, env);
        if (simklUserId) props.simklUserId = simklUserId;
        const userId = `simkl_user_${simklUserId || crypto.randomUUID()}`;
        stage = 'complete_authorization';
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: pending.oauthRequest, userId, scope: grantedScopes, props,
        });
        stage = 'redirect';
        console.log({ event: 'oauth_success', stage, httpStatus: 302, traceId });
        const response = new Response(null, { status: 302, headers: { Location: redirectTo, 'Cache-Control': 'no-store', 'X-Trace-Id': traceId } });
        return response;
      } catch (error) {
        return failure(error instanceof SimklOAuthError ? error.stage : stage, 502,
          error instanceof SimklOAuthError ? error.errorCode : 'authorization_failed',
          'Authorization failed. Please start again.',
          error instanceof SimklOAuthError ? error.upstreamStatus : undefined);
      }
    }

    if (url.pathname === routes.health) {
      return new Response(JSON.stringify({ status: 'ok', service: APP_NAME }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
};
