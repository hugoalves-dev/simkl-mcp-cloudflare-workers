# OAuth callback 502 — 2026-10-17

## Root cause and evidence

The callback received the correct `iss=https://simkl.com`, but
`exchangeAuthorizationCode()` discarded it when reconstructing the parameters
passed to `oauth4webapi.validateAuthResponse()`. Simkl's live RFC 8414 metadata
advertises `authorization_response_iss_parameter_supported: true`. With that
metadata the library throws `OAUTH_INVALID_RESPONSE` (`response parameter "iss"
(issuer) missing`) **before** making a token request. The outer callback catch
converted this exception to the generic 502.

The previous test discovery fixtures omitted the issuer-support flag. Updating
those fixtures reproduced the callback 502 and the exact library exception
before the fix; the authorization success test passes after preserving the
received issuer. Issuer validation remains enabled at both boundaries.

Read-only Cloudflare query, 2026-10-17 13:06:30–13:08:30 UTC:

| Event | UTC timestamp | HTTP | Trace ID |
| --- | --- | --- | --- |
| GET /auth/simkl | 13:07:18.185 | 302 | `5b4f7aec2a84a4b0255b32d5b6e2be78` |
| GET /oauth/callback | 13:07:27.817 | 502 | `5ee630b1f6d49d1b818d35f17380ca7a` |

Worker version: `0c1e56d9-7336-4a1e-ab04-39ad6d253d6a`. The callback's issuer
was present and matched the expected issuer. Its issue trail contains
`kv_delete`, `fetch`, `kv_delete`, consistent with state consumption, discovery,
and cleanup. Historical logs do not record the swallowed exception or the fetch
URL/status, so they alone cannot identify the exception; the deterministic
reproduction with live discovery metadata supplies that evidence. No callback
query strings, headers, codes, tokens, account details or secrets are included
in this report.

## Protocol review

Official sources checked on 2026-10-17:

- [Live discovery](https://simkl.com/.well-known/oauth-authorization-server): issuer
  `https://simkl.com`, authorization endpoint `https://simkl.com/oauth2/authorize`,
  token endpoint `https://api.simkl.com/oauth2/token`, S256 PKCE, Basic/Post/None
  client authentication, and issuer response parameter support.
- [Authentication](https://api.simkl.org/authentication) and
  [AUTH V2 reference](https://api.simkl.org/api-reference/auth-v2): V2 registration,
  mandatory PKCE for server clients too, `media:read media:write` scopes, 7-day
  access tokens, 180-day sliding refresh tokens, and 10-minute single-use codes
  consumed even by failed exchanges.

The implementation uses the OAuth2 discovery algorithm, correct endpoint hosts,
form token grants, Basic authentication, and the same `OAUTH_REDIRECT_URI` for
authorization and code exchange. The production redirect binding is a secret;
its value was neither extracted nor modified. Tests verify redirect equality,
S256 challenge/verifier matching, and forwarding the registered client redirect
and client state through the real provider. The ChatGPT↔Worker PKCE pair and the
Worker↔Simkl PKCE pair are separate and are both exercised.

## Changes

- Preserve the received issuer for library validation; do not disable the check.
- Classify discovery, response validation, token exchange, KV and provider
  completion failures. Log stage, response HTTP status, upstream HTTP status
  when a response exists, allowlisted error code and a generated trace ID.
  Return `X-Trace-Id` and `Cache-Control: no-store` on callback results.
- Never log exception objects/messages, response bodies, full URLs or credentials.
  Unknown error codes become a fixed fallback. No automatic retries were added.
- Check verifier syntax and the stored 600-second state age, independently of
  eventual KV expiration. Consume state before attempting an exchange. Avoid a
  redundant final KV delete that could override a successful redirect.
- Set `observability.redact_query_string = true` in Wrangler and preserve it in
  the CI-generated deployment configuration. Production currently has it set to
  false; **this PR does not change production settings or deploy the Worker**.
  The redaction setting protects future ingestion after an approved deployment;
  it does not retroactively sanitize existing records.

KV reads/deletes are not an atomic distributed replay lock. Sequential replay
is rejected locally, and Simkl's single-use code enforcement remains the final
barrier for simultaneous callbacks across isolates. This change does not claim
to provide atomic single-use semantics using KV.

## Validation

- Regression reproduction: authentic discovery metadata causes the unpatched
  callback to return 502 and the library to report missing `iss`.
- Automated tests cover successful authorization, failed token exchange,
  malformed verifier, expired state still present in KV, completion failure,
  sequential callback replay, wrong issuer, discovery failure/status and
  sanitization of malicious upstream error strings.
- Integration uses the actual `OAuthProvider`, production auth handler and
  production token exchange callback, with in-memory KV and simulated Simkl
  responses. It covers registration, both PKCE pairs, callback redirect, client
  token exchange, invalid client verifier, code reuse rejection and an
  authenticated resource request.
- Full Bun suite: 370 passed, 0 failed. Typecheck, capabilities check and Worker
  RPC/SQLite persistence smoke passed. Wrangler dry-run build passed. Base and
  generated CI TOML were parsed with redaction enabled for both observability
  settings. Local Bun version: 1.4.3; repository CI pins 1.4.2.

No isolated live Simkl test registration, test account or preview environment
was configured for this task; live ChatGPT/Simkl reauthorization has **not** been
performed. The network policy also does not permit shell access to Simkl.
Public docs/discovery were read through connected tools. No production user
grants were consumed, secrets retrieved, or production data modified.

After review and an explicitly authorized deployment, validate with a fresh
consent: callback 302 to ChatGPT's registered redirect, preserved client state,
successful client code exchange and authenticated MCP initialization/tool call.
Confirm `oauth_success` and query redaction in Cloudflare. If any step fails,
query the response's `X-Trace-Id`; do not replay the consumed code.

## Issue #39

Issue #39 concerns persistent user settings and PRO/VIP rewatch eligibility.
The failing issuer validation runs before token exchange, `/users/settings`,
Durable Object access or plan classification. Current main already includes
PR #57's profile work; no evidence connects it to this failure. This fix changes
no account-plan or Durable Object behavior and does not close #39.
