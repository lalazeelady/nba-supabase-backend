# Orphans: local setup (repo cleanup, 2026-10-01)

NBA now lives in one place: `/Users/larazielin/WORKSPACES/sites/NBA`
(`nba3/` = site, `nba-supabase-backend/` = backend). The old copy at
`claude-workspace/claude-code/ppc-workspace-old/nba3` was deleted after checking
that every commit in it was already in `sites/NBA/nba3`.

Leftovers found during the move, for later cleanup:

| item | notes |
|---|---|
| Old Claude memory folders in `~/.claude/projects/` | `-Users-larazielin-Desktop-nba`, `…-claude-workspace-claude-code-NBA`, `…-NBA-nba3`, `…-NBA-nba-supabase-backend`, `…-ppc-workspace-ppc-NBA`, `-Users-larazielin-WORKSPACES-ppc-workspace-ppc-nba`, `-Users-larazielin-claude-workspace-claude-code-NBA`. These are tied to old paths and no longer load. The live memory was copied to `-Users-larazielin-WORKSPACES-sites-NBA`. Review them and merge or delete. |
| Local-only data exports in `nba-supabase-backend/` | 6 xlsx and 4 csv files (Bing revenue, Google conversion import templates, Caliber and Ringba call logs). git ignores them, so they exist only on this Mac. Archive them or delete them. |
| `sites/NBA/.claude/` | Empty folder. |
| `nba-supabase-backend` checkout | Was on `google-monetize-caliber-cutover`, not `main`, at the time of the move. That branch is pushed. Merge it or switch back to `main`. |
| Stale `nba3` branches on GitHub | 20 branches besides `main`, most already merged (e.g. `apply4-conform-ub-styling`, `sitemap-cleanup`, `docs-funnel-playbook`). Prune the merged ones. |
| `nba3/CLAUDE.md` backend path | Still points at `/Users/larazielin/Desktop/nba/...`. Already tracked as ACTION-PLAN P9.1. |
