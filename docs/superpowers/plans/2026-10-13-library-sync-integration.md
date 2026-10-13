# Incremental Library Synchronization Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the approved issue #14 implementation as a reviewable PR against current main, preserving merged #13 and #10 behavior.

**Architecture:** Extend the existing per-user cache and completion metadata, keeping its SQL schema and initialization API. A staged refresh engine and serialized coordinator provide TTL checks, atomic deltas, and retry intent; MCP hooks connect reads and successful writes.

**Tech Stack:** TypeScript, Cloudflare SQLite Durable Objects, Bun, Wrangler/Miniflare.

**Spec:** `docs/superpowers/specs/2026-10-13-library-sync-integration-design.md`

## Global Constraints

- Preserve current-main storage, OAuth, rewatch, quota-error, max_items, row-size and response-limit contracts.
- Default TTL to 300 seconds, validate positive integer seconds, and never poll inactive users.
- Use prior top-level activities.all as delta watermark and advance it only with successful transactional application.
- Current API contracts specify GET activities and valid empty `{}`; do not apply the obsolete empty-object rejection.
- No new Durable Object migration; no deployment or merge as part of the authorized PR creation.

## Review Focus

- Existing completion rows must be reusable without a full reinitialization.
- Every successful manual rewatch mutation must invalidate alongside generated mutations.
- Failed forced refreshes must retry on an ordinary read, including after restart.
- Initial and incremental pulls must reject incomplete advertised pagination.
- Default summary data must not be presented as an enhanced projection.

### Task 1: Refresh engine and storage compatibility

Files: `src/library/{types,refresh,coordinator,store,sync,cache}.ts`, `src/api/client.ts`; tests: `library-refresh`, `library-coordinator`, `library-freshness-store`, `library-initial-pagination`, existing foundation tests.

- [x] Run current-main baseline (114 pass).
- [x] Port failing TTL/delta/coordinator tests before implementation.
- [x] Add failing completion-compatibility, canonical-ID, and initial-pagination tests.
- [x] Implement refresh engine and metadata adapter while retaining existing APIs/SQL tables and max_items fallback.
- [x] Enable cache-only strict pagination and bounded all-types library/ratings profiles.
- [x] Run focused tests and existing foundation tests to green.

### Task 2: MCP consumers and mutation hooks

Files: `src/library/{adapter,watchlist}.ts`, `src/mcp-agent.ts`, `scripts/codegen.ts`, `src/tools/rewatches.ts`, README and Wrangler vars; tests: library adapter/tools/MCP and existing rewatch tests.

- [x] Add failing generated/manual mutation and registered-tool/resource routing tests.
- [x] Preserve current-main MCP error/quota handling while adding optional hooks.
- [x] Route cached summary reads, reject unsupported projections, and add explicit refresh tool.
- [x] Invalidate after successful generated and manual library mutations; preserve failed/ambiguous-write behavior.
- [x] Document the TTL and existing-schema compatibility.

### Task 3: Verification and PR publication

- [x] Run full Bun suite and both real Worker runtime suites.
- [x] Run final code generation, TypeScript, and Wrangler deployment dry-run.
- [x] Obtain independent review of the reconciled branch; fix Important findings with red/green tests.
- [ ] Commit, push `codex/issue-14-library-sync`, and open a PR against main with `Closes #14` and verification evidence.


Review result: the reconciled suite passes 222 tests, plus both real Worker smoke suites, code generation, TypeScript, and Wrangler dry-run. Independent review's quota-prototype and truncated-pagination findings were fixed with red/green tests. Mixed error/data membership was regraded Important because it could erase cached items, and fixed in the same pass. Actual Worker RPC tests confirm daily-limit guidance and Retry-After survive without leaking upstream bodies. `{}` remains a valid empty response under the latest documented contract.
