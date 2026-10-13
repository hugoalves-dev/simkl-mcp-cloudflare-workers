# Batch and serialize Simkl user writes

Implements [issue #16](https://github.com/vitorhugo-dotnet/simkl-mcp/issues/16) on current `main`, building on the per-user Durable Object and mutation invalidation hooks from PRs #23 and #26.

## Goal

Let write tools send all supported items in one endpoint request, serialize authenticated writes per Simkl account across MCP sessions, retry Simkl's short per-second rate limit at most once, and ensure a successful write forces the next library read to check activities.

## Existing behavior

The generated tool layer sends mutation requests directly through `SimklClient`; its `afterLibraryWrite` hook invalidates the user's library only after the request succeeds. Rewatch mutations also call `SimklClient` directly and then invalidate through the MCP agent. The per-user `SimklLibraryCache` is selected by verified account ID. `CachedLibrary` already serializes library reads and invalidations within one Durable Object, but it does not own upstream writes.

The Simkl OpenAPI contract supports array payloads for `/sync/history`, `/sync/history/remove`, `/sync/add-to-list`, `/sync/ratings`, and `/sync/ratings/remove`. History arrays are `movies`, `shows`, `anime`, and `episodes`. The existing `simkl_mark_watched` and `simkl_remove_from_history` tools expose only a singular `episode`; retain that input as a compatibility shorthand while exposing the documented arrays. Scrobble start, pause, and stop are single-item operations by API contract and remain so.

## Design

### User-scoped write execution

Route each authenticated mutation through the Durable Object selected by the verified canonical Simkl account ID. A cache service write operation accepts an allowlisted endpoint, query values, body, and the current access token. The Durable Object executes the POST within the same serialized coordinator queue used for library operations. Keep tokens operation-local; never include them in persisted data or queue state.

Generated write handlers use an injected write hook instead of calling the client directly when running in the authenticated MCP agent. Rewatch start, update, and stop use the same hook. Preserve the direct-client fallback for standalone generated-tool use and existing callers that do not supply the cache hook.

The Durable Object queue is per account, so concurrent operations for one account run sequentially across sessions while writes to different accounts can proceed independently. Do not serialize reads such as rewatch plan eligibility checks unless they are part of the mutation's existing precondition.

### Batch request shape

Expose `movies[]`, `shows[]`, `anime[]`, and `episodes[]` on history add/remove tools, sending the selected arrays unchanged in one `/sync/history` POST. Preserve `episode` by wrapping that one item into `episodes[]` only when no explicit `episodes[]` value is supplied. Do not split arrays into item-level requests. Existing add-to-list and ratings tools already carry plural arrays under their request body; keep them as one request per endpoint action. Do not combine different endpoints into one request.

Scrobble tools retain their documented singular body. Rewatch mutations remain one history or scrobble request each and participate in per-user ordering and retry.

### Retry and invalidation

Only a `SimklApiError` with upstream code `rate_limit` is retried. Wait one second, then issue the same POST once more. Never retry daily `user_limit_exceeded` or `app_limit_exceeded`, any other HTTP error, or a network/ambiguous failure. The write remains in the user's queue through the wait, retry, and cache invalidation.

On success, set and persist the cache's forced-refresh intent before the queued operation releases. This closes the race where an already-queued library read could otherwise run between the successful write and a later invalidation call. If the library has no initialized snapshot, preserve in-memory retry intent; its first initialization fetches current activities and library contents. A failed upstream write does not invalidate. If the upstream write succeeds but persisting invalidation fails, retain in-memory retry intent and return an explicit sanitized error that says the write succeeded but cache invalidation failed; do not retry the write.

Preserve upstream response formatting, authorization, existing quota guidance, and existing local validation. No new Durable Object class, schema, or migration is needed.

## Acceptance criteria

- Every supported multi-item action passes its complete array payload in a single POST; the handler never loops over items to issue separate requests.
- History add/remove tools accept their documented arrays and retain the old single-episode argument.
- Writes for the same canonical user are serialized across sessions; distinct users can write concurrently.
- Only `rate_limit` waits one second and retries once. No third attempt occurs and unrelated failures are not retried.
- A successful write persists forced-refresh state in its serialized operation; the next library read checks activities and applies the resulting delta.
- Failed writes do not invalidate, and no access token is persisted.
- Generated-tool fallback behavior without the cache hook remains compatible.

## Verification

Cover request body preservation, one-request batch behavior, singular episode compatibility, every write path's hook use, same-user serialization, cross-user independence, retry classification/bounds, no retry for ambiguous failures, token non-persistence, and post-write forced activity refresh in focused Bun tests and the Worker/SQLite smoke path. Then run code generation/drift check, the complete Bun suite, TypeScript checking, Wrangler dry-run, and `git diff --check`. No deployment or merge is part of the change.
