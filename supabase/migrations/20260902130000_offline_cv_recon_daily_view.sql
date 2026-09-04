-- Offline-conversion reconciliation view (READ-ONLY reporting; no pipeline impact).
-- NOT APPLIED. Apply only on explicit go.
--
-- Reproduces the business's daily offline-conversion table straight from
-- offline_conversion_events, on both bases (UTM_Source and gclid, raw + deduped),
-- and adds the column the business table does not have: what we actually upload to
-- Google Ads. Grouping day is America/New_York, matching the pipeline's dedupe keys.
--
-- Verified exact against the business report for ET day 2026-09-01 (Ringba transfers:
-- gclid_raw 541, gclid_dedup 454).

create or replace view public.v_offline_cv_recon_daily as
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
  case when source = 'ringba' then 'Ringba' else 'Internet' end                  as channel,
  case when event_type = 'call_transferred' then 'Xfer' else 'Monetized' end     as metric,
  count(*) filter (where utm_source ilike 'google')                              as utm_source_basis,
  count(*) filter (where utm_source ilike 'google'
                     and coalesce(gclid, '') <> '')                              as gclid_raw,
  count(distinct nullif(gclid, '')) filter (where utm_source ilike 'google')      as gclid_dedup,
  count(*)                                                                       as gross_all_sources,
  count(*) filter (where upload_eligible)                                        as uploaded_to_google,
  round(coalesce(sum(conversion_value), 0), 2)                                   as revenue
from base
group by 1, 2, 3;

comment on view public.v_offline_cv_recon_daily is
  'Daily offline-conversion reconciliation against the business report. ET days. '
  'utm_source_basis / gclid_raw / gclid_dedup mirror the business table columns; '
  'uploaded_to_google is what v_offline_conversion_export actually ships to Google Ads. '
  'Read-only reporting - see docs/offline-cv-reconciliation/README.md.';

grant select on public.v_offline_cv_recon_daily to service_role;
