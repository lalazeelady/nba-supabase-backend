# Orphans / cleanup candidates found while building the reconciliation

Not touched. Listed for a future maintenance pass.

| Item | Where | Note |
|---|---|---|
| `nba3/offline-conversion-tracking.md` | referenced in the `offline_conversion_events` table COMMENT | **File does not exist** in the site repo (`nationalbenefitalliance/`). Dangling doc pointer — either restore the doc or repoint the comment at `docs/offline-cv-accuracy/PLAN.md`. |
| `offline_conversion_test` table (3,450 rows) | Supabase `public` | Its own comment says "Safe to truncate/drop". Staging for the retired CallTools test pixel; not uploaded, no dedupe, no trigger. |
| `ringba_call_id` column | `offline_conversion_events` | Superseded by `conversion_call_id` (kept in sync by `sync_conversion_call_id`). Migration `20260828120600_drop_ringba_call_id_contract.sql` exists but the column is still present. |
| `_capture_clickids.py` | site repo root, untracked | One-off sitewide script from the click-id capture task; per CLAUDE.md one-offs stay local, but it is sitting untracked in the working tree. |
| `offline-cv-accuracy` branch | backend repo | Still checked out as the base of this branch; several docs there describe steps marked "awaiting the word". Worth confirming what's merged. |
| Ringba `utm=bing` / `utm=meta` rows | `offline_conversion_events` | Stored, correctly excluded from Google upload, but counted in `gross_all_sources`. Fine — noted so nobody "fixes" them. |
