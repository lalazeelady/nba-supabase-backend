-- Drop the gclid/gbraid/wbraid required filter from v_google_sheet_export_unsynced
-- so all NBA-publisher revenue rows (click + no-click) flow into the Google Sheet.
--
-- Test goal: verify whether the existing CallConvertOffline conversion action
-- (Import-from-clicks type, with account-level Enhanced Conversions enabled)
-- accepts no-click rows via PII fallback. If yes, we have the simplest possible
-- architecture: one conversion action handles everything.
--
-- If the test fails (no-click conversions don't show up in Google Ads reports
-- after 24h), the revert is straightforward:
--   1. prune-sheet-rows-by-order-id removes the no-click rows from the Sheet
--   2. UPDATE oce SET sheet_synced_at = NULL on the no-click rows
--   3. Re-apply the click-id filter in a follow-up migration
--
-- Column structure unchanged — only the WHERE clause changes.

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
order by oce.conversion_time asc;

comment on view public.v_google_sheet_export_unsynced is
  'NBA-publisher revenue events not yet pushed to the Google Sheet. ALL rows '
  '(click + no-click) — testing whether the existing CallConvertOffline '
  'conversion action with account-level ECL accepts no-click rows via PII match. '
  'Revert: re-add gclid/gbraid/wbraid filter if Google Ads conversion attribution '
  'doesn''t pick them up after 24h.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
