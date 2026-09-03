# ORPHANS — Google Sheet offline-conversion pipeline

Written during the **Sheet → Data Manager API cutover** (branch `gads-cco-datamanager-api-cutover`).

**Cutover completed 2026-09-03.** The API is now the sole upload path to Google Ads, so everything
below is **dead weight kept deliberately for rollback**. Nothing here is deleted — this is the
cleanup list for later. Do not clean up until the API path has run solo and verified clean for at
least two weeks (i.e. not before ~2026-09-17).

Note the Sheet cron (jobid 3) is still running by choice; see the table below.

Rollback is documented in [`SHEET-TO-API-READY.md`](SHEET-TO-API-READY.md). Every item below is
part of that rollback path, which is why it still exists.

---

## 1. Cron jobs

| jobid | name | State after cutover | Notes |
|---|---|---|---|
| 3 | `sync-google-sheet-15min` | **STILL RUNNING (deliberate)** | Owner chose to leave it after cutover so rollback stays lossless. Harmless: the Ads Sheet import is off, so nothing it writes reaches Google. Unschedule with `cron.unschedule('sync-google-sheet-15min')` whenever you want; rollback = re-`cron.schedule` with the exact command in SHEET-TO-API-READY.md. |
| 4 | `archive-old-sheet-rows-daily` | **Left running** (agreed) | Only trims rows off the Sheet. Harmless, and cheap insurance if the Sheet is ever restored. Safe to unschedule any time. |
| 8 | `upload-google-offline-conversions` | **Active — the live path** | Not an orphan. Do not touch. |
| 10 | `pipeline-health-check-hourly` | **Active** | Not an orphan. Rewritten in this branch to watch the API only. |
| 11 | `rematch-offline-conversions` | **Active** | Not an orphan — attribution re-matching, independent of the upload path. |

## 2. Edge functions — Sheet-only, become idle

Still deployed, no longer invoked by any cron once jobid 3 is unscheduled.

| Function | What it did | Cleanup verdict |
|---|---|---|
| `sync-google-sheet` | Appended eligible rows from `v_offline_conversion_export` to the Google Sheet that Google Ads imported. **The retired path itself.** | Keep until rollback window closes. It is the entire rollback. |
| `archive-old-sheet-rows` | Trimmed rows >90d off the Sheet so the Ads import never saw expired conversions. | Keep while jobid 4 runs. |
| `export-google-sheet-csv` | One-off CSV export of the Sheet-facing data. | Already orphaned *before* this cutover — nothing schedules it. Safe to delete. |
| `prune-sheet-rows-by-order-id` | One-off surgical removal of specific Sheet rows by Order ID. | One-off remediation tool. Safe to delete, or keep as a manual utility. |
| `backfill-google-sheet-pii` | One-off backfill of PII columns into existing Sheet rows. | One-off. Safe to delete. |

## 3. Database columns / objects

| Object | Status | Notes |
|---|---|---|
| `offline_conversion_events.sheet_synced_at` | **Keep for now** | Freezes after cutover. Still read by `v_offline_cv_upload_daily.also_on_sheet` for overlap-window comparison, and required by the Sheet rollback. |
| `v_offline_conversion_export` | **Active — shared** | NOT an orphan. The API path reads it too. It was always the single canonical record for both paths. |
| `offline_conversion_events.ringba_call_id` | Pending drop | Contract migration `20260828120600` proposes dropping this + the sync trigger + unused `google_ads_customer_id` / `google_ads_conversion_action_id`. Pre-existing item, unrelated to this cutover. Was already gated on "after the flip is stable". |

## 4. Google Ads side (owner-managed, not code)

| Item | Action |
|---|---|
| Scheduled Sheet import on `CallConvertOffline` | **Turn OFF** during cutover step 3. This is what actually stops the double-feed. |
| `Test_DataMgrAPIUpload` conversion action | Goes quiet once `..._CALLMONETIZE` points at the real action. Pause it in the Ads UI rather than deleting — historical data lives there, and `GOOGLE_DATA_MANAGER_DESTINATION_ID_TEST_OVERRIDE` can re-target it for future validation. |
| Legacy env `GOOGLE_DATA_MANAGER_DESTINATION_ID` | Superseded by `..._CALLMONETIZE`. Still read as a fallback in `destinationFor()`. Delete the secret only after confirming `..._CALLMONETIZE` is set, or CCO events silently lose their destination. |

## 5. Known data residue (not caused by this cutover)

**153 permanently-stranded rows.** `monetize_ready` / `transfer_ready` events with
`conversion_time` between **2025-03-18 and 2026-06-03** — all past the uploader's 85-day cutoff, so
they are skipped on every run and can never be delivered (Google rejects conversions >90 days old).
They are harmless but they inflate "pending" counts forever.

Surfaced in `v_offline_cv_upload_daily.stranded_past_90d_window`. They do **not** trip the health
check, which filters on `conversion_time >= now() - 85 days`.

Optional cleanup, deferred (not run):

```sql
-- Terminal status for events that can never reach Google. Review the SELECT first.
update offline_conversion_events
   set status = 'expired', updated_at = now()
 where publisher = 'NBA'
   and status in ('monetize_ready', 'ready_to_upload', 'transfer_ready')
   and conversion_time < now() - interval '85 days';
```
