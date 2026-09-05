-- Record-level export of INTERNET (Caliber) transfers for one ET day.
-- Purpose: diff this against the Caliber report download the business uses to derive
-- internet transfers, to prove whether the pixel-ingest set == the report-download set.
-- If they match, the variance is downstream (counting/basis), not ingest.
--
-- Export the result as CSV and feed it to tools/diff_internet_xfers.py.
-- EDIT the date on the last line.

select
  right(regexp_replace(coalesce(o.caller_id,''), '\D', '', 'g'), 10)   as phone10,
  (o.conversion_time at time zone 'America/New_York')::date            as et_day,
  to_char(o.conversion_time at time zone 'America/New_York',
          'YYYY-MM-DD HH24:MI:SS')                                     as et_time,
  o.conversion_call_id,
  o.gclid,
  o.gbraid,
  o.utm_source,
  o.utm_campaign,
  o.ib_source,
  o.call_status,
  o.queue,
  o.agent_name,
  o.status                                                             as pipeline_status,
  o.dedupe_key,
  o.order_id
from public.offline_conversion_events o
where o.publisher = 'NBA'
  and o.source = 'caliber'
  and o.event_type = 'call_transferred'
  and o.status not in ('ignored')
  and (o.conversion_time at time zone 'America/New_York')::date = '2026-09-01'
order by et_time;
