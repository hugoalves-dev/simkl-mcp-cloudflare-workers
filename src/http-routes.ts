// Shared by routing and the public documentation. Authentication describes the
// protocol requirement; OAuth callbacks still validate state, issuer and PKCE.
export const routes = {
  home: '/', index: '/index.html', catalog: '/capabilities.json',
  mcp: '/mcp', sse: '/sse', health: '/health',
  authorize: '/auth/simkl', callback: '/oauth/callback', token: '/token', register: '/register',
} as const;
export const endpoints = [
  { path: routes.home, purpose: 'Landing page', authentication: 'Public' },
  { path: routes.catalog, purpose: 'Read-only capability metadata', authentication: 'Public' },
  { path: routes.mcp, purpose: 'Streamable HTTP (preferred)', authentication: 'OAuth bearer token' },
  { path: routes.sse, purpose: 'SSE (legacy)', authentication: 'OAuth bearer token' },
  { path: routes.health, purpose: 'Service health', authentication: 'Public' },
  { path: routes.authorize, purpose: 'Start Simkl OAuth authorization', authentication: 'OAuth request; Simkl sign-in' },
  { path: routes.callback, purpose: 'Complete Simkl authorization', authentication: 'Validated OAuth state, issuer and code' },
  { path: routes.token, purpose: 'Exchange authorization code or refresh token', authentication: 'Valid grant and registered client; PKCE for code exchange' },
  { path: routes.register, purpose: 'Dynamic OAuth client registration', authentication: 'Public' },
  { path: '/.well-known/oauth-authorization-server', purpose: 'OAuth authorization server discovery', authentication: 'Public' },
  { path: '/.well-known/oauth-protected-resource', purpose: 'OAuth protected resource discovery', authentication: 'Public' },
];
