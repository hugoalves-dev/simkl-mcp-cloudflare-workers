# Simkl MCP for Cloudflare Workers

☕ **Support this independent project:** [Buy Me a Coffee](https://buymeacoffee.com/vitorhugo1207). Your support is appreciated and entirely optional.

An independently maintained [Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/getting-started/intro) server for [Simkl](https://simkl.com), built with **TypeScript, Bun, and Cloudflare Workers**. Search, discover, and track movies, TV shows, and anime from MCP-compatible clients.

> [!IMPORTANT]
> **Independent community project.** Originally based on [srevinsaju/simkl-mcp](https://github.com/srevinsaju/simkl-mcp), this repository is now maintained separately by [@vitorhugo-dotnet](https://github.com/vitorhugo-dotnet). It follows its own technical direction, releases, and roadmap, and is **not an upstream mirror**. It is not officially affiliated with or endorsed by Simkl or the original project's maintainer.

![Simkl MCP screenshot](docs/img.png)

## Highlights

- **Cloudflare-native runtime:** serverless Worker with KV-backed OAuth state and SQLite-backed Durable Objects for MCP sessions and per-user library storage.
- **MCP connectivity:** Streamable HTTP (`/mcp`) with a legacy SSE (`/sse`) endpoint for clients that still need it.
- **Simkl authentication:** OAuth authorization and access-token refresh, with per-user authentication for private data.
- **Tracking and discovery:** search, watchlists, ratings, scrobbling, rewatches, title details, episodes, and genre-based discovery.
- **Efficient reads:** lazy incremental library synchronization and public API response caching to reduce unnecessary Simkl requests.
- **Repeatable development:** OpenAPI-based tool generation, automated tests, typechecking, and GitHub Actions deployment.

## Project direction

This project prioritizes a **TypeScript/Bun implementation deployed on Cloudflare Workers**, rather than requiring a separately operated server or Kubernetes cluster. It is developed independently of the original repository; upstream features, architectural changes, and release schedules are not automatically inherited.

For issues and contributions specific to this implementation, use this repository's [issues](https://github.com/vitorhugo-dotnet/simkl-mcp-cloudflare-workers/issues) and [pull requests](https://github.com/vitorhugo-dotnet/simkl-mcp-cloudflare-workers/pulls).

## Setup
- Create a Simkl OAuth app and grab `SIMKL_CLIENT_ID` and `SIMKL_CLIENT_SECRET` (redirect URI must match `.../oauth/callback`).
- Add a `.dev.vars` (or Wrangler secrets) with:
  ```bash
  SIMKL_CLIENT_ID=your_client_id
  SIMKL_CLIENT_SECRET=your_client_secret
  OAUTH_REDIRECT_URI=http://localhost:8787/oauth/callback
  ```
- Install deps: `bun install`

## Local (Streamable HTTP)
Run the worker with Wrangler and point your MCP client at the Streamable HTTP endpoint.
```bash
bun run dev
```
Add to `claude_desktop_config.json` (or equivalent):
```json
{
  "mcpServers": {
    "simkl": {
      "transport": "streamable-http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```
For local development, use `http://localhost:8787/mcp`; for a deployed Worker, replace the host with your Worker URL, such as `https://your-worker.workers.dev/mcp`. On first connect, you’ll be redirected to Simkl to approve access, then returned to `/oauth/callback`.

The `/sse` endpoint remains available for MCP clients that require the legacy SSE transport. Prefer `/mcp` for new connections.

## Deploy (Cloudflare Workers)
```bash
wrangler secret put SIMKL_CLIENT_ID
wrangler secret put SIMKL_CLIENT_SECRET
wrangler secret put OAUTH_REDIRECT_URI # e.g., https://your-worker.workers.dev/oauth/callback
bun run deploy            # staging
bun run deploy:production # optional
```
Configure remote MCP clients to use `https://your-worker.workers.dev/mcp` with Streamable HTTP (Claude: Settings → Connectors → Add Server). Use `https://your-worker.workers.dev/sse` only for clients that still require the legacy SSE transport.

### GitHub Actions deployment

The `CI and Deploy` workflow runs separate jobs in order:
Install → Codegen → Typecheck → Test → Deploy. Generated bindings are uploaded once
and downloaded by the later jobs. Tests include the Worker RPC/persistence fixture.
Pull requests run validation; successful pushes to `main` deploy the `simkl-mcp`
Worker from `wrangler.toml`. A manual run on `main` can retry deployment.

Set the repository Actions secrets `CLOUDFLARE_API_TOKEN` (with permission to deploy
this Worker and its configured bindings) and `CLOUDFLARE_ACCOUNT_ID`. Existing
Worker secrets such as `SIMKL_CLIENT_SECRET` remain configured in Cloudflare;
the workflow does not replace them. Deployments are serialized and are not
cancelled when another deployment is queued. Within the deployment lock, runs whose
commit no longer matches `main` skip deployment, including retries of old runs.

## Tools
- **Search**: `simkl_search_by_text`, `simkl_search_by_id`
- **Scrobble**: `simkl_start_watching`, `simkl_pause_watching`, `simkl_stop_watching`
- **Sync/tracking**: `simkl_add_to_watchlist`, `simkl_mark_watched`, `simkl_remove_from_history`, `simkl_add_rating`, `simkl_get_watchlist`
- **Discovery**: `simkl_get_trending_by_genre`, `simkl_get_trending_shows`, `simkl_get_trending_movies`, `simkl_get_trending_anime`, `simkl_get_best_shows`, `simkl_get_best_anime`, `simkl_get_show_by_id`, `simkl_get_movie_by_id`, `simkl_get_anime_by_id`, `simkl_get_show_episodes`, `simkl_get_anime_episodes`, `simkl_get_shows_by_genre`, `simkl_get_movies_by_genre`, `simkl_get_anime_by_genre`, `simkl_get_airing_shows`, `simkl_get_airing_anime`
- **User**: `simkl_get_user_stats`, `simkl_my_stats`
- **Rewatches**: `simkl_start_rewatch`, `simkl_update_rewatch`, `simkl_get_rewatches`, and `simkl_stop_watching` with optional explicit rewatch intent
- **Resources**: `watchlist/{type}/{status}`, `trending/{type}/{interval}`

### Rewatch sessions

Rewatch tracking requires Simkl PRO or VIP. Start a session only when the user explicitly asks to rewatch an existing title; the MCP checks the account plan before writing. Keep the returned `rewatch_id` and provide it on every `simkl_update_rewatch` call. For shows and anime, Simkl marks a session completed when all aired regular episodes have been recorded; movies can be explicitly closed or completed.

`simkl_get_rewatches` keeps canonical and rewatch rows distinguishable and requests full episode progress and watch timestamps. Choose `all` or one media type and a watch status. Supply `date_from` for incremental reads. Set `initial_sync=true` only for the first full read.

To record a player rewatch, call `simkl_stop_watching` with `allow_rewatch=true` only after explicit user intent and progress of at least 80%. Ordinary stops default to no rewatch tracking. The tool returns Simkl's full response; only `rewatch_status` values `active`, `closed`, or `completed` confirm a saved session. `first_watch`, `too_soon`, `not_eligible`, and `pro_required` have distinct meanings. Do not retry an ambiguous write automatically; read sessions before deciding whether a retry is needed. Simkl enforces a two-day gap between repeat watches of an item and a limit of 50 sessions per item.

### Genre discovery

Use `simkl_get_trending_by_genre` for this month’s most watched titles in a genre. It resolves genre slugs from the selected media type’s CDN index and reads the matching `month_500` file. These files contain up to 500 rich title records, are updated daily, and do not support upstream pagination. The tool returns a bounded number of those records and their rich fields without making separate detail requests.

The genre CDN requests include the required app identification and omit `Authorization`. Simkl documents these public data files as requiring no user token and consuming neither daily quota nor per-second limits. The tool covers monthly most-watched rankings only.

Keep the live `simkl_get_shows_by_genre`, `simkl_get_movies_by_genre`, and `simkl_get_anime_by_genre` tools for other sorts and filters such as country, network, year, and type, and for queries the monthly files do not cover. Under AUTH V2, live genre requests require the user's access token and consume that user's shared daily allowance; under AUTH V1 they consume the app's daily allowance. Live requests also count toward the applicable per-second limit (10 GET requests per second). Live pagination caps are 20 pages and 60 items per page.

### API response caching

Public catalog GET responses are cached in the Cloudflare Workers Cache API using the complete request URL, including query parameters. Authorization headers are never part of the cache key. Search, best, and genre results are cached for **1 hour**; detail and episode responses for **6 hours**. The trending data index and genre files are cached for at most **1 hour**, in line with Simkl's CDN freshness guidance. Cached trending responses retain the upstream `Last-Modified` header. User-specific endpoints and failed upstream responses are not cached.

## Authentication
- Public requests add `client_id` as a query param; authenticated calls use `Authorization: Bearer <token>`.
- The Worker handles OAuth: `/auth/simkl` redirects to Simkl, `/oauth/callback` exchanges the code and issues MCP credentials.
- Token-free upstream CDN calls do not make this server's `/mcp` or `/sse` endpoints anonymous. MCP clients still authenticate through the Worker OAuth flow.
- AUTH V2 access tokens last 7 days. Refresh tokens last 180 days on a sliding lifetime that renews when used; Simkl returns the same refresh token on refresh. The Worker refreshes access tokens as needed. For local dev, secrets live in `.dev.vars`; production uses Wrangler secrets and KV (`OAUTH_KV`) for state.

## Development

### Library cache foundation

The `SIMKL_LIBRARY_CACHE` SQLite Durable Object stores one canonical library per
verified Simkl account ID, independently of MCP sessions. New OAuth grants retain
that ID; legacy sessions resolve it through authenticated `/users/settings` before
selecting an object. Random provider fallback IDs never select library caches.

`LibraryService` exposes initialization and item reads for future consumers. The
object coalesces concurrent first reads, fetches activities and then shows, movies,
and anime sequentially without `extended`, and commits separate item rows and the
activities snapshot in a synchronous transaction after every pull succeeds. A
`400 max_items` response splits only that media type into supported status pulls (three for movies, five for shows/anime). Access
tokens are operation arguments and are never stored in the library object.

Successful library pulls have a 16 MiB streamed response cap; unrelated requests
and error responses retain the 2 MiB cap. Pending item JSON is capped at 32 MiB in
total, and each stored item or metadata JSON at 1 MiB. Exceeding a limit fails
initialization without recording completion or truncating data.

The #13 foundation now supports incremental freshness for #14. Watchlist tools
and resources use the same per-user object; existing initialization and stored rows
remain compatible. Queries and filtering beyond type/status remain separate work.
Migration `v2` adds the library object without changing the existing MCP migration.

### Incremental freshness

`SIMKL_LIBRARY_CACHE_TTL_SECONDS` sets the minimum interval between successful
`GET /sync/activities` checks per verified user. It defaults to **300 seconds**.
Use a positive decimal integer string such as `"60"`; missing, undefined, null,
empty, whitespace-only, fractional, non-positive, nonnumeric, exponent, boolean,
and unsafe values fall back to 300. Refresh is lazy: inactive users are not polled.

An unchanged top-level `activities.all` makes no item or ratings calls. Changed
list/status buckets fetch one all-types `/sync/all-items` delta, and changed
`rated_at` fetches `/sync/ratings`, using the previous top-level `all` as
`date_from`. A removal change reconciles current `extended=simkl_ids_only`
membership. Both documented `{}` empty responses and legacy `null` refresh
responses are supported; malformed data or incomplete advertised pagination fails
without advancing the snapshot. Ratings with `user_rating: null` clear the score.

Items and the activity snapshot commit atomically after every required pull
succeeds. A failed forced refresh retains retry intent, including across object
reconstruction once persisted. Successful library writes, including manual
rewatch/history/stop tools, force the next read to check activities. Call
`simkl_refresh_library` to bypass the interval explicitly without discarding data.

`simkl_my_stats` uses the same per-account Durable Object to cache user settings
and statistics. It checks `/sync/activities` on the configured lazy interval,
refreshes settings when `activities.settings.all` changes, and refreshes stats
when top-level `activities.all` changes. Stats reads reuse an already-fresh
library activity snapshot when available and never initialize or advance the
watchlist cache. Profile values and their activity markers persist in the
existing metadata table; Simkl's `null` activity markers are valid and cached
like timestamps. Access tokens remain operation arguments only.

Cached watchlists return the foundation's default rich summary. Type/status
selection is supported; request-specific delta filters and enhanced/reduced
projections (`date_from`, `extended`, `episode_watched_at`, `memos`) are rejected
explicitly rather than returning a mismatched cached view. This change reuses
migration `v2` and requires no additional migration.

Run the fixture-only Worker RPC/persistence smoke test with
`node tests/library-runtime/smoke.mjs`. It uses Wrangler's installed Miniflare and
esbuild dependencies, redirects upstream fetches to fixture data, and makes no live
Simkl requests. Fixtures never become production routes.

```bash
# Download the latest Simkl OpenAPI document into api/simkl-openapi.json
bun run refresh:openapi

# Regenerate tools from the checked-in OpenAPI document
bun run codegen

# Check that generated tools match the checked-in source and configuration
bun run codegen:check

# typecheck
bun run typecheck

# health check
curl http://localhost:8787/health
```

The generator reads the checked-in snapshot at `api/simkl-openapi.json`, so code generation works without network access and produces repeatable output. After refreshing the snapshot, review and commit both it and `generated/tools.ts`. CI runs `bun run codegen:check` to catch generated output drift.

## Acknowledgments

**Special thanks to [Srevin Saju (@srevinsaju)](https://github.com/srevinsaju)** for creating and open-sourcing the original **[simkl-mcp](https://github.com/srevinsaju/simkl-mcp)**. His work was the foundation and inspiration for this project, and it deserves explicit credit.

This repository has evolved into a separate implementation with its own maintenance and architectural decisions. It is **not presented as an official continuation or replacement** of the original project. Please visit the [original repository](https://github.com/srevinsaju/simkl-mcp) to explore or contribute to upstream development.

## License

Licensed under the [MIT License](LICENSE). The original copyright notice for Srevin Saju is preserved in `LICENSE`.

### Public capability catalog

The landing page reads `/capabilities.json`, generated by `bun run capabilities`
using the same registrations as the deployed MCP agent and the SDK's in-memory
`tools/list`, `resources/list` and `resources/templates/list` APIs. No tool calls,
resource reads, Simkl credentials, KV or Durable Objects are used for generation.
The manifest includes input schemas and public metadata only. Counts and search
are rendered from this catalog; `/mcp` is the preferred Streamable HTTP transport,
and `/sse` remains available for legacy clients.

Wrangler's build hook regenerates the catalog for dev and every deployment.
After changing registrations, run `bun run capabilities` and commit the updated
`static/capabilities.json`. CI checks drift against both shared registration and
the actual agent. The page and catalog revalidate on subsequent requests.

For a custom domain, set the repository Actions variable `WORKER_URL` to the
deployed Worker origin; otherwise CI uses the workers.dev URL from Wrangler.
The deployment workflow runs `bun run smoke:capabilities "$WORKER_URL"` after a
successful deployment and compares its public catalog to the local build. The
same command can be run against `http://localhost:8787` during `bun run dev`.
