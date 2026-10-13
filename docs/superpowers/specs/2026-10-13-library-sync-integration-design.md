# Incremental library synchronization on the existing cache foundation

Implements https://github.com/vitorhugo-dotnet/simkl-mcp/issues/14. This records the integration of the approved October 9–12 design with current `main` (`c0acfaf`), which now contains issue #13's persistent cache and issue #10's manual rewatch tools. The earlier approved implementation remains on local branch `work`; this branch preserves the current-main behavior and schema.

## Purpose and constraints

Answer watchlist questions from a persistent cache shared per verified Simkl user, fetching only required changes. Preserve atomic snapshot advancement and immediate retry after failed refreshes. Checks are request-driven, never cron or background polling. Ignore playback, custom lists, and settings until consumed. Retain quota/error mappings, verified OAuth identity, default non-extended initial pulls, large-library response limits, and max_items status fallback.

## Existing storage and initialization

Extend the existing `SimklLibraryCache`, `LibraryStore`, and `v2` migration; do not introduce another object or recreate tables. Existing `library_items(media_type, simkl_id, item_json)` and `library_metadata(key, value_json)` remain canonical. Read issue-13 completion metadata as an incremental snapshot, deriving the first check time from `completedAt`. New completion metadata adds `checkedAt` and `forceCheck` alongside activities and item count. Items and metadata continue to commit in one transaction after serialization and validation. Credentials remain operation arguments, never storage fields.

The initialization APIs remain compatible and coalesce first pulls. Initialization checks activities, then reads shows/movies/anime sequentially, retaining supported status fallback on `400 max_items`. Retrieve every advertised page, reject incomplete pagination, and preserve row/aggregate size limits before recording completion.

## Authoritative API contracts

The current checked-in `.simkl-doc-watch/openapi.json` and `.simkl-doc-watch/docs.txt` document GET `/sync/activities`, GET `/sync/ratings?date_from=…` without a rating filter, and `{}` as a valid empty all-items result. These supersede the older blueprint's POST-activities ambiguity and the earlier assumption that an empty object was malformed. Refresh responses additionally retain legacy null-as-empty compatibility. Unexpected keys, malformed arrays/IDs, regressing watermarks, and incomplete advertised pagination remain failures.

## Refresh and coordination

`refreshLibrary` stages changes without mutating its previous snapshot. The existing object supplies storage to a serialized `CachedLibrary` coordinator. An initialized read inside TTL returns committed data unless forced or retry intent is pending. Otherwise check activities. If `all` is unchanged, record a successful check and make no item/ratings requests. If changed, compare `tv_shows`, movies, and anime buckets:

- Any watching/plantowatch/hold/completed/dropped change makes one logical all-types item delta using the old top-level `all`.
- Any rated_at change makes one logical all-types ratings delta with the same watermark; explicit null ratings delete the stored score.
- Any removed_from_list change pulls current simkl_ids_only membership without date_from and removes absent items.

Apply item then rating then membership changes. Merge partial metadata by media type and canonical Simkl ID, preserving omitted fields. Save the new snapshot only after all pulls and storage preparation succeed. Failed forced refreshes persist a force flag before upstream work; a storage failure also retains in-memory retry intent. Successful retry clears it. Invalidations are serialized with refresh and cannot be lost during overlapping operations.

## Configuration, identity, and MCP consumers

`SIMKL_LIBRARY_CACHE_TTL_SECONDS` defaults to 300 for missing/undefined/null/empty/whitespace or invalid input. Accept only positive decimal integer strings with safe second and millisecond values. Add the setting to existing Wrangler vars and document it; no deployment is performed here.

Use trusted OAuth account props when present. Verify legacy sessions using authenticated settings before selecting `simkl-library:v1:<canonical-account-id>`; never select by token, random fallback ID, or client-provided ID. Account resolution remains scoped to authenticated session/token.

Watchlist tools and resources use the object's new authenticated read RPC and retain JSON/text formatting. Cached data is the foundation's default rich summary, not enhanced episode data. Reject request-specific projections/filters explicitly instead of silently returning another view. `simkl_refresh_library` forces an incremental check. Await invalidation after successful generated list/history/rating/scrobble mutations and manual rewatch start/update/stop mutations. Failed writes do not invalidate. If invalidation itself fails, report that the upstream write succeeded and cache invalidation failed; preserve existing quota and ambiguous-write guidance.

## Verification and limits

Retain the entire current-main suite. Add tests for every bucket, rating deletion, removals, ignored buckets, TTL validation/boundaries, forced retry, concurrency, identity isolation, canonical IDs, existing completion compatibility, and pagination. Run real workerd/SQLite smoke tests for both the existing initialization foundation and the incremental path, including restart and failed-delta recovery. Run complete code generation, TypeScript, and Wrangler dry-run. Review the reconciled diff independently before publishing the PR. Live credentialed Simkl behavior and actual deployment are outside this verification.
