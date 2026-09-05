-- Offline-conversion reconciliation: daily summary in the business report's layout.
-- Read-only. Run in the Supabase SQL editor (or via MCP execute_sql). No DDL, no writes.
--
-- Columns map to the business table as follows:
--   utm_xfers / utm_cco        -> "based on UTM_Source"
--   gclid_raw_*                -> "based on gclid", NOT deduped
--   gclid_dedup_*              -> "based on gclid", deduped by click id
--   uploaded_to_google_*       -> what our pipeline actually ships to Google Ads (NOT in the
--                                 business table; this is the number Google Ads should reflect)
--
-- Basis definition (verified exact against the business table for 2026-09-01):
--   utm_source ILIKE 'google'  AND  gclid <> ''      -> raw
--   COUNT(DISTINCT gclid) within that set            -> deduped
--
-- Day = America/New_York calendar day of conversion_time.
-- Run against SETTLED days only (>= 1 full day old); late pixel fires still land on prior days.

-- EDIT THE TWO DATES on the `where et_day between ...` line at the bottom.

with base as (
  select
    o.id,
    o.source,
    o.event_type,
    o.utm_source,
    o.gclid,
    o.conversion_value,
    (o.conversion_time at time zone 'America/New_York')::date as et_day,
    (x.event_id is not null)                                  as upload_eligible
  from public.offline_conversion_events o
  left join public.v_offline_conversion_export x on x.event_id = o.id
  where o.publisher = 'NBA'
    and o.status not in ('ignored')
)
select
  et_day,
  case when source = 'ringba' then 'Ringba' else 'Internet' end                as channel,
  case when event_type = 'call_transferred' then 'Xfer' else 'Monetized/CCO' end as metric,
  count(*) filter (where utm_source ilike 'google')                            as utm_source_basis,
  count(*) filter (where utm_source ilike 'google'
                     and coalesce(gclid,'') <> '')                             as gclid_raw,
  count(distinct nullif(gclid,'')) filter (where utm_source ilike 'google')     as gclid_dedup,
  count(*)                                                                     as gross_all_sources,
  count(*) filter (where upload_eligible)                                      as uploaded_to_google,
  round(coalesce(sum(conversion_value),0), 2)                                  as revenue
from base
where et_day between '2026-08-26'::date and '2026-09-01'::date
group by 1,2,3
order by et_day desc, channel, metric;
