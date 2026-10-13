# Cache Simkl account settings and user statistics

Implements [issue #17](https://github.com/vitorhugo-dotnet/simkl-mcp/issues/17) on the current `main` cache foundation from PRs #23, #26, and #29.

## Goal

Avoid repeatedly spending Simkl requests to load the authenticated user's settings and statistics. Reuse the verified Simkl account ID already retained in OAuth properties, share cached values across MCP sessions, and refresh each value only when its corresponding `/sync/activities` timestamp changes.

Acceptance criteria:

- Authenticated stats reads use the known verified Simkl account ID and do not fetch `/users/settings` to discover it again.
- Repeated reads while the shared activities snapshot is fresh return cached settings and stats without Simkl requests.
- Settings refresh when `activities.settings.all` changes; stats refresh when `activities.all` changes.
- Simkl's documented `null` watermarks for a new account are valid stable markers. First access still fetches settings and stats, then cached values are reused until a marker changes.
- Data is isolated by canonical Simkl account ID and survives Durable Object reconstruction.
- Tests cover unchanged reads, each independent invalidation, known identity reuse, failed refresh retry, and user isolation.

## Current behavior and constraints

The OAuth callback already saves a verified numeric `simklUserId` in auth properties. `LibraryAdapter` selects `simkl-library:v1:<id>`, and `SimklLibraryCache` owns the SQLite `LibraryStore` and serialized `CachedLibrary` coordinator. The library snapshot contains activities and a `checkedAt` timestamp; checks use `SIMKL_LIBRARY_CACHE_TTL_SECONDS` (300 seconds by default) and refresh only on demand.

`simkl_my_stats` currently bypasses that cache: every call fetches `/users/settings` for the account ID and then `/users/{id}/stats`. The new flow must use the existing per-user Durable Object and freshness interval. It must not advance the library activity watermark until any required library deltas have succeeded, store access tokens, change the `simkl_my_stats` response shape, or introduce a new Durable Object class/migration.

## Design

Extend the existing `SimklLibraryCache` operation path to serve cached account settings and stats. The Durable Object remains keyed by verified canonical Simkl ID, so different accounts cannot share profile data. The profile record keeps its own last checked activities snapshot and check time, while reusing an already-fresh initialized library snapshot when available. A stats read must not initialize the full watchlist cache just to obtain activity timestamps. Run profile refreshes through the same per-object serialized operation path as library reads and invalidations:

1. Within the configured cache TTL, reuse the profile activity snapshot without contacting Simkl. Otherwise reuse a still-fresh initialized library snapshot if one exists, or request `/sync/activities` alone and update only the profile activity snapshot. A stats read never advances the library synchronization watermark or triggers a first full-library pull.
2. Compare `activities.settings.all` with the settings watermark stored alongside the cached settings. A timestamp or `null` is valid; fetch `/users/settings` on first access or when that marker moves.
3. Compare top-level `activities.all` with the stats watermark. A timestamp or `null` is valid; fetch `/users/{verifiedSimklUserId}/stats` on first access or when that marker moves.
4. Return the cached stats using the existing pretty-printed JSON result from `simkl_my_stats`.

Persist settings, stats, the profile activities snapshot, check time, and the individual settings/stats activity watermarks as a bounded profile-cache JSON record in the existing `library_metadata` table. Keep the library completion metadata and item rows unchanged. Prepare and validate serialized data before a synchronous SQLite transaction; commit new profile values and markers together only after every required upstream request succeeds. If a request or storage write fails, preserve the previous profile record and activity snapshot so a later call retries. No credential is stored; the access token is an operation argument only.

OAuth already retains the verified account ID on current grants and preserves it through refresh. Keep using that property. Legacy sessions without it continue through the existing authenticated identity resolution path; only a verified settings response may select the per-user object.

## Error handling and compatibility

The tool keeps its current name, empty input schema, and JSON output. Missing verified identity, malformed activities timestamps, Simkl errors, and invalid cached data produce the existing sanitized MCP error result. A failed refresh must not return the prior value as if it were current and must not update either freshness marker. Separate settings and stats watermarks prevent a settings-only activity change from refetching stats and a library/statistics activity change from refetching settings.

The shared 300-second activity-check interval remains the boundary for discovering remote changes; reads inside that interval use the persisted activity snapshot. This preserves the existing request-driven, no-cron behavior.

## Verification

Add focused tests for the durable profile record, existing library schema compatibility, OAuth identity reuse, activity-timestamp transitions, retries after API/storage failure, and cross-account isolation. Exercise the registered MCP tool and real Worker/SQLite RPC path, then run the complete Bun suite, TypeScript check, and Wrangler dry-run. No deployment, merge, or production credentialed request is part of this change.
