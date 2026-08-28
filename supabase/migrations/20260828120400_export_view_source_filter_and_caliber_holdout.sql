-- Offline-CV accuracy, step 4: export view — SOURCE FILTER + CALIBER HOLD-OUT.
--
-- v_offline_conversion_export is the single record BOTH upload paths read (Sheet via
-- v_google_sheet_export_unsynced, API directly), so adding the filter here enforces it
-- everywhere in one place. Rebuilt from 20260821000200 (order_id read from the column);
-- every existing output column is byte-identical — this migration only ADDS two WHERE
-- predicates and appends two observability columns (source, ib_source_effective).
--
-- 1) SOURCE FILTER (owner's locked rule): upload to Google only when the call is Google or
--    unknown. Definitively-other sources (Meta / Bing / MediaExpansion / non-google
--    re-engagement) are STORED but not uploaded. Measured on 3 days of live data: ~20% of
--    NBA rows are definitively-other and stop uploading; google + unknown keep flowing.
--      upload iff  utm_source ILIKE 'google'
--               OR ib_source ~* '(google|youtube)'
--               OR ib_source IN ('NBA_ThankYou','NBA_Funnel','NBA_InactivityPopup')  -- legacy google-era names
--               OR (utm_source blank AND ib_source blank)                            -- unknown → still upload
--    utm_source / ib_source read from the columns, falling back to raw_payload for rows
--    ingested before those columns existed.
--
-- 2) CALIBER HOLD-OUT: source='caliber' rows are ingested and visible but NOT uploaded until
--    cutover. Flip is a one-line edit here (remove the `and oce.source <> 'caliber'` line) plus
--    turning CallTools off — see docs/offline-cv-accuracy/SWITCHOVER.md.

create or replace view public.v_offline_conversion_export as
select
  oce.id as event_id,
  oce.gclid as google_click_id,
  oce.gbraid,
  oce.wbraid,
  coalesce(oce.google_ads_conversion_action_name, 'CallConvertOffline') as conversion_name,
  to_char(oce.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  oce.conversion_value,
  coalesce(nullif(oce.currency_code, ''), 'USD') as conversion_currency,
  coalesce(nullif(oce.order_id, ''), oce.id::text) as order_id,
  coalesce(nullif(oce.raw_payload->>'ip_address', ''), nullif(l.ip_address::text, '')) as ip_address,
  coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) as email,
  case
    when oce.caller_id ~ '^\+' then oce.caller_id
    when oce.caller_id ~ '^1[0-9]{10}$' then '+' || oce.caller_id
    when oce.caller_id ~ '^[0-9]{10}$' then '+1' || oce.caller_id
    when l.phone ~ '^\+' then l.phone
    when l.phone ~ '^1[0-9]{10}$' then '+' || l.phone
    when l.phone ~ '^[0-9]{10}$' then '+1' || l.phone
    else nullif(coalesce(oce.caller_id, l.phone), '')
  end as phone,
  coalesce(nullif(oce.caller_first_name, ''), nullif(l.first_name, '')) as first_name,
  coalesce(nullif(oce.caller_last_name, ''), nullif(l.last_name, '')) as last_name,
  null::text as session_attributes,
  null::text as user_agent,
  oce.publisher,
  oce.status,
  oce.sheet_synced_at,
  oce.created_at as event_created_at,
  oce.event_type,
  oce.conversion_time as conversion_time_ts,
  oce.upload_attempts,
  oce.google_ads_customer_id,
  coalesce(nullif(oce.caller_zip, ''), nullif(l.zip, '')) as zip,
  -- ---- appended observability columns (Sheet sub-view ignores these) ----
  oce.source,
  coalesce(nullif(oce.ib_source, ''), nullif(oce.raw_payload->>'ib_source', '')) as ib_source_effective
from public.offline_conversion_events oce
left join public.leads l on l.id = oce.lead_id
where oce.publisher = 'NBA'
  and (oce.event_type = 'call_transferred' or oce.conversion_value > 0)
  -- at least one matchable identifier
  and (
    nullif(oce.gclid, '') is not null
    or nullif(oce.gbraid, '') is not null
    or nullif(oce.wbraid, '') is not null
    or coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) is not null
    or coalesce(nullif(oce.caller_id, ''), nullif(l.phone, '')) is not null
  )
  -- CALIBER HOLD-OUT (remove these two lines at cutover): catch caliber by the source stamp
  -- (new webhook) AND by the raw_payload `status` signature (legacy rows stamped source='ringba').
  and oce.source <> 'caliber'
  and not (oce.raw_payload ? 'status')
  -- SOURCE FILTER (google or unknown only):
  and (
    coalesce(nullif(oce.utm_source, ''), nullif(oce.raw_payload->>'utm_source', '')) ilike 'google'
    or coalesce(nullif(oce.ib_source, ''), nullif(oce.raw_payload->>'ib_source', '')) ~* '(google|youtube)'
    or coalesce(nullif(oce.ib_source, ''), nullif(oce.raw_payload->>'ib_source', ''))
         in ('NBA_ThankYou','NBA_Funnel','NBA_InactivityPopup')
    or (
      coalesce(nullif(oce.utm_source, ''), nullif(oce.raw_payload->>'utm_source', '')) is null
      and coalesce(nullif(oce.ib_source, ''), nullif(oce.raw_payload->>'ib_source', '')) is null
    )
  );

comment on view public.v_offline_conversion_export is
  'Canonical offline-conversion upload record (Sheet + API read this). 2026-08-28: adds the '
  'google-or-unknown SOURCE FILTER and the source=caliber HOLD-OUT. Definitively-other sources '
  'and caliber rows are stored but not uploaded. order_id still read from the column.';

grant select on public.v_offline_conversion_export to authenticated, service_role;

-- v_google_sheet_export_unsynced selects a fixed subset of the columns above (all unchanged),
-- so it does not need recreating; it inherits both new filters automatically.
