# Sheet → Data Manager API cutover — READY (execute when you say go)

Goal: retire the Google Sheet path; the API (`upload-google-offline-conversions`, cron jobid 8,
already live every 15 min) becomes the SOLE upload path, sending **CCO to the REAL
CallConvertOffline action** instead of the test action.

## Current state
- **Real CallConvertOffline action** is fed by: the **Sheet** (`sync-google-sheet-15min`, jobid 3).
- **Test action** is fed by: the **API** (destination env currently points at the test destination).
- Both paths read the SAME `v_offline_conversion_export` and send the SAME Order IDs.

## Why the order is safe
Both paths send the same **Order ID** per conversion, and Google de-dupes by Order ID *within an
action*. So if the API and the Sheet briefly both feed the real CCO action, Google collapses them —
**no double-count**. That makes the sequence below low-risk.

## Steps

### 1. YOU (Google Ads + Supabase env) — point the API at the real CCO action
- Set edge-function secret **`GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE`** to the **real
  CallConvertOffline** Data Manager destination id (Supabase → Edge Functions → Secrets).
  (CallXfer already uses `GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER` — leave it.)
- Confirm `GOOGLE_UPLOAD_ENABLED=true` and `GOOGLE_UPLOAD_PROVIDER=data_manager` are set (so the API
  actually sends, not dry-run).
- Watch one 15-min cycle: real CCO action should start receiving from the API (dedup-safe with the Sheet).

### 2. YOU (Google Ads UI) — stop the Sheet feeding Google Ads
- Turn OFF the scheduled offline-conversion **Sheet import** for the CallConvertOffline action.

### 3. ME — one command: stop appending to the Sheet
```sql
select cron.unschedule('sync-google-sheet-15min');
```
That's the whole thing on my side. Say "disable the sheet" and I run it.

## Rollback (if needed)
Re-enable the Sheet cron exactly as it was (jobid 3):
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
…and (your side) re-point the API destination env back / re-enable the Google Ads Sheet import.

## Notes / after
- `archive-old-sheet-rows-daily` (jobid 4) can stay or be disabled later — it only trims the Sheet, harmless.
- Reconcile on the first clean post-Caliber-cutover weekday BEFORE flipping (internet CCO should = internet XFER).
- After the flip is stable, the contract migration (`20260828120600`) can drop `ringba_call_id` +
  the sync trigger + the unused `google_ads_customer_id`/`action_id` columns.
