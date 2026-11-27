# Changelog

## Unreleased

- Add `simkl_edit_watch_dates` for dates on existing movies, episodes, and rewatch sessions.
- Add `simkl_edit_memos` for setting or clearing library memos with optional privacy, and memo display in `simkl_get_watchlist`.
- Reconcile successful edits with the per-account library cache using Simkl activity checkpoints and incremental reads.
