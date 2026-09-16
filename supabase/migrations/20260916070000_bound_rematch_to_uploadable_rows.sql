-- P2.1: bound the attribution re-match to rows the uploader can still send.
--
-- APPLY ONLY IN THE QUIET WINDOW (3-8am ET). `create or replace function` is DDL and makes
-- PostgREST reload its schema cache (ACTION-PLAN.md operational rule 2).
--
-- Why: rematch_offline_conversion_events() re-checked EVERY unmatched NBA conversion since
-- April (34,252 rows) and joined EVERY matched conversion to leads (77,506 rows), every
-- 10 minutes. On 2026-09-14 most runs hit the 2-minute timeout; it was the main disk load
-- behind the 4:40-9:02pm ET outage (docs/pipeline-incident-2026-09-14/README.md).
--
-- Change: both steps now touch only rows with
--   uploaded_at is null
--   status in ('monetize_ready', 'ready_to_upload', 'transfer_ready')   -- uploader ELIGIBLE_STATUSES
--   conversion_time > now() - interval '85 days'                          -- uploader AGE_DAYS
-- which is exactly the partial index offline_conversion_events_api_unsent_idx.
-- Measured 2026-09-15 (EXPLAIN ANALYZE, Small compute): step 1 = 89 ms, step 2 = 73 ms.
--
-- Unchanged for those rows: the same match rule (exact last-10 phone, newest lead wins), the
-- same columns filled, attribution columns ONLY (never status / uploaded_at / google_*), so
-- it still cannot cause a re-upload. Idempotent.
--
-- Trade-off (accepted by the owner in P2.1): rows already uploaded, or older than 85 days, no
-- longer get late attribution backfill. Nothing can send them to Google anyway. The statuses
-- 'matched' / 'unmatched' / 'transfer_unmatched' are pre-2026-08-28 stranded rows (P7.7); the
-- function never changed status, so it never made them uploadable.
--
-- Interim state before this migration: on 2026-09-15 8:27am ET the same bounded SQL was put
-- directly in cron job 'rematch-offline-conversions' (a row update, no DDL). The last
-- statement below points the job back at the function.
--
-- Rollback: re-apply 20260714030000_rematch_offline_conversion_events_fn.sql (unbounded
-- version). Do not re-enable the unbounded version on the 10-minute schedule.

create or replace function public.rematch_offline_conversion_events()
returns table(linked_by_phone integer, backfilled_from_lead integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_linked  integer := 0;
  v_filled  integer := 0;
begin
  -- 1. Link unmatched, still-uploadable NBA events to a lead by exact 10-digit phone.
  --    Newest lead for that phone wins (mirrors the webhook's ordering).
  with cand as (
    select oce.id,
           right(regexp_replace(coalesce(oce.caller_id, ''), '\D', '', 'g'), 10) as caller10
    from offline_conversion_events oce
    where oce.lead_id is null
      and oce.publisher = 'NBA'
      and oce.uploaded_at is null
      and oce.status in ('monetize_ready', 'ready_to_upload', 'transfer_ready')
      and oce.conversion_time > now() - interval '85 days'
  ),
  matched as (
    select c.id as event_id, l.*
    from cand c
    join lateral (
      select ld.*
      from leads ld
      where length(c.caller10) = 10
        and right(regexp_replace(coalesce(ld.phone, ''), '\D', '', 'g'), 10) = c.caller10
      order by ld.created_at desc
      limit 1
    ) l on true
  )
  update offline_conversion_events e
  set lead_id        = m.id,
      transaction_id = coalesce(nullif(btrim(e.transaction_id), ''), m.transaction_id),
      gclid          = coalesce(nullif(btrim(e.gclid), ''),  m.gclid),
      gbraid         = coalesce(nullif(btrim(e.gbraid), ''), m.gbraid),
      wbraid         = coalesce(nullif(btrim(e.wbraid), ''), m.wbraid),
      utm_source     = coalesce(e.utm_source,   m.utm_source),
      utm_medium     = coalesce(e.utm_medium,   m.utm_medium),
      utm_campaign   = coalesce(e.utm_campaign, m.utm_campaign),
      utm_content    = coalesce(e.utm_content,  m.utm_content),
      utm_term       = coalesce(e.utm_term,     m.utm_term),
      updated_at     = now()
  from matched m
  where e.id = m.event_id;
  get diagnostics v_linked = row_count;

  -- 2. Backfill attribution from the linked lead, still-uploadable rows only.
  update offline_conversion_events e
  set transaction_id = coalesce(nullif(btrim(e.transaction_id), ''), l.transaction_id),
      gclid          = coalesce(nullif(btrim(e.gclid), ''),  l.gclid),
      gbraid         = coalesce(nullif(btrim(e.gbraid), ''), l.gbraid),
      wbraid         = coalesce(nullif(btrim(e.wbraid), ''), l.wbraid),
      utm_source     = coalesce(e.utm_source,   l.utm_source),
      utm_medium     = coalesce(e.utm_medium,   l.utm_medium),
      utm_campaign   = coalesce(e.utm_campaign, l.utm_campaign),
      utm_content    = coalesce(e.utm_content,  l.utm_content),
      utm_term       = coalesce(e.utm_term,     l.utm_term),
      updated_at     = now()
  from leads l
  where e.lead_id = l.id
    and e.uploaded_at is null
    and e.status in ('monetize_ready', 'ready_to_upload', 'transfer_ready')
    and e.conversion_time > now() - interval '85 days'
    and (
      nullif(btrim(e.transaction_id), '') is null
      or (nullif(btrim(e.gclid), '') is null and nullif(btrim(l.gclid), '') is not null)
      or (e.utm_source is null and l.utm_source is not null)
    );
  get diagnostics v_filled = row_count;

  return query select v_linked, v_filled;
end;
$function$;

-- Point the cron job back at the function (row update; replaces the interim inline SQL).
select cron.alter_job(
  (select jobid from cron.job where jobname = 'rematch-offline-conversions'),
  command := 'select public.rematch_offline_conversion_events();'
);
