# Lossless Simkl library recovery on `400 max_items` (issue #56)

Source of truth: [Simkl Sync guide](https://api.simkl.org/guides/sync#if-a-pull-returns-400-max_items) and [Phase 2](https://api.simkl.org/guides/sync#phase-2-continuous-sync).

## Supported recovery

- Initial sync: `/sync/all-items/{type}`, then `/{status}` **only** when that type returned `400 max_items`.
- Incremental item delta: `/sync/all-items?date_from=<saved all>`; on `max_items`, try each type, then each supported status. Every child retains exactly the original `date_from`.
- Ratings delta: `/sync/ratings?date_from=<saved all>`; on `max_items`, try `/sync/ratings/{type}` sequentially. **Never** split by rating number: a numeric rating filter drops `user_rating: null` rows, causing silent rating-removal loss.
- Membership/deletions: `/sync/all-items?extended=simkl_ids_only` (60k IDs max); on `max_items`, split by type, then status as necessary. These full ID requests deliberately **never** set `date_from`. Prune only after collecting and validating every partition.

Movie statuses: `plantowatch`, `completed`, `dropped`. Show/anime statuses: `watching`, `plantowatch`, `hold`, `completed`, `dropped`. No pagination, date-window paging, or nonstandard filter is used.

Fallback requests are paced at 125 ms or more between calls, below the documented 10 GET/sec per-token limit (other client-wide concurrent traffic must still honor the shared limit). All partitions execute serially and only after confirmed `400 max_items`. Normal responses use a single request. Data is combined by media type + stable Simkl ID; duplicates and conflicting/malformed rows are rejected. Existing row and aggregate JSON size guards remain in force. Persist the activities watermark and data only after **all** needed deltas, ratings and full membership requests succeed.

## Unrecoverable conditions

There is **no documented lossless partition** beyond an individual `/sync/all-items/{type}/{status}` request. Reducing `extended` flags, requesting date slices during initialization, or sending `page`/`limit` does not provide a reliable full baseline. A single oversized `/sync/ratings/{type}` also has no safe further split that preserves null-rating removal rows.

When either limit is hit, the code raises `LibrarySyncLimitError` with `code=SIMKL_SYNC_PARTITION_EXHAUSTED`, `phase`, `operation`, `media` and optional `status`. It is an actionable MCP error; the prior valid snapshot and activities watermark remain unchanged. No identical retry is attempted during the same refresh.

**Escalation:** Open a [Simkl maintainer support request](https://support.simkl.com/) or contact maintainers via the [Simkl API guide](https://api.simkl.org/guides/sync). Supply the error code, phase, operation and media/status partition, and ask whether there is a newly supported lossless partition for this endpoint. Do **not** submit user tokens, private library contents, or upstream response bodies.

## Observability and tests

Structured `simkl_library_sync` logs include phase, operation, partition stage, media/status, fallback outcome, upstream `max_items` code, and bounded attempt count. Cloudflare Workers Observability adds `$metadata.traceId` for correlation. Logs exclude token, user/media ID, title, query timestamps, and response body.

`tests/library-max-items.test.ts` mocks Simkl to verify normal fast path, type/status fallback, correct movie and anime status sets, original `date_from`, ratings null removal, deletion set completeness, sequential bounded requests, typed errors, unchanged snapshots after failures, and sanitized logs. No live Simkl account mutation or upstream max-items stress test is part of these mocked regressions.
