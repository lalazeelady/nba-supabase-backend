-- Re-extend the Google Sheet export view to 15 columns: the 8 click-conversion
-- fields plus 7 PII enrichment fields for Google's "Enhanced conversions for
-- offline conversions" feature. The gclid is still required for the row to
-- match (filter unchanged); the PII columns boost match accuracy.
--
-- New columns (in user's Sheet order):
--   I. ip address
--   J. email
--   K. phone
--   L. first name
--   M. last name
--   N. session attributes
--   O. user agent
--
-- PII is emitted RAW from the view. The syncer (sync-google-sheet edge function)
-- SHA-256 hashes email/phone/first/last name before pushing to the Sheet, per
-- Google's Enhanced Conversions hashing spec. ip address, session attributes,
-- and user agent are sent raw (Google does not require them hashed).
--
-- Source priority:
--   email/first/last/phone: Ringba postback fields (oce.caller_*) win, then
--                           leads-JOIN fallback (l.*).
--   ip address:             Ringba postback raw_payload->>'ip_address' if
--                           non-empty (Ringba just started forwarding it),
--                           else leads.ip_address from form submit.
--   session attributes:     NULL (not captured for inbound calls).
--   user agent:             NULL (not captured for inbound calls).

drop view if exists public.v_google_sheet_export_unsynced;

create view public.v_google_sheet_export_unsynced as
select
  oce.id as event_id,
  -- A. Google Click ID
  oce.gclid as google_click_id,
  -- B. gbraid
  oce.gbraid,
  -- C. wbraid
  oce.wbraid,
  -- D. Conversion Name
  coalesce(oce.google_ads_conversion_action_name, 'CallConvertOffline') as conversion_name,
  -- E. Conversion Time (UTC, e.g. 2026-04-30 13:44:00+0000)
  to_char(oce.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  -- F. Conversion Value
  oce.conversion_value,
  -- G. Conversion Currency
  coalesce(nullif(oce.currency_code, ''), 'USD') as conversion_currency,
  -- H. Order ID (Ringba call id is unique per call -> Google dedupes by this)
  oce.ringba_call_id as order_id,
  -- I. ip address (Ringba forwards if available; falls back to landing-page
  -- IP from the leads table when the call originated from a form fill)
  coalesce(
    nullif(oce.raw_payload->>'ip_address', ''),
    nullif(l.ip_address::text, '')
  ) as ip_address,
  -- J. email (raw — syncer hashes)
  coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) as email,
  -- K. phone in E.164 (raw — syncer hashes)
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
  -- L. first name (raw — syncer hashes)
  coalesce(nullif(oce.caller_first_name, ''), nullif(l.first_name, '')) as first_name,
  -- M. last name (raw — syncer hashes)
  coalesce(nullif(oce.caller_last_name, ''), nullif(l.last_name, '')) as last_name,
  -- N. session attributes (not captured for inbound calls)
  null::text as session_attributes,
  -- O. user agent (not captured for inbound calls)
  null::text as user_agent,
  -- supplementary fields for the syncer (not emitted to Sheet)
  oce.publisher,
  oce.status,
  oce.sheet_synced_at,
  oce.created_at as event_created_at
from public.offline_conversion_events oce
left join public.leads l on l.id = oce.lead_id
where oce.publisher = 'NBA'
  and oce.conversion_value > 0
  and oce.sheet_synced_at is null
  and (
    nullif(oce.gclid, '') is not null
    or nullif(oce.gbraid, '') is not null
    or nullif(oce.wbraid, '') is not null
  )
order by oce.conversion_time asc;

comment on view public.v_google_sheet_export_unsynced is
  'NBA-publisher revenue events with at least one click identifier (gclid/gbraid/wbraid), not yet pushed to the Google Sheet. 15-column Enhanced-Conversions-for-Offline-Conversions template. PII raw — syncer hashes email/phone/first/last before pushing.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
