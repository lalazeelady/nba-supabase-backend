-- Schedule the Customer Match pipeline — TWO jobs, deliberately.
--
-- SEPARATE FILE from 20260911170000 on purpose: the schema is harmless to apply,
-- but scheduling is what starts calling Google.
--
-- ============================================================================
-- WHY TWO JOBS AND NOT ONE  (learned in production, 2026-09-11)
-- ============================================================================
-- The first design was ONE job: the edge function called
-- refresh_customer_match_members() through PostgREST, then uploaded. The rollup ran
-- past PostgREST's ~60s gateway timeout ("upstream request timeout"). Each timeout
-- stranded an `idle in transaction (aborted)` backend and held a PostgREST pool
-- connection — and that pool is SHARED with submit-lead and the Ringba/Caliber
-- webhooks. Between 20:50 UTC Fri 2026-09-11 and 02:55 UTC Sat, 120 lead inserts
-- and 56 conversion postbacks failed. Applying this migration during that window
-- also forced a PostgREST schema-cache reload that could not finish on this
-- undersized instance (PGRST002), which extended the outage.
--
-- The rule this encodes: heavy DATABASE work runs as SQL in pg_cron, where no HTTP
-- gateway can interrupt it and no PostgREST connection is held. The edge function
-- does only the part that must be HTTP — talking to Google — and is invoked with
-- skip_refresh=true so it never reaches back through PostgREST to do database work.
--
-- PRODUCTION STATE (2026-09-14): the rollup job is scheduled but DEACTIVATED until
-- the Supabase compute size is upgraded. A full rollup on the current instance
-- (1.35 GB of data, ~384 MB effective cache) has not been proven safe alongside
-- live traffic. The upload job is active. Enable the rollup later with:
--   select cron.alter_job((select jobid from cron.job
--                          where jobname = 'customer-match-refresh-daily'), active := true);
-- ============================================================================

-- Job 1 — the rollup. Pure SQL, no HTTP, no gateway timeout, no PostgREST pool use.
-- 09:30 UTC (05:30 ET). refresh_customer_match_members() carries its own 300s
-- statement_timeout. REFRESH MATERIALIZED VIEW CONCURRENTLY does not block readers
-- or writers.
select cron.schedule(
  'customer-match-refresh-daily',
  '30 9 * * *',
  $$ select public.refresh_customer_match_members(); $$
);

-- Job 2 — the upload. Five minutes later, so a rollup (when enabled) has finished and
-- any newly monetized caller is already queued.
--
-- skip_refresh=true is REQUIRED, not an optimization: it is what keeps the edge
-- function from calling back through PostgREST. Do not remove it.
--
-- limit=10000 is an operational ceiling: 25,000 members in one invocation returns
-- WORKER_RESOURCE_LIMIT (the edge worker runs out of memory). Steady-state volume is
-- a few hundred a day; a larger backlog drains at 10,000 a night, and
-- cm_upload_backlog() alerts if it is still there after 48h.
select cron.schedule(
  'upload-google-customer-match-daily',
  '35 9 * * *',
  $$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-google-customer-match?skip_refresh=true&limit=10000',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'uploader_invoke_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 240000
  );
  $$
);

-- Both are clear of archive-old-sheet-rows-daily (09:07).
--
-- The uploader is idempotent. A run that dies half way leaves delivered batches
-- marked 'uploaded' and the rest 'pending', and the next run resumes. Re-sending a
-- member is harmless — Customer Match de-duplicates on the hashed identifier.
--
-- These are pg_cron ROW changes, not DDL, so enabling, disabling or retiming a job
-- does NOT trigger a PostgREST schema-cache reload. Creating them (this file) does.

-- ROLLBACK (no schema change, fully reversible):
--   select cron.unschedule('customer-match-refresh-daily');
--   select cron.unschedule('upload-google-customer-match-daily');
--
-- To stop uploads WITHOUT touching either schedule, set the Supabase secret
-- GOOGLE_CUSTOMER_MATCH_ENABLED=false. The function then dry-runs.
