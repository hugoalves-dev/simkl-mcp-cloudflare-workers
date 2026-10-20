# Lossless Simkl library recovery on `400 max_items` (issue #56)

Source of truth: [Simkl Sync guide](https://api.simkl.org/guides/sync#if-a-pull-returns-400-max_items) and [Phase 2](https://api.simkl.org/guides/sync#phase-2-continuous-sync).

## Supported recovery

- Initial sync: `/sync/all-items/{type}`, then `/{status}` **only** when that type returned `400 max_items`.
- Incremental item delta: `/sync/all-items?date_from=<saved all>`; on `max_items`, try each type, then each supported status. Every child retains exactly the original `date_from`.
- Ratings delta: `/sync/ratings?date_from=<saved all>`; on `max_items`, try `/sync/ratings/{type}` sequentially. **Never** split by rating number: a numeric rating filter drops `user_rating: null` rows, causing silent rating-removal loss.
- Membership/deletions: `/sync/all-items?extended=simkl_ids_only` (60k IDs max); on `max_items`, split by type, then status as necessary. These full ID requests deliberately **never** set `date_from`. Prune only after collecting and validating every partition.

Movie statuses: `plantowatch`, `completed`, `dropped`. Show/anime statuses: `watching`, `plantowatch`, `hold`, `completed`, `dropped`. No pagination, date-window paging, or nonstandard filter is used.

Initial and incremental fallback requests are paced at 125 ms or more between calls, below the documented 10 GET/sec per-token limit (other client-wide concurrent traffic must still honor the shared limit). All partitions execute serially and only after confirmed `400 max_items`. Normal responses use a single request. Data is combined by media type + stable Simkl ID; duplicates and conflicting/malformed rows are rejected. Existing row and aggregate JSON size guards remain in force. Persist the activities watermark and data only after **all** needed deltas, ratings and full membership requests succeed.

## Unrecoverable conditions

There is **no documented lossless partition** beyond an individual `/sync/all-items/{type}/{status}` request. Reducing `extended` flags, requesting date slices during initialization, or sending `page`/`limit` does not provide a reliable full baseline. A single oversized `/sync/ratings/{type}` also has no safe further split that preserves null-rating removal rows.

When either limit is hit, the code raises `LibrarySyncLimitError` with `code=SIMKL_SYNC_PARTITION_EXHAUSTED`, `phase`, `operation`, `media` and optional `status`. It is an actionable MCP error; the prior valid snapshot and activities watermark remain unchanged. No identical retry is attempted during the same refresh.

**Escalation:** Open a [Simkl maintainer support request](https://support.simkl.com/) or contact maintainers via the [Simkl API guide](https://api.simkl.org/guides/sync). Supply the error code, phase, operation and media/status partition, and ask whether there is a newly supported lossless partition for this endpoint. Do **not** submit user tokens, private library contents, or upstream response bodies.

## Observability and tests

Structured `simkl_library_sync` logs include phase, operation, partition stage, media/status, fallback outcome, upstream `max_items` code, and bounded attempt count. Cloudflare Workers Observability adds `$metadata.traceId` for correlation. Logs exclude token, user/media ID, title, query timestamps, and response body.

`tests/library-max-items.test.ts` mocks Simkl to verify normal fast path, type/status fallback, correct movie and anime status sets, original `date_from`, ratings null removal, deletion set completeness, sequential bounded requests, typed errors, unchanged snapshots after failures, and sanitized logs. No live Simkl account mutation or upstream max-items stress test is part of these mocked regressions.

## Manual validation (PR #72, no production deploy)

> The PR is Draft and is **not** automatically deployed. Target the connected PR preview MCP if available, or use `wrangler dev` locally. A connection to `main` will not contain this instrumentation until the changes have been reviewed and merged. For historical log search on a preview Worker, configure `observability.enabled = true` on **that preview only**. The repository's default `wrangler.toml` has observability disabled; `wrangler tail` can stream live logs when a preview Worker exists. Cloudflare appends invocation `$metadata.traceId` when enabled, while our per-sync `syncId` correlates each series of library subrequests.

### Read-only smoke test through ChatGPT / MCP

1. Connect the MCP to **PR #72 Preview**, not production. Record the target environment.
2. Call `simkl_get_watchlist` with `{"limit":10}`. On a first-time cache initialization, look for `upstream_request` with `operation=activities`, followed by **three sequential** `baseline` media pulls, `snapshot_ready`, and `snapshot_committed`. On an existing cache, see the appropriate TTL shortcut or activity check instead.
3. Call `simkl_get_watchlist` again immediately with the same arguments. Expect the `activities_gate` outcome `ttl_hit` (and the existing `simkl_library_cache.cache_hit`) and **zero new upstream sync requests**.
4. Call `simkl_refresh_library` once with `{}`. Expect `manual_refresh:forced`, `activities` GET, and `activities_gate:watermark_unchanged` if the Simkl library has not changed; expect no delta/ratings/membership calls in that case. A subsequent immediate refresh should return `manual_refresh:cooldown` because manual refresh is limited to one per minute per account.
5. Filter Workers Logs on `component = simkl_library_sync`, group by `syncId`, and inspect `event`, `phase`, `operation`, `queryMode`, `media`, `status`, `requestNo`, `outcome`, `reason`, `durationMs`, `rows`, `requests`. The `date_from` **value**, tokens, item titles and Simkl IDs must not appear.

### Optional authenticated write cases (test account only)

With explicit approval to modify a **test** Simkl account, change one title's status to trigger the `delta` route, update/remove a rating to trigger the `ratings` route (verify `user_rating:null` is preserved), and remove a disposable item to trigger `membership` and the `full_ids` query mode. Read the watchlist after each mutation. Do not send write calls on production libraries merely for instrumentation. A successful server-side write already invalidates the library cache; no extra forced refresh is required.

### Deterministic max_items regression (safe, entirely mocked)

Run the following in the PR checkout:

```bash
bun install --frozen-lockfile
bun run codegen
bun run typecheck
bun test tests/library-max-items.test.ts
bun test
```

The mocked tests force `400 max_items` at all-type and type-level requests, including ratings/membership. Verify the ordered `upstream_request` attempts, `partition_fallback` stages, identical `date_from` usage, per-status failure diagnostics, unchanged previous snapshot, redacted failure logs and capped request counts. These tests need no Simkl credentials and must **not** be represented as real upstream max-items evidence.

### Expected event examples (illustrative, not actual logs)

```json
{"component":"simkl_library_sync","event":"upstream_request","syncId":"<uuid>","phase":"incremental","operation":"activities","queryMode":"none","outcome":"success","requestNo":1,"durationMs":12}
{"component":"simkl_library_sync","event":"activities_gate","syncId":"<uuid>","phase":"incremental","outcome":"watermark_unchanged","requests":1}
{"component":"simkl_library_sync","event":"snapshot_committed","syncId":"<uuid>","phase":"incremental","outcome":"freshness_saved","rows":500,"requests":1}
```

No `snapshot_committed` event may follow a failed sync. If a single `/{type}/{status}` request still returns `400 max_items`, the result should be an actionable `SIMKL_SYNC_PARTITION_EXHAUSTED`, not a silent partial cache. Verify in Workers Logs that `sync_failed` is emitted and `snapshot_committed` is not. Live verification of this rare case requires a library large enough to exceed the upstream server's limit; forcing it through test-only code in production is intentionally unsupported.
