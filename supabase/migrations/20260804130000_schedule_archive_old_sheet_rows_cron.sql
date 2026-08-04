-- Schedule archive-old-sheet-rows once daily.
--
-- Moves live-Sheet rows older than 85 days to the "LiveImport - OLD" archive
-- tab (keeping the live Sheet inside Google Ads' 90-day window), purges the
-- archive past ~175 days, and physically deletes rows (shrinking the grid) so
-- whitespace doesn't accumulate toward Sheets' cell cap.
--
-- Cadence: 09:07 UTC daily. Once/day is plenty (rows age one day at a time),
-- and :07 is deliberately off the sync-google-sheet :00/:15/:30/:45 slots.
-- (Archive deletes the OLDEST rows / top; sync APPENDS to the bottom, so they
-- don't collide even if they overlap.)
--
-- Pulls UPLOADER_INVOKE_SECRET from Vault at exec time, same as the sync cron.

do $$
declare
  jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'archive-old-sheet-rows-daily';
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
end $$;

select cron.schedule(
  'archive-old-sheet-rows-daily',
  '7 9 * * *',
  $cron$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/archive-old-sheet-rows',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'uploader_invoke_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
