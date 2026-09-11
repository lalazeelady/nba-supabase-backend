-- Schedule the Customer Match uploader.
--
-- SEPARATE FILE from 20260911170000 on purpose: applying the schema is harmless and
-- reversible, but scheduling starts calling Google. Keeping them apart means you can
-- apply the schema, run the backfill by hand, confirm it, and only then turn the cron
-- on — and unschedule without touching any schema.
--
-- DAILY at 09:35 UTC (05:35 ET). Owner's choice. Deliberately clear of
-- archive-old-sheet-rows-daily (09:07) so two heavy jobs never overlap on an instance
-- where a seq scan already costs ~8s.
--
-- Cadence note: a person is added to the audience the morning after they monetize.
-- Google's own Customer Match processing takes hours regardless, so a faster cron
-- would not make an audience usable sooner.
--
-- The uploader is idempotent. A run that dies half way leaves delivered batches
-- marked 'uploaded' and the rest 'pending', and the next run resumes. Re-sending a
-- member to Google is harmless anyway — Customer Match de-duplicates on the hashed
-- identifier.
--
-- BACKFILL: do NOT rely on this cron for the initial ~63,700 people. Run it by hand
-- in bounded chunks first (see docs/customer-match/README.md, "First run"), because
-- one invocation attempting 13 batches can exceed the edge-function wall clock.
-- After the backfill, daily volume is a few hundred people — a single batch.

select cron.schedule(
  'upload-google-customer-match-daily',
  '35 9 * * *',
  $$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-google-customer-match',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'uploader_invoke_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $$
);

-- ROLLBACK (one statement, no schema change, fully reversible):
--   select cron.unschedule('upload-google-customer-match-daily');
--
-- To stop uploads WITHOUT touching the schedule, set the Supabase secret
-- GOOGLE_CUSTOMER_MATCH_ENABLED=false. The function then dry-runs: it logs what it
-- would send, marks nothing, and reaches Google not at all.
