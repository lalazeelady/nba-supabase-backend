-- Stall alert for the offline-conversion delivery paths.
--
-- Context: the Aug-2026 outage ran silently for 3+ days because the delivery
-- crons report "succeeded" (net.http_post only dispatches; it can't see the
-- function's internal 500). This hourly check reads the base table directly and
-- emails larazielin1@gmail.com (via Resend, inside the function) when a path has a
-- real backlog AND no recent success. Apply AFTER deploying the
-- pipeline-health-check edge function.
--
-- Rollback: select cron.unschedule('pipeline-health-check-hourly');

select cron.schedule(
  'pipeline-health-check-hourly',
  '20 * * * *',   -- hourly at :20, staggered off the :00/:15/:30/:45 delivery crons
  $$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/pipeline-health-check',
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
  $$
);
