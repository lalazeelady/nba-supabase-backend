-- Schedule sync-google-sheet every 15 minutes so NBA-publisher revenue events
-- flow into the Google Sheet (and from there into Google Ads scheduled upload)
-- without manual curl invocations.
--
-- The cron pulls UPLOADER_INVOKE_SECRET from Vault at exec time so we never
-- have to update the schedule when the secret rotates.
--
-- Cadence: */15 * * * *
--   - Small enough that any same-day call is in the Sheet by the time Google
--     Ads' daily Schedule runs.
--   - Big enough to keep pg_net request volume / Edge Function invocations
--     trivial (~96/day).
--
-- Idempotency: the syncer's view already filters sheet_synced_at IS NULL,
-- and the syncer stamps sheet_synced_at on successful append. Running every
-- 15 min on an empty queue is a cheap no-op.

-- pg_cron + pg_net are already installed on this project.
-- Extensions are typically managed in the `extensions` schema.

-- Drop any prior version of this job before re-creating (idempotent migration).
do $$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'sync-google-sheet-15min';
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
end $$;

select cron.schedule(
  'sync-google-sheet-15min',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/sync-google-sheet',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'uploader_invoke_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
