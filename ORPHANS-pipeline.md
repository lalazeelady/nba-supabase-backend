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
| `offline_conversion_events.ringba_call_id` | Superseded by `conversion_call_id` (see migration `20260828120600_drop_ringba_call_id_contract.sql`). Still present for historical rows, and a `BEFORE INSERT` trigger (`trg_00_sync_conversion_call_id` → `sync_conversion_call_id()`) keeps the two mirrored on every write. Neither webhook writes `ringba_call_id` any more, so the trigger exists purely to keep a deprecated column populated. **Confirmed the two columns are identical on all 97,862 rows** (Sep 2026), so the column carries no information `conversion_call_id` does not. Drop the column and the trigger together, once no report reads it. |
| `offline_conversion_events.status = 'ready_to_upload'` | Pre-rename alias for `monetize_ready`, renamed 2026-08-07. Nothing has written it since, but it is still accepted in three places: `ELIGIBLE_STATUSES` in the uploader, `offline_cv_api_backlog()`, and the health check's mirror of that list. **Confirmed 0 of 97,862 rows carry it** (Sep 2026), so it is safe to remove from all three at once — they must stay in step. |
| `v_offline_conversion_export.session_attributes` / `.user_agent` | Both hardcoded `NULL::text` in the view, while the webhooks go to some trouble to collect and backfill `user_agent`. Either wire the column through or stop collecting it; right now it is a dead end that looks live. |

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

---

## Added 11 Sep 2026 — Customer Match build

Branch `gads-customer-match-datamanager-api` moved Google Ads **Customer Match** off
the manual Google Sheet onto the Data Manager API, mirroring the Sep-2026
offline-conversion cutover.

Its orphan list and findings live in
[`docs/customer-match/ORPHANS-customer-match.md`](docs/customer-match/ORPHANS-customer-match.md).
Highlights, none of them acted on:

| Item | Verdict |
|---|---|
| `NBA Google Customer Match` Google Sheet | Superseded. Holds ~63k people's name/email/phone/address in **plaintext in Drive**. Turn off any Google Ads scheduled import first, then delete. |
| `supabase/functions/_shared/upload-providers/` (6 files, ~490 lines) | **Fully orphaned** — no deployed function imports it (grep-confirmed). It is a second, divergent copy of the Data Manager provider. Safe to delete. |
| `v_offline_conversion_export` + 2 sibling views readable by `anon` | ⚠️ **Pre-existing PII exposure.** No `security_invoker`, so they bypass RLS on `leads`; the publishable key can read email/phone/name/zip. Fix suggested, not applied. |
| Dry runs bump `upload_attempts` in `upload-google-offline-conversions` | ⚠️ **Pre-existing latent bug.** Six dry-run cycles push a row past `MAX_ATTEMPTS` permanently, invisibly. Not biting while the path is live. |
| `offline_conversion_events.offer` | Still 0 / 71,936. NOT an orphan — it is the hook the per-program audiences hang on. |

## Bing offline conversions (branch `bing-offline-conversions-live`, 2026-09-25)

Nothing deleted. See [`docs/bing-offline-conversions/README.md`](docs/bing-offline-conversions/README.md).

| Item | Verdict |
|---|---|
| `EXCEL_Conversion_Enhanced_Import_Template_*.xlsx` (5, repo root) | Manual Bing upload files. Loaded into `bing_manual_uploads`; git-ignored, not committed. Safe to move out of the repo once Bing is live. |
| `bing_manual_uploads` | All 5 manual files (1,201 rows). Still read on every Bing run (msclkid exclusion), so NOT an orphan while that rule stands. |
| `mark_bing_manual_uploads()` | Called by the uploader before every Bing batch. Keep with the table. |
| Bing rows skipped `uploaded_by_legacy` | Fixed 2026-09-25: re-opened (legacy only ever uploaded to Google). `uploaded_by_legacy` is now Google-only in practice. |
| `postback_health()` pending check was Google-only | Fixed 2026-09-26: Bing stuck-queue alert added; Bing dry runs no longer raise false 'check failed' alerts. |
| 88 Bing leads with revenue but no Caliber postback ($1,981, 09-16…09-22) | Explained 2026-09-25: Ringba calls (legacy `offline_conversion_events`), already uploaded by hand. Ringba ended 2026-09-22. |
