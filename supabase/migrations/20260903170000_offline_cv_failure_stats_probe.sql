-- Failure-rate detection for pipeline-health-check.
--
-- The gap this closes: the stall check only sees rows WAITING to be delivered. A row
-- that Google REJECTS is marked status='failed' and leaves the ready set, so the backlog
-- drains to zero and the stall check goes quiet while every conversion is being lost.
-- The config audit doesn't catch it either -- it verifies the OAuth secrets are present,
-- not that the refresh token still works. A revoked grant (password change, re-auth,
-- inactivity on a test-mode OAuth client) fails every upload, retries 6x, marks them
-- failed, and reports all-green. This probe is what notices.
--
-- Also catches partial failures: a subset rejected (bad payload, policy, quota) while the
-- rest succeed, which never trips a stall because uploads are still happening.
--
-- Indexed first: the equivalent unindexed scan measured 8.9s against 93k rows, which is
-- the same statement-timeout failure that silently killed the health check itself.
create index if not exists offline_conversion_events_last_attempt_idx
  on public.offline_conversion_events (last_upload_attempt_at desc)
  where last_upload_attempt_at is not null;

create or replace function public.offline_cv_failure_stats(window_hours int default 3)
returns table (
  failed_count bigint,
  uploaded_count bigint,
  top_error text,
  top_error_count bigint
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '15s'
as $$
  with recent as (
    select oce.status, oce.google_upload_error
      from public.offline_conversion_events oce
     where oce.publisher = 'NBA'
       and oce.last_upload_attempt_at >= now() - make_interval(hours => window_hours)
  ),
  counts as (
    select
      count(*) filter (where status = 'failed')   as failed_count,
      count(*) filter (where status = 'uploaded') as uploaded_count
    from recent
  ),
  top as (
    -- Data Manager nests its message under body.error.message; the uploader's own
    -- permanent/retryable outcomes use a flat message. Fall back to raw jsonb.
    select
      coalesce(
        nullif(google_upload_error #>> '{body,error,message}', ''),
        nullif(google_upload_error ->> 'message', ''),
        nullif(google_upload_error #>> '{body,error,status}', ''),
        left(google_upload_error::text, 300)
      ) as msg,
      count(*) as n
    from recent
    where status = 'failed' and google_upload_error is not null
    group by 1
    order by n desc
    limit 1
  )
  select c.failed_count, c.uploaded_count, t.msg, t.n
    from counts c left join top t on true;
$$;

comment on function public.offline_cv_failure_stats(int) is
  'Delivery failures vs successes in a recent window, with the most common error message. '
  'Used by pipeline-health-check to catch Google REJECTING uploads (which the stall check '
  'cannot see, because failed rows leave the backlog).';

revoke all on function public.offline_cv_failure_stats(int) from public;
grant execute on function public.offline_cv_failure_stats(int) to service_role;
