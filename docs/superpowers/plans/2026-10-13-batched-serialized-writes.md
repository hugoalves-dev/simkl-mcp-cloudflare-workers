# Batched and Serialized Simkl Writes Plan

> **For agentic workers:** Execute this plan task by task with `superpowers:executing-plans`; use test-driven development and verify before completion.

**Goal:** Implement issue #16 on current `main`: batch supported history payloads and serialize authenticated Simkl writes per account with bounded retry and reliable cache refresh intent.

**Architecture:** Extend the existing `CachedLibrary` coordinator so each account Durable Object owns an authenticated write from upstream request through forced-refresh persistence. Inject that operation into generated write tools and `RewatchService`; retain direct-client compatibility when no hook is supplied. The write queue is account-scoped and shared by sessions. This is also the foundation issue #17 can build on: keep account resolution, operation-local tokens, serialized coordinator semantics, and mutation integration reusable, without pulling #17's user-stats feature into this branch.

**Tech Stack:** TypeScript, Cloudflare SQLite Durable Objects, Bun, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-13-batched-serialized-writes-design.md`

## Constraints

- Base on current `main`; do not depend on or cherry-pick the open issue #17 branch.
- Preserve all current read/cache, OAuth, generated tool, quota guidance, and rewatch behavior.
- Only retry a `SimklApiError` whose upstream code is exactly `rate_limit`, one time after one second. Keep the operation queued through retry and forced-refresh persistence.
- Never persist access tokens or retry ambiguous network failures.
- Keep the current DO class/storage schema; use the existing per-account coordinator.
- Preserve old singular `episode` inputs and standalone generated/RewatchService direct-call compatibility.
- Do not deploy or merge. Publish a branch PR against `main` closing #16 after implementation, verification, and independent review.

## Task 1: Batch history tool inputs and payloads

Files: `scripts/codegen.ts`, `generated/tools.ts`, generated tool tests and fixtures.

- [x] Add failing tests for `movies`, `shows`, `anime`, and `episodes` arrays on history add and remove tools.
- [x] Assert each tool sends one request carrying the complete input arrays, with no item-level loop.
- [x] Add compatibility tests proving `episode` still maps to `episodes: [episode]` when plural `episodes` is absent, while explicit `episodes` takes precedence.
- [x] Update generator templates and regenerate `generated/tools.ts`; keep add-to-list and ratings batch request bodies unchanged.
- [x] Run focused generated-tool/codegen tests.

## Task 2: Add account-scoped queued write operation

Files: `src/library/{coordinator,adapter,cache}.ts`, API error/client types, `tests/library-{coordinator,adapter,worker}.test.ts`, `tests/library-runtime/*`.

- [x] Add failing tests for same-account serialized writes, independent-account concurrency, and queue ordering relative to library reads.
- [x] Add failing tests for success marking forced activity refresh before a queued read can proceed; failed upstream writes must not invalidate.
- [x] Add retry tests: exact `rate_limit` retries once after 1 second; daily/app limits, other API errors, and network failures do not retry; second failure ends after two attempts.
- [x] Test persistence failure after upstream success: preserve in-memory retry intent, return a sanitized explicit invalidation error, and never resend the POST.
- [x] Implement an allowlisted endpoint write operation using the account DO's existing queue. Keep token values local to the operation, never in stored or queued durable state.
- [x] Keep an uninitialized cache's refresh intent so first initialization reads current activities and contents.
- [x] Verify actual Worker/SQLite RPC behavior, including no token persistence and per-account separation.

## Task 3: Route generated and manual writes through the queue

Files: `generated/tools.ts`, `scripts/codegen.ts`, `src/api/rewatches.ts`, `src/tools/rewatches.ts`, `src/mcp-agent.ts`, `src/tools-config.ts`; tests for generated tools, rewatch, MCP agent, and tool configuration.

- [x] Add failing tests proving authenticated generated mutation handlers call the injected queued-write hook and preserve request/response behavior.
- [x] Add failing tests proving rewatch start, update, and stop use the same injected hook; preserve direct-client fallback for existing standalone callers.
- [x] Wire the verified account library adapter once in MCP agent initialization and inject its writer into generated tools and `RewatchService`.
- [x] Route every existing authenticated mutation (including scrobble writes) through the operation; preserve endpoint allowlisting and existing successful-write refresh behavior.
- [x] Confirm reads used for rewatch preconditions are not moved into or blocked by the write queue.

## Task 4: Verify, review, and publish

- [x] Run focused batch, coordinator, retry, adapter, rewatch, generated-tool, and runtime smoke tests.
- [x] Run the complete Bun suite, code generation drift check, TypeScript check, Wrangler dry-run, and `git diff --check`.
- [x] Request independent review of the final diff; resolve valid findings with regression tests.
- [x] Commit the implementation on `codex/issue-16-batched-serialized-writes`.
- [x] Push and open a PR against `main` with `Closes #16`, summarize relationship to issue #17, and include verification evidence. Do not merge or deploy.

