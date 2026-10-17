import * as oauth from 'oauth4webapi';
import { USER_AGENT } from '../app-info';

const SIMKL_ISSUER = new URL('https://simkl.com');
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export interface SimklOAuthEnv {
  SIMKL_CLIENT_ID: string;
  SIMKL_CLIENT_SECRET: string;
  OAUTH_REDIRECT_URI: string;
}

export interface SimklTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope?: string;
}

export interface SimklAuthProps extends Record<string, unknown> {
  simklToken: string;
  simklRefreshToken: string;
  simklExpiresAt: number;
  simklRefreshExpiresAt: number;
  simklScope?: string;
  simklUserId?: string;
}

export class SimklOAuthError extends Error {
  constructor(
    public readonly stage: 'discovery' | 'authorization_response' | 'token_exchange',
    public readonly errorCode: string,
    public readonly upstreamStatus?: number,
  ) {
    super(`Simkl OAuth ${stage} failed${upstreamStatus ? ` with status ${upstreamStatus}` : ''}`);
  }
}

const SAFE_ERROR_CODES = new Set([
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error',
  'temporarily_unavailable', 'OAUTH_INVALID_RESPONSE', 'OAUTH_RESPONSE_IS_NOT_JSON',
  'OAUTH_RESPONSE_BODY_ERROR', 'OAUTH_WWW_AUTHENTICATE_CHALLENGE',
]);

function sanitizedErrorCode(error: unknown): string {
  const candidate = error as { error?: unknown; code?: unknown } | null;
  for (const value of [candidate?.error, candidate?.code]) {
    if (typeof value === 'string' && SAFE_ERROR_CODES.has(value)) return value;
  }
  return 'upstream_failure';
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export async function exchangeAuthorizationCode(
  input: { code: string; codeVerifier: string; issuer: string },
  env: SimklOAuthEnv
): Promise<SimklTokenSet> {
  const { authorizationServer, client, clientAuth } = await getOAuthClient(env);
  let callbackParameters: URLSearchParams;
  try {
    callbackParameters = oauth.validateAuthResponse(
      authorizationServer,
      client,
      new URLSearchParams({ code: input.code, iss: input.issuer }),
      oauth.expectNoState
    );
  } catch (error) {
    throw new SimklOAuthError('authorization_response', sanitizedErrorCode(error));
  }

  let tokenResponse: oauth.TokenEndpointResponse;
  let upstreamStatus: number | undefined;
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      client,
      clientAuth,
      callbackParameters,
      env.OAUTH_REDIRECT_URI,
      input.codeVerifier,
      { headers: { 'User-Agent': USER_AGENT } }
    );
    upstreamStatus = response.status;
    tokenResponse = await oauth.processAuthorizationCodeResponse(authorizationServer, client, response);
  } catch (error) {
    throwTokenError(error, upstreamStatus);
  }
  return toSimklTokenSet(tokenResponse);
}

export async function refreshSimklToken(refreshToken: string, env: SimklOAuthEnv): Promise<SimklTokenSet> {
  const { authorizationServer, client, clientAuth } = await getOAuthClient(env);

  let tokenResponse: oauth.TokenEndpointResponse;
  let upstreamStatus: number | undefined;
  try {
    const response = await oauth.refreshTokenGrantRequest(
      authorizationServer,
      client,
      clientAuth,
      refreshToken,
      { headers: { 'User-Agent': USER_AGENT } }
    );
    upstreamStatus = response.status;
    tokenResponse = await oauth.processRefreshTokenResponse(authorizationServer, client, response);
  } catch (error) {
    throwTokenError(error, upstreamStatus);
  }
  return toSimklTokenSet(tokenResponse, refreshToken);
}

async function getOAuthClient(env: SimklOAuthEnv) {
  let upstreamStatus: number | undefined;
  try {
    const response = await oauth.discoveryRequest(SIMKL_ISSUER, {
      algorithm: 'oauth2',
      headers: { 'User-Agent': USER_AGENT },
    });
    upstreamStatus = response.status;
    const authorizationServer = await oauth.processDiscoveryResponse(SIMKL_ISSUER, response);
    if (!authorizationServer.token_endpoint) {
      throw new Error('Missing token endpoint');
    }

    return {
      authorizationServer,
      client: { client_id: env.SIMKL_CLIENT_ID },
      clientAuth: oauth.ClientSecretBasic(env.SIMKL_CLIENT_SECRET),
    };
  } catch (error) {
    // Discovery errors can contain response data. Keep credentials and protocol details out of errors.
    throw new SimklOAuthError('discovery', sanitizedErrorCode(error), upstreamStatus);
  }
}

function toSimklTokenSet(
  data: oauth.TokenEndpointResponse,
  priorRefreshToken?: string
): SimklTokenSet {
  if (!data.access_token || data.token_type.toLowerCase() !== 'bearer') {
    throw new SimklOAuthError('token_exchange', 'invalid_token_response', 200);
  }

  const now = Date.now();
  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
    ? data.expires_in
    : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const returnedRefreshToken = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    ? data.refresh_token
    : priorRefreshToken;
  if (!returnedRefreshToken) {
    throw new SimklOAuthError('token_exchange', 'missing_refresh_token', 200);
  }

  return {
    accessToken: data.access_token,
    refreshToken: returnedRefreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
    ...(typeof data.scope === 'string' ? { scope: data.scope } : {}),
  };
}

function throwTokenError(error: unknown, upstreamStatus?: number): never {
  throw new SimklOAuthError('token_exchange', sanitizedErrorCode(error), upstreamStatus);
}
