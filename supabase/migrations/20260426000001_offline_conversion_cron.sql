-- pg_cron schedule for the offline conversion uploader.
--
-- Runs every 15 minutes and POSTs to the upload-google-offline-conversions
-- edge function. The function itself respects the GOOGLE_UPLOAD_ENABLED
-- secret — when that secret is "false" (default during Phase 1A) the
-- function returns immediately without contacting Google, so it is safe
-- to leave this cron enabled while we are still inspecting Ringba payloads.
--
-- Authentication: the cron call must send the same value the edge function
-- has in its UPLOADER_INVOKE_SECRET secret. Because Supabase managed
-- projects do not allow `alter database ... set` from the SQL Editor, the
-- secret is stored in Supabase Vault and read at cron-fire time. Run this
-- once in the SQL Editor before the cron will authenticate successfully:
--
--   select vault.create_secret(
--     '<value of UPLOADER_INVOKE_SECRET edge function secret>',
--     'uploader_invoke_secret'
--   );
--
-- The Vault row holds the secret encrypted at rest. It is intentionally
-- kept out of this migration so the secret never lands in source control.
-- The supabase URL is hardcoded below — it is not secret.

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
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-google-offline-conversions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'uploader_invoke_secret')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $cron$
);
