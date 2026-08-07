-- Shared "single source of truth" for offline-conversion uploads.
--
-- Goal: the Google Sheet path AND the Data Manager API path must upload
-- IDENTICAL data (same Order ID, same click id, same coalesced email/phone/
-- name, same value/time). Previously the API re-derived fields from the raw
-- table with different precedence + used dedupe_key as the order id. Now both
-- read one base view, so the two are identical by construction.
--
-- v_offline_conversion_export = the canonical upload record for every eligible
-- event (publisher=NBA, >=1 identifier, and value>0 OR a $0 call_transferred).
-- It carries every column the Sheet emits PLUS API-only fields:
--   event_type, conversion_time_ts (raw, for RFC3339), upload_attempts,
--   google_ads_customer_id, zip (for the DM address identifier). It is NOT
--   filtered by sync state — each consumer applies its own:
--     - Sheet:  WHERE sheet_synced_at IS NULL      (stamps sheet_synced_at)
--     - API:    WHERE status IN (monetize_ready, transfer_ready) + age filter
--
-- v_google_sheet_export_unsynced becomes a thin filter on the base, emitting
-- the exact same 20 columns as before (verified byte-identical: 0-row diff
-- both directions against the prior definition on 2026-08-07).

create or replace view public.v_offline_conversion_export as
with events_with_phone as (
  select
    oce.id, oce.lead_id, oce.publisher, oce.status, oce.event_type,
    oce.upload_attempts, oce.google_ads_customer_id,
    oce.gclid, oce.gbraid, oce.wbraid, oce.ringba_call_id, oce.calltools_call_id,
    oce.caller_id, oce.caller_email, oce.caller_first_name, oce.caller_last_name,
    oce.caller_zip, oce.conversion_time, oce.conversion_value, oce.currency_code,
    oce.google_ads_conversion_action_name, oce.sheet_synced_at, oce.created_at, oce.raw_payload,
    l.email as lead_email, l.phone as lead_phone, l.first_name as lead_first_name,
    l.last_name as lead_last_name, l.zip as lead_zip, l.ip_address as lead_ip,
    case when length(regexp_replace(coalesce(nullif(oce.caller_id,''),nullif(l.phone,''),''),'\D','','g')) >= 10
      then right(regexp_replace(coalesce(nullif(oce.caller_id,''),nullif(l.phone,''),''),'\D','','g'), 10)
      else null end as phone_digits10,
    to_char(oce.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD') as et_date
  from public.offline_conversion_events oce
  left join public.leads l on l.id = oce.lead_id
),
ranked as (
  select e.*,
    row_number() over (partition by e.et_date, e.phone_digits10 order by e.created_at asc, e.id asc) as rn_date_phone
  from events_with_phone e
)
select
  -- ---- columns the Sheet emits (unchanged) ----
  r.id as event_id,
  r.gclid as google_click_id,
  r.gbraid,
  r.wbraid,
  coalesce(r.google_ads_conversion_action_name, 'CallConvertOffline') as conversion_name,
  to_char(r.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  r.conversion_value,
  coalesce(nullif(r.currency_code, ''), 'USD') as conversion_currency,
  coalesce(
    nullif(r.ringba_call_id, ''),
    nullif(r.calltools_call_id, ''),
    case when r.phone_digits10 is not null then
      r.et_date
      || '-' || substr(r.phone_digits10, 1, 3)
      || '-' || substr(r.phone_digits10, 4, 3)
      || '-' || substr(r.phone_digits10, 7, 4)
      || case
           when r.rn_date_phone = 1 then ''
           when r.rn_date_phone between 2 and 26 then '_' || chr(64 + r.rn_date_phone::int)
           else '_' || r.rn_date_phone::text
         end
    else null end,
    r.id::text
  ) as order_id,
  coalesce(nullif(r.raw_payload->>'ip_address', ''), nullif(r.lead_ip::text, '')) as ip_address,
  coalesce(nullif(r.caller_email, ''), nullif(r.lead_email, '')) as email,
  case
    when r.caller_id ~ '^\+' then r.caller_id
    when r.caller_id ~ '^1[0-9]{10}$' then '+' || r.caller_id
    when r.caller_id ~ '^[0-9]{10}$' then '+1' || r.caller_id
    when r.lead_phone ~ '^\+' then r.lead_phone
    when r.lead_phone ~ '^1[0-9]{10}$' then '+' || r.lead_phone
    when r.lead_phone ~ '^[0-9]{10}$' then '+1' || r.lead_phone
    else nullif(coalesce(r.caller_id, r.lead_phone), '')
  end as phone,
  coalesce(nullif(r.caller_first_name, ''), nullif(r.lead_first_name, '')) as first_name,
  coalesce(nullif(r.caller_last_name, ''), nullif(r.lead_last_name, '')) as last_name,
  null::text as session_attributes,
  null::text as user_agent,
  r.publisher,
  r.status,
  r.sheet_synced_at,
  r.created_at as event_created_at,
  -- ---- API-only additions (Sheet view does not select these) ----
  r.event_type,
  r.conversion_time as conversion_time_ts,
  r.upload_attempts,
  r.google_ads_customer_id,
  coalesce(nullif(r.caller_zip, ''), nullif(r.lead_zip, '')) as zip
from ranked r
where r.publisher = 'NBA'
  and (r.event_type = 'call_transferred' or r.conversion_value > 0)
  and (
    nullif(r.gclid, '') is not null
    or nullif(r.gbraid, '') is not null
    or nullif(r.wbraid, '') is not null
    or coalesce(nullif(r.caller_email, ''), nullif(r.lead_email, '')) is not null
    or coalesce(nullif(r.caller_id, ''), nullif(r.lead_phone, '')) is not null
  );

comment on view public.v_offline_conversion_export is
  'Canonical offline-conversion upload record (Sheet AND Data Manager API read this, '
  'so both upload identical data). Not filtered by sync state; consumers filter: Sheet by '
  'sheet_synced_at IS NULL, API by status (monetize_ready/transfer_ready) + 85-day age.';

grant select on public.v_offline_conversion_export to authenticated, service_role;

-- Sheet view: now a thin filter on the base. Same 20 output columns as before.
drop view if exists public.v_google_sheet_export_unsynced;
create view public.v_google_sheet_export_unsynced as
select
  event_id, google_click_id, gbraid, wbraid, conversion_name, conversion_time,
  conversion_value, conversion_currency, order_id, ip_address, email, phone,
  first_name, last_name, session_attributes, user_agent,
  publisher, status, sheet_synced_at, event_created_at
from public.v_offline_conversion_export
where sheet_synced_at is null
order by conversion_time_ts asc;

comment on view public.v_google_sheet_export_unsynced is
  'Unsynced NBA offline conversions for the Google Sheet. Thin filter over '
  'v_offline_conversion_export (single source of truth shared with the DM API path).';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
