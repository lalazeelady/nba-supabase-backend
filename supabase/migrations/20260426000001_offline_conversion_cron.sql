-- pg_cron schedule for the offline conversion uploader.
--
-- Runs every 15 minutes and POSTs to the upload-google-offline-conversions
-- edge function. The function itself respects the GOOGLE_UPLOAD_ENABLED
-- secret — when that secret is "false" (default during Phase 1A) the
-- function returns immediately without contacting Google, so it is safe
-- to leave this cron enabled while we are still inspecting Ringba payloads.
--
-- Two settings need to be set on the database for the cron call to
-- authenticate against the edge function:
--
--   alter database postgres set "app.settings.supabase_url"
--     to 'https://quhxbgsgtfvrasyjvaba.supabase.co';
--   alter database postgres set "app.settings.uploader_invoke_secret"
--     to '<value of UPLOADER_INVOKE_SECRET edge function secret>';
--
-- These are run once, manually, in the Supabase SQL editor — they hold
-- non-secret config and a shared secret used only by the cron→function
-- call. They are intentionally kept out of this migration so the secret
-- never lands in source control.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop any prior schedule so re-running this migration is idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'upload-google-offline-conversions') then
    perform cron.unschedule('upload-google-offline-conversions');
  end if;
end;
$$;

select cron.schedule(
  'upload-google-offline-conversions',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/upload-google-offline-conversions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', current_setting('app.settings.uploader_invoke_secret', true)
    ),
    body := '{}'::jsonb
  ) as request_id;
  $cron$
);
