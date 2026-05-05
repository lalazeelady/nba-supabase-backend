-- Add a "row has at least one usable identifier" guard to the export view.
--
-- After running the ECL test (drop_click_filter_for_ecl_test), we found that
-- 4 historical no-click rows had NO identifier at all (no gclid/gbraid/wbraid,
-- no email, no phone). Data Manager rejects those with:
--   "Gbraid, wbraid, Email, phone number, gclid, IP address and session
--    attributes fields are empty. At least one of them needs to be populated."
--
-- The error confirms that account-level Enhanced Conversions for Leads is
-- accepting any ONE of click-id / email / phone / IP. Rows with literally
-- zero identifiers can never match, so we filter them out before they reach
-- the Sheet to keep Data Manager error counts at zero going forward.

drop view if exists public.v_google_sheet_export_unsynced;

create view public.v_google_sheet_export_unsynced as
select
  oce.id as event_id,
  oce.gclid as google_click_id,
  oce.gbraid,
  oce.wbraid,
  coalesce(oce.google_ads_conversion_action_name, 'CallConvertOffline') as conversion_name,
  to_char(oce.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  oce.conversion_value,
  coalesce(nullif(oce.currency_code, ''), 'USD') as conversion_currency,
  oce.ringba_call_id as order_id,
  coalesce(
    nullif(oce.raw_payload->>'ip_address', ''),
    nullif(l.ip_address::text, '')
  ) as ip_address,
  coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) as email,
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
  coalesce(nullif(oce.caller_first_name, ''), nullif(l.first_name, '')) as first_name,
  coalesce(nullif(oce.caller_last_name, ''), nullif(l.last_name, '')) as last_name,
  null::text as session_attributes,
  null::text as user_agent,
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
    -- Row needs at least ONE identifier Google can match on. Otherwise
    -- Data Manager rejects with "all identifier fields empty".
    nullif(oce.gclid, '') is not null
    or nullif(oce.gbraid, '') is not null
    or nullif(oce.wbraid, '') is not null
    or coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) is not null
    or coalesce(nullif(oce.caller_id, ''), nullif(l.phone, '')) is not null
  )
order by oce.conversion_time asc;

comment on view public.v_google_sheet_export_unsynced is
  'NBA-publisher revenue events to push to the Google Sheet feeding '
  'CallConvertOffline. Includes click-bearing rows (matched via '
  'gclid/gbraid/wbraid) and no-click rows (matched via PII through '
  'account-level Enhanced Conversions for Leads). Rows with NO identifier '
  'whatsoever are filtered out — Data Manager would reject them anyway.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
