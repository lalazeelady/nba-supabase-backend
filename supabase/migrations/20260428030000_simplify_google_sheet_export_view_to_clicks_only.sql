-- Phase 1B simplification: the Sheet feeding Google Ads scheduled upload is
-- now click-conversion-only (matches by gclid/gbraid/wbraid). Enhanced
-- Conversions for Leads (ECL) will live in a separate view + Sheet + pipeline
-- once the capture-side fixes land (email at intake, gclid on landing page,
-- gbraid/wbraid pass-through). Mixing both upload modes in one Sheet caused
-- Google's parser to reject every row ("Phone not hashed / Missing gclid").
--
-- Filter additions:
--   - At least one of gclid / gbraid / wbraid must be present. No-gclid rows
--     stay unsynced (sheet_synced_at = NULL) and wait for the future ECL pipe.
--
-- Column changes (17 -> 8):
--   - Dropped: email, phone, first_name, last_name, country, zip,
--              session_attributes, ip_address, user_agent
--   - Kept: google_click_id, gbraid, wbraid, conversion_name, conversion_time,
--           conversion_value, conversion_currency, order_id

-- create-or-replace can't drop columns from a view, so drop+recreate.
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
  -- E. Conversion Time (UTC, e.g. 2026-04-28 13:44:00+0000)
  to_char(oce.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  -- F. Conversion Value
  oce.conversion_value,
  -- G. Conversion Currency
  coalesce(nullif(oce.currency_code, ''), 'USD') as conversion_currency,
  -- H. Order ID (Ringba call id is unique per call -> Google dedupes by this)
  oce.ringba_call_id as order_id,
  -- supplementary fields for the syncer (not emitted to Sheet)
  oce.publisher,
  oce.status,
  oce.sheet_synced_at,
  oce.created_at as event_created_at
from public.offline_conversion_events oce
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
  'NBA-publisher revenue events with at least one click identifier (gclid/gbraid/wbraid), not yet pushed to the Google Sheet. 8-column click-conversion template. Consumed by sync-google-sheet edge function. ECL (no-gclid) path is a separate future view.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
