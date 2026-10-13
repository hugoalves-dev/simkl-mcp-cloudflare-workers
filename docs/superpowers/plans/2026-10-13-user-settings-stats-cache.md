# User Settings and Stats Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement issue #17 by caching authenticated Simkl settings and statistics in the existing per-user SQLite Durable Object and open a PR against `main` that closes the issue.

**Architecture:** Extend the existing `SimklLibraryCache`, `LibraryStore`, and serialized `CachedLibrary` coordinator. Store a separate profile record with its own activities check time and settings/stats watermarks; keep the library completion record, item rows, schema, and Durable Object migrations unchanged. Route `simkl_my_stats` through the authenticated per-user cache and preserve its JSON response.

**Tech Stack:** TypeScript, Cloudflare Workers and SQLite Durable Objects, Bun tests, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-13-user-settings-stats-cache-design.md`

## Global Constraints

- Use the existing `SimklLibraryCache` keyed by verified canonical Simkl ID; do not add a Durable Object class or migration.
- A stats read must not initialize the full watchlist cache or advance its synchronization watermark.
- Reuse activities during `SIMKL_LIBRARY_CACHE_TTL_SECONDS`; default remains 300 seconds.
- Refresh settings when `activities.settings.all` changes and stats when top-level `activities.all` changes.
- Keep activity, settings, and stats data per Simkl user and persistent across Durable Object reconstruction.
- Commit profile values and markers together only after required upstream requests succeed.
- Keep access tokens as operation arguments; never persist them.
- Keep `simkl_my_stats` tool name, empty input, and pretty-printed JSON response unchanged.
- Do not deploy or merge the PR.

## Review Focus

- Decimal account IDs larger than JavaScript's safe integer range must still produce the exact `/users/<id>/stats` path (Task 2).
- Legacy sessions without a verified `simklUserId` must resolve settings before object selection and must never select a random provider ID (Task 3).
- An oversized or malformed profile record must not replace the last valid cached values or advance its watermarks (Task 1).
- Concurrent stats and library operations must serialize so an invalidation or activities update cannot be lost (Task 2).
- A failure after fetching activities or settings must leave profile markers unchanged so a later read retries (Task 2).

---

### Task 1: Durable profile-cache record

**Files:**
- Modify: `src/library/types.ts`
- Modify: `src/library/store.ts`
- Test: `tests/library-profile-store.test.ts`

**Interfaces:**
- Produce `UserProfileSnapshot = { version: 1; activities: Activities; checkedAt: number; settingsActivity?: string; settings?: Record<string, unknown>; statsActivity?: string; stats?: Record<string, unknown> }`.
- Produce `LibraryStore.loadProfile(): UserProfileSnapshot | undefined` and `LibraryStore.saveProfile(snapshot: UserProfileSnapshot): void`.
- Preserve the existing `library_metadata` schema and store the record under a separate `user-profile` metadata key.

- [ ] **Step 1: Write failing SQLite tests** for save/load across store reconstruction; independent library completion/item retention; malformed JSON rejection; and serialized profile records over `MAX_ROW_JSON_BYTES` rejected before transaction.
- [ ] **Step 2: Run** `bun test tests/library-profile-store.test.ts`.
  **Expected:** Fail because `UserProfileSnapshot`, `loadProfile`, and `saveProfile` are not implemented.
- [ ] **Step 3: Implement profile load/save** in `LibraryStore`. Validate schema version and record shape on load; pre-serialize and enforce the existing per-row byte cap before a synchronous metadata-only transaction.
- [ ] **Step 4: Run** `bun test tests/library-profile-store.test.ts tests/library-store.test.ts tests/library-freshness-store.test.ts`.
  **Expected:** All focused store and compatibility tests pass.
- [ ] **Step 5: Commit** as `feat: persist per-user settings and stats cache`.

### Task 2: Freshness-aware profile refresh

**Files:**
- Create: `src/library/profile.ts`
- Modify: `src/library/coordinator.ts`
- Modify: `src/api/user.ts`
- Test: `tests/library-profile.test.ts`
- Test: `tests/user.test.ts`

**Interfaces:**
- Consume `UserProfileSnapshot`, `LibraryStore.loadProfile/saveProfile`, `getCurrentUserSettings`, and `getUserStats`.
- Produce `refreshUserProfile(client: SimklClient, token: string, simklUserId: string, previous: UserProfileSnapshot | undefined, librarySnapshot: LibrarySnapshot | undefined, options: { ttlSeconds: number; now: number }): Promise<{ snapshot: UserProfileSnapshot; stats: Record<string, unknown> }>`.
- Produce `CachedLibrary.withExclusive<T>(operation: () => Promise<T>): Promise<T>` using the coordinator's existing queue.
- Change `getUserStats` to accept `number | string`, preserve a decimal string exactly, and reject non-positive or non-decimal IDs before making a request.

- [ ] **Step 1: Write failing API and refresh tests.** Assert exact string preservation for a decimal ID above `Number.MAX_SAFE_INTEGER`; first read requests activities, settings, and stats; repeated read inside TTL makes zero requests; changed `settings.all` requests settings only; changed top-level `all` requests stats only; both markers changed requests both; expired profile checks reuse a fresh library activity snapshot; an absent/stale library snapshot requests `/sync/activities` only without initializing or advancing the library cache; invalid IDs make no request.
- [ ] **Step 2: Run** `bun test tests/library-profile.test.ts tests/user.test.ts`.
  **Expected:** Fail because the profile refresh function and exact string ID support are absent.
- [ ] **Step 3: Add failure and serialization tests** for activities/settings/stats request failures, invalid timestamps, oversized response serialization, retry after failure, and concurrent `withExclusive` operations.
- [ ] **Step 4: Run** `bun test tests/library-profile.test.ts tests/user.test.ts tests/library-coordinator.test.ts`.
  **Expected:** New failure and queue tests fail before implementation.
- [ ] **Step 5: Implement the refresh function and queue entry point.** Use the prior profile's activities within TTL; otherwise reuse an initialized library snapshot still inside TTL (preserving that snapshot's `checkedAt`) or make an activities-only request (set check time to `options.now`). Fetch settings and stats only when their markers are absent or have moved. Stage all updates, validate serializable object responses and timestamps, and return without mutating storage; keep request failures retryable.
- [ ] **Step 6: Run** `bun test tests/library-profile.test.ts tests/user.test.ts tests/library-coordinator.test.ts`.
  **Expected:** All profile freshness, retry, ID, and queue tests pass.
- [ ] **Step 7: Commit** as `feat: refresh user settings and stats by activity timestamps`.

### Task 3: Durable Object and MCP integration

**Files:**
- Modify: `src/library/cache.ts`
- Modify: `src/library/adapter.ts`
- Modify: `src/mcp-agent.ts`
- Test: `tests/library-adapter.test.ts`
- Test: `tests/library-mcp.test.ts`
- Test: `tests/library-worker.test.ts`

**Interfaces:**
- Consume `refreshUserProfile`, `CachedLibrary.withExclusive`, and the profile store methods from Tasks 1–2.
- Produce `SimklLibraryCache.getUserStats(token: string, simklUserId: string): Promise<Record<string, unknown>>`.
- Add `LibraryAdapter.getUserStats(): Promise<Record<string, unknown>>`; resolve legacy identity with the existing authenticated settings path and pass the canonical verified ID to the Durable Object.

- [ ] **Step 1: Add failing integration tests** proving verified OAuth IDs address the corresponding cache object, profile responses survive real Durable Object reconstruction, and two account IDs return isolated settings/stats.
- [ ] **Step 2: Run** `bun test tests/library-adapter.test.ts tests/library-mcp.test.ts tests/library-worker.test.ts`.
  **Expected:** Fail because the profile RPC and adapter method are not implemented.
- [ ] **Step 3: Add failing MCP-tool tests** for the unchanged tool name/schema/pretty JSON output, cached second reads, and sanitized error results without upstream body leakage.
- [ ] **Step 4: Run** `bun test tests/library-mcp.test.ts`.
  **Expected:** New registration assertions fail because the tool still performs settings and stats requests directly.
- [ ] **Step 5: Implement the cache RPC and adapter method.** Validate the canonical ID against the existing identity helper; call `refreshUserProfile` under `withExclusive`; persist only the returned completed snapshot. Replace direct tool requests with `this.library.getUserStats()` and keep current error formatting.
- [ ] **Step 6: Run** `bun test tests/library-adapter.test.ts tests/library-mcp.test.ts tests/library-worker.test.ts`.
  **Expected:** All adapter, MCP, and real Worker/SQLite integration tests pass.
- [ ] **Step 7: Commit** as `feat: serve current user stats from the per-user cache`.

### Task 4: Documentation and branch verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-13-user-settings-stats-cache-design.md` only if implementation clarifies an approved detail.

- [ ] **Step 1: Document** that `simkl_my_stats` uses a per-user durable settings/stats cache, the activity-based invalidation markers, and the existing lazy 300-second activities check.
- [ ] **Step 2: Run the complete Bun suite** with `bun test`.
  **Expected:** All tests pass with zero failures.
- [ ] **Step 3: Run TypeScript checking** with `bun run typecheck`.
  **Expected:** Exit code 0.
- [ ] **Step 4: Run Wrangler validation** with `node_modules/.bin/wrangler deploy --dry-run`.
  **Expected:** Dry-run builds successfully with the existing Durable Object bindings and no migration changes.
- [ ] **Step 5: Run** `git diff --check` and review the branch diff against `origin/main`.
  **Expected:** No whitespace errors; only issue #17 cache, integration, tests, and documentation changes.
- [ ] **Step 6: Commit** as `docs: describe cached user statistics`.

### Task 5: Review and open the PR

- [ ] **Step 1: Review the full branch diff** against `origin/main` for identity isolation, upstream error sanitization, cache marker advancement, and compatibility with existing cache metadata.
- [ ] **Step 2: Push** `codex/issue-17-user-stats-cache` to `origin`.
- [ ] **Step 3: Open a pull request** against `main` with `Closes #17`, a concise change summary, and verification results. Do not merge or deploy.
