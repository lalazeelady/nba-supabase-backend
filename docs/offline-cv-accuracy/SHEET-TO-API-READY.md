# Sheet → Data Manager API cutover — DONE (2026-09-03)

> **STATUS: complete and verified in production.** CallConvertOffline is fed by the Data Manager
> API only; the Google Ads scheduled Sheet import is OFF; conversions were confirmed landing on
> the correct action in the Ads UI. Steps 1–4 below are done.
>
> **Step 5 (`cron.unschedule('sync-google-sheet-15min')`) was deliberately NOT run.** The Sheet
> cron keeps mirroring rows so the rollback stays lossless — re-enable the Ads import and no
> window is missing. It costs nothing and there is no double-count risk while the Ads import is
> off. Run step 5 whenever you want to finish tidying; nothing depends on it.
>
> Verified at cutover — CCO → destination `…7495`, CallXfer → `…3232`, both accepted by Google,
> zero failures.

---

# Original runbook

Goal: retire the Google Sheet path. The API (`upload-google-offline-conversions`, cron jobid 8,
already live every 15 min) becomes the **sole** upload path, sending CCO to the **real
CallConvertOffline** action instead of the test action.

Branch: `gads-cco-datamanager-api-cutover`.
Orphan/cleanup list: [`ORPHANS-sheet-pipeline.md`](ORPHANS-sheet-pipeline.md).

## Current state (before cutover)

| Google Ads action | Fed by | Source event |
|---|---|---|
| `CallXfer` | Data Manager API | Call Transfer |
| `CallConvertOffline` | **Sheet** (`sync-google-sheet-15min`, jobid 3) + Ads scheduled import | Call Monetized |
| `Test_DataMgrAPIUpload` | Data Manager API (`..._CALLMONETIZE` points here) | Call Monetized |

Both paths read the SAME `v_offline_conversion_export` and send the SAME Order IDs. Confirmed:
the two Call-Monetized actions track identical conversion counts and revenue.

## Why the order is safe

Both paths send the same **Order ID** per conversion, and Google de-dupes by Order ID *within an
action*. So while the API and the Sheet both feed the real CCO action, Google collapses them —
**no double-count**. That is what makes the overlap window in step 2 free.

The reverse order is NOT safe: killing the Sheet before the API is confirmed on the real action
leaves a gap in CCO conversions.

---

## Steps

### 1. ME — deploy the branch (no behavior change on its own)
- `upload-google-offline-conversions` — adds the optional `..._TEST_OVERRIDE` escape hatch.
  **Unset = byte-for-byte identical routing.** Also picks up `api_type: 'cv-upload'` on its
  `api_logs` rows (column already exists), which live v40 was missing.
- `pipeline-health-check` — stops watching the Sheet path (it would false-alarm hourly once the
  Sheet stops syncing) and adds a config audit that alerts on silent dry-run fallback, a missing
  destination id, broken OAuth, or a left-on TEST_OVERRIDE.
- Migration `20260903140000_offline_cv_upload_daily_view.sql` — adds `v_offline_cv_upload_daily`
  for verification. Read-only, additive.

### 2. YOU (Supabase env) — point the API at the real CCO action
Supabase → Edge Functions → Secrets:
- Set **`GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE`** to the **real CallConvertOffline**
  Data Manager destination id. (Leave `..._CALLXFER` alone.)
- Confirm **`GOOGLE_UPLOAD_ENABLED=true`** and **`GOOGLE_UPLOAD_PROVIDER=data_manager`** — otherwise
  the uploader silently dry-runs and nothing reaches Google. (The new health check now alerts on this.)
- Leave `..._TEST_OVERRIDE` **unset**.

**Overlap window starts here.** Both the API and the Sheet now feed the real CCO action; Google
de-dupes by Order ID. Nothing is double-counted and nothing is at risk.

### 3. ME — verify one cycle (~15–30 min)
```sql
select * from v_offline_cv_upload_daily
 where conversion_day_et >= current_date - 3
 order by conversion_day_et desc, conversion_action;
```
Expect: `uploaded` climbing for **CallConvertOffline**, `pending` near 0, `failed` = 0.
Plus a no-write probe against Google: `upload-google-offline-conversions?validate_only=true`.

**Do not proceed to step 4 until CallConvertOffline shows uploads via the API.**

### 4. YOU (Google Ads UI) — stop the Sheet feeding Google Ads
Turn OFF the scheduled offline-conversion **Sheet import** for the `CallConvertOffline` action.
Optionally pause `Test_DataMgrAPIUpload` (keep it — see ORPHANS §4).

### 5. ME — stop appending to the Sheet
```sql
select cron.unschedule('sync-google-sheet-15min');
```
That's the last step.

### 6. ME — watch a day
Re-run the step-3 query. API `uploaded` counts for CallConvertOffline should match what the Sheet
used to deliver. `also_on_sheet` freezes from here — expected.

---

## Rollback

Reversible at every step, in reverse order.

**Undo step 5** — re-schedule the Sheet cron exactly as it was (jobid 3):
```sql
select cron.schedule(
  'sync-google-sheet-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/sync-google-sheet',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'uploader_invoke_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
```
**Undo step 4** — re-enable the Google Ads scheduled Sheet import.

**Undo step 2** — set `GOOGLE_DATA_MANAGER_DESTINATION_ID_TEST_OVERRIDE` to the
`Test_DataMgrAPIUpload` destination id. That re-routes monetized calls back to the test action in
one secret change, with no code edit and no need to remember the old value of `..._CALLMONETIZE`.

**Undo step 1** — redeploy the previous function versions from `origin/main`. Note the Sheet
monitoring removed from `pipeline-health-check` is only correct while the Sheet is retired; if you
roll back to the Sheet path, restore it (the file header says how).

## Notes

- `archive-old-sheet-rows-daily` (jobid 4) stays scheduled — it only trims the Sheet, harmless, and
  keeps the rollback path warm.
- 153 historical rows are permanently stranded past the 90-day window and will show under
  `stranded_past_90d_window`. Not caused by this cutover — see ORPHANS §5.
- After the flip is stable, the contract migration (`20260828120600`) can drop `ringba_call_id` +
  the sync trigger + the unused `google_ads_customer_id` / `google_ads_conversion_action_id` columns.
