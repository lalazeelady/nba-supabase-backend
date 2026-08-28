# Cutover & Switchover Checklists

Two independent switchovers. Do each only when you're ready; each is a small, reversible set of steps.

---

## A. Caliber cutover (stop CallTools internet, start Caliber)

**State today:** Caliber is live-firing and VISIBLE in `offline_conversion_events`, but HELD OUT of
Google upload (stopgap view excludes `raw_payload ? 'status'`). CallTools internet is the live
internet upload path.

**Before cutover (yours):**
1. Fix the lead-submission process so `utm_source` (and click ids) flow through to Caliber — otherwise
   the source filter suppresses ~100% of internet (every Caliber row today has blank `utm_source` +
   non-google `ib_source`). Confirm real Caliber rows arrive with `utm_source=google` where applicable.
2. Confirm Caliber sends the actual call time in `conversion_time` (currently arriving blank → we
   timestamp at receipt, which is close but not exact).

**Cutover steps:**
1. Deploy the full branch (webhooks + migrations 20260828120000–120400) if not already — this stamps
   `source='caliber'` and enables phone/day dedup + no-connect drop.
2. Remove the hold-out: in `v_offline_conversion_export`, delete the two lines
   `and oce.source <> 'caliber'` and `and not (oce.raw_payload ? 'status')`.
3. Turn OFF the old CallTools internet pixel (yours) so internet isn't double-counted.
4. Watch for a day: internet CCO count should ≈ internet transfer count; totals shouldn't jump.

**Rollback:** re-add the two hold-out lines (or re-run the stopgap migration) and re-enable CallTools.

---

## B. Sheet → Data Manager API switchover (retire the Sheet)

**State today:** both paths run in parallel. The API routes by conversion name to Data-Manager
destination env ids; the Sheet path feeds Google Ads' scheduled import.

**Cutover steps:**
1. Point the API CCO destination at the REAL CCO action: set
   `GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE` to the real CallConvertOffline destination
   (today it may point at the test action). CallXfer already uses
   `GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER`.
2. In Google Ads, turn OFF the Sheet scheduled import (so the Sheet stops creating conversions).
3. Disable the Sheet cron: `select cron.unschedule('sync-google-sheet-15min');` (reversible).
4. Confirm `GOOGLE_UPLOAD_ENABLED=true` and `GOOGLE_UPLOAD_PROVIDER=data_manager` so the API actually
   sends (not dry-run).
5. Watch a day: API `status='uploaded'` counts should match what the Sheet used to append.

**Backend cleanup after (optional):** see CLEANUP-README.md — drop the `ready_to_upload` alias, the
dead phone/day Order-ID rank branch, and the orphan export/backfill functions.

**Rollback:** re-schedule the Sheet cron and re-enable the Google Ads Sheet import.
