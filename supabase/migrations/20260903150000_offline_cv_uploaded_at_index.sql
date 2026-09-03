-- pipeline-health-check's "last successful upload" probe does
--   select uploaded_at ... where uploaded_at is not null order by uploaded_at desc limit 1
-- With no index on uploaded_at that is a seq scan + sort over the whole table, which hit
-- the statement timeout and made the health check return 500 on EVERY run. pg_cron only
-- dispatches via net.http_post, so the job still logged "succeeded" -- the watchdog was
-- silently dead, which is the same failure class it exists to catch.
--
-- Partial + DESC so the probe is a single index lookup.
create index if not exists offline_conversion_events_uploaded_at_desc_idx
  on public.offline_conversion_events (uploaded_at desc)
  where uploaded_at is not null;
