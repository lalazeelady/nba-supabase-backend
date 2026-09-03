-- v_offline_cv_upload_daily
--
-- Post-cutover verification: per conversion day (Eastern) and per Google Ads
-- conversion action, how many offline-conversion events were actually DELIVERED to
-- Google by the Data Manager API. Use it after the Sheet -> API cutover to confirm
-- CallConvertOffline volume via the API matches what the Sheet used to deliver.
--
-- Joined to v_offline_conversion_export so the denominator is only ELIGIBLE events
-- (publisher NBA, Google/YouTube-sourced, has a click id or matchable PII). Rows the
-- export view intentionally excludes -- e.g. non-Google traffic -- would otherwise sit
-- in `pending` forever and make a healthy pipeline look backed up.
--
-- Column notes:
--   pending                   still awaiting upload; should trend to 0 within ~15 min
--   stranded_past_90d_window  pending AND already older than the uploader's 85-day
--                             cutoff -> can NEVER be delivered (Google rejects >90d).
--                             A non-zero value here is historical residue, not a fault.
--   also_on_sheet             rows the retired Sheet path had synced. Frozen after the
--                             cutover; useful for comparing the overlap window.
--
-- Aggregate only -- no PII columns -- but revenue-bearing, so it is NOT granted to anon.

create or replace view public.v_offline_cv_upload_daily as
select
  ((oce.conversion_time at time zone 'America/New_York')::date)          as conversion_day_et,
  oce.google_ads_conversion_action_name                                  as conversion_action,
  count(*)                                                               as eligible_events,
  count(*) filter (where oce.status = 'uploaded')                        as uploaded,
  count(*) filter (where oce.status = 'failed')                          as failed,
  count(*) filter (where oce.status in ('monetize_ready', 'ready_to_upload', 'transfer_ready'))
                                                                         as pending,
  count(*) filter (where oce.status in ('monetize_ready', 'ready_to_upload', 'transfer_ready')
                     and oce.conversion_time < now() - interval '85 days')
                                                                         as stranded_past_90d_window,
  round(coalesce(sum(oce.conversion_value) filter (where oce.status = 'uploaded'), 0), 2)
                                                                         as uploaded_value,
  count(*) filter (where oce.sheet_synced_at is not null)                as also_on_sheet,
  max(oce.uploaded_at)                                                   as last_upload_at
from public.offline_conversion_events oce
join public.v_offline_conversion_export ex on ex.event_id = oce.id
group by 1, 2;

comment on view public.v_offline_cv_upload_daily is
  'Daily (ET) Data Manager API delivery counts per Google Ads conversion action, over eligible '
  'events only (v_offline_conversion_export). Post Sheet->API cutover verification.';

revoke all on public.v_offline_cv_upload_daily from public;
grant select on public.v_offline_cv_upload_daily to authenticated, service_role;
