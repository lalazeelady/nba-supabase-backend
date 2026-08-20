-- Drain the API backlog faster (2026-08-20 incident recovery).
--
-- The Data Manager API path (upload-google-offline-conversions) was down Aug 17-20
-- and accumulated ~6.8k unsent conversions. Its cron ran at the function's default
-- 50 rows/run (≈200/hr ≈ 34h to drain). Bump to 250 rows/run (≈1,000/hr ≈ 4-5h)
-- with a 150s response timeout to cover the longer run (11s read + ~250 sequential
-- Google uploads, still inside the edge-function wall-clock).
--
-- cron.schedule upserts by jobname, so this replaces the existing job's command.
-- Once the backlog is caught up you can drop back to the default by re-scheduling
-- without the ?limit=250 (steady-state volume is well under 250/15min).

select cron.schedule(
  'upload-google-offline-conversions',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-google-offline-conversions?limit=250',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name='uploader_invoke_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
