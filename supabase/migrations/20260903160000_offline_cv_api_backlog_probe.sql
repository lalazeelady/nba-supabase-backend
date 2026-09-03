-- Eligibility-aware backlog probe for pipeline-health-check.
--
-- The old check counted the BASE TABLE (publisher NBA + ready status + uploaded_at null).
-- That over-counts badly: the uploader reads v_offline_conversion_export, which also
-- requires Google/YouTube-sourced traffic and a matchable identifier. Rows failing those
-- predicates are pending FOREVER by design. Live numbers at cutover: base-table count
-- 2902, actually-eligible count 0 -- i.e. the check was one cron tick away from emailing
-- a false "STALLED" alert every hour.
--
-- Reading the view was originally avoided so a view-timeout couldn't take the watchdog
-- down. That safety property is preserved differently here: this function carries its own
-- short statement_timeout, and the caller treats an error as "backlog unknown" (which
-- raises its own alert) rather than letting it 500 the whole check.
create or replace function public.offline_cv_api_backlog(
  grace_minutes int default 90,
  age_days int default 85,
  max_attempts int default 6
) returns bigint
language sql
stable
security definer
set search_path = public
set statement_timeout = '15s'
as $$
  select count(*)::bigint
    from public.v_offline_conversion_export
   where status in ('monetize_ready', 'ready_to_upload', 'transfer_ready')
     and conversion_time_ts >= now() - make_interval(days => age_days)
     and coalesce(upload_attempts, 0) < max_attempts
     and event_created_at < now() - make_interval(mins => grace_minutes);
$$;

comment on function public.offline_cv_api_backlog(int, int, int) is
  'Count of offline-conversion events the Data Manager uploader SHOULD have delivered by now '
  '(export-view eligibility applied). Used by pipeline-health-check.';

revoke all on function public.offline_cv_api_backlog(int, int, int) from public;
grant execute on function public.offline_cv_api_backlog(int, int, int) to service_role;
