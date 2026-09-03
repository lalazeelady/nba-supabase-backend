# ORPHANS — pipeline code with no live caller

Written while auditing the lead data flow (Sep 2026). **Nothing here has been
deleted.** This is a list to review when you next want to reduce maintenance
surface. Verify each before removing.

## Edge functions

| function | status | notes |
|---|---|---|
| `ringba-conversion-webhook-test` | **orphan — safe to delete** | Deployed v2, never updated, exists only in Supabase (no copy in this repo). A scratch copy of the real webhook. Confirm no Ringba pixel points at it, then delete. |
| `sync-google-sheet` | **likely dead** | Superseded by the Data Manager API cutover (`779ec9b`, "GADS offline conversions: cut CCO over from Sheet to Data Manager API"). Last deployed before the cutover. Keep only if the Sheet is still a human reporting surface. |
| `export-google-sheet-csv` | likely dead | Same cutover. |
| `backfill-google-sheet-pii` | one-shot, spent | Written to backfill PII into existing Sheet rows. Its job is done. |
| `prune-sheet-rows-by-order-id` | one-shot, spent | Cleanup utility for a specific incident. |
| `archive-old-sheet-rows` | conditional | Only meaningful while the Sheet is still written to. |

The five Sheet-era functions are all safe to keep — they cost nothing idle. The
reason to remove them is that each one still reads `offline_conversion_events`,
so they are surface area to reason about on any schema change.

## Database

| object | notes |
|---|---|
| `leads.lead_source` | Derived from `utm_source` (google / bing / openai / meta). Owner's call, Sep 2026: **redundant now that `utm_source` is reliably populated** (21,788 of 22,369 leads). Populated on 9,591 rows; nothing downstream reads it — it is sent to neither CRM. Left in place; drop it once no report references it. |
| `offline_conversion_events.ringba_call_id` | Superseded by `conversion_call_id` (see migration `20260828120600_drop_ringba_call_id_contract.sql`). Still present for historical rows. |

## Site repo (`claude-workspace/claude-code/NBA`)

| path | notes |
|---|---|
| `apply/1/` | Legacy funnel, 308-redirected to `/apply/2`. Kept as rollback reference. Its `step-5/index.html` still posts the legacy `click_id` and no `landing_page` — **deliberately not updated**, since the redirect means it is unreachable. |
| `apply/3/` | Retired A/B variant, 308-redirected. Same situation. |
| `apply/1/form/*` | React SPA leftover from an early exploration. Documented as do-not-extend in `CLAUDE.md`. Genuinely unused. |

## Fields collected and never consumed

Tracked here so they don't get "fixed" twice.

- `hp_website` — honeypot. Deliberately not stored on accepted leads.
- `consent_ad_storage` / `consent_ad_user_data` / `consent_ad_personalization` —
  Consent Mode v2, plumbed through to Caliber but never populated. NBA runs US
  traffic only; these are EU/UK requirements. Keep the plumbing, expect nulls.
- `click_timestamp` — a column and a Caliber field now exist, but no funnel
  captures it yet. Populating it is a site-repo change.
