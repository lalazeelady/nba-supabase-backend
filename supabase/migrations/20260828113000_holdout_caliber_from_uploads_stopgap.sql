-- STOPGAP (deploy now, standalone): hold Caliber OUT of Google uploads until cutover.
--
-- Context: the Caliber pixel went live 2026-08-28 and, under the current code, its fires are
-- treated as normal internet (source='ringba') and were being uploaded to Google via BOTH
-- paths — on top of CallTools internet still firing. That double-counts internet. Owner's
-- requirement: Caliber is visible in the table but NOT uploaded until we align on cutover.
--
-- This migration is ONLY that hold-out. It recreates v_offline_conversion_export exactly as
-- 20260821000200 (order_id from column) plus ONE predicate that drops Caliber-signature rows.
-- Caliber is fingerprinted by the `status` field in raw_payload, which Ringba/CallTools never
-- send — so this catches Caliber regardless of how `source` is stamped. No source filter, no
-- rename, no other change. Both consumers (Sheet via v_google_sheet_export_unsynced, and the
-- API) inherit it automatically.
--
-- REVERSIBLE: re-run 20260821000200_view_read_order_id_column.sql to restore. At cutover this
-- line is removed (and CallTools turned off) — see docs/offline-cv-accuracy/SWITCHOVER.md.
-- Already-uploaded Caliber rows stay in Google (cannot be un-sent); this stops NEW ones.

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
  coalesce(nullif(oce.caller_zip, ''), nullif(l.zip, '')) as zip
from public.offline_conversion_events oce
left join public.leads l on l.id = oce.lead_id
where oce.publisher = 'NBA'
  and (oce.event_type = 'call_transferred' or oce.conversion_value > 0)
  and (
    nullif(oce.gclid, '') is not null
    or nullif(oce.gbraid, '') is not null
    or nullif(oce.wbraid, '') is not null
    or coalesce(nullif(oce.caller_email, ''), nullif(l.email, '')) is not null
    or coalesce(nullif(oce.caller_id, ''), nullif(l.phone, '')) is not null
  )
  -- CALIBER HOLD-OUT (stopgap; remove at cutover): drop Caliber-signature rows.
  and not (oce.raw_payload ? 'status');

comment on view public.v_offline_conversion_export is
  'Canonical offline-conversion upload record. 2026-08-28 STOPGAP: excludes Caliber-signature '
  'rows (raw_payload ? ''status'') from upload until cutover. Otherwise identical to 20260821000200.';

grant select on public.v_offline_conversion_export to authenticated, service_role;
