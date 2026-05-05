-- View that emits NBA-publisher revenue events in the column order Google
-- Ads' scheduled offline-conversion-import + ECL template expects.
--
-- Filtering:
--   - publisher = 'NBA'        (only NBA-attributed revenue)
--   - conversion_value > 0     (only revenue-bearing events)
--   - sheet_synced_at IS NULL  (haven't been emitted to the Sheet yet)
--
-- Column order matches the user's prepared template (dedup currency column
-- removed). Times are emitted in UTC with +0000 offset — unambiguous and
-- avoids America/New_York DST edge cases. Google ECL accepts this format.
--
-- PII is coalesced: prefer Ringba-postback values (collected by NBA's live
-- agents during the call), fall back to landing-page form data via leads
-- JOIN. This maximizes ECL match rate.

create or replace view public.v_google_sheet_export_unsynced as
select
  oce.id as event_id,
  -- A. Google Click ID
  oce.gclid as google_click_id,
  -- B. gbraid
  oce.gbraid,
  -- C. wbraid
  oce.wbraid,
  -- D. Email
  coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) as email,
  -- E. Phone (E.164 +1...)
  case
    when oce.caller_id ~ '^\+'
      then oce.caller_id
    when oce.caller_id ~ '^1[0-9]{10}$'
      then '+' || oce.caller_id
    when oce.caller_id ~ '^[0-9]{10}$'
      then '+1' || oce.caller_id
    when l.phone ~ '^\+'
      then l.phone
    when l.phone ~ '^1[0-9]{10}$'
      then '+' || l.phone
    when l.phone ~ '^[0-9]{10}$'
      then '+1' || l.phone
    else nullif(coalesce(oce.caller_id, l.phone), '')
  end as phone,
  -- F. Conversion Name
  coalesce(oce.google_ads_conversion_action_name, 'CallConvertOffline') as conversion_name,
  -- G. Conversion Time (UTC, e.g. 2026-04-28 13:44:00+0000)
  to_char(oce.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  -- H. Conversion Value
  oce.conversion_value,
  -- I. Conversion Currency
  coalesce(nullif(oce.currency_code, ''), 'USD') as conversion_currency,
  -- J. Order ID (Ringba call id is unique per call → Google dedupes by this)
  oce.ringba_call_id as order_id,
  -- K. First Name
  coalesce(nullif(oce.caller_first_name, ''), nullif(l.first_name, '')) as first_name,
  -- L. Last Name
  coalesce(nullif(oce.caller_last_name, ''), nullif(l.last_name, '')) as last_name,
  -- M. Country (NBA is US-only)
  'US' as country,
  -- N. Zip
  coalesce(nullif(oce.caller_zip, ''), nullif(l.zip, '')) as zip,
  -- O. session attributes (not captured for inbound calls)
  null::text as session_attributes,
  -- P. ip address (only available on form-fill leads)
  l.ip_address::text as ip_address,
  -- Q. user agent (not captured)
  null::text as user_agent,
  -- supplementary fields for the syncer (not emitted to CSV)
  oce.publisher,
  oce.status,
  oce.sheet_synced_at,
  oce.created_at as event_created_at
from public.offline_conversion_events oce
left join public.leads l on l.id = oce.lead_id
where oce.publisher = 'NBA'
  and oce.conversion_value > 0
  and oce.sheet_synced_at is null
order by oce.conversion_time asc;

comment on view public.v_google_sheet_export_unsynced is
  'NBA-publisher revenue events not yet pushed to the Google Sheet, in the column order the user''s ECL+offline-conversion template expects. Consumed by export-google-sheet-csv edge function.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
