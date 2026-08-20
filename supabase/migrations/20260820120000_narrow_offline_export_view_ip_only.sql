-- Fix: offline-conversion export view times out at the 8s statement_timeout.
--
-- INCIDENT (2026-08-17 → 2026-08-20): both delivery paths (sync-google-sheet and
-- upload-google-offline-conversions) silently 500'd with "canceling statement due
-- to statement timeout". Ingestion was healthy the whole time; the failure was
-- purely that v_offline_conversion_export got too slow to read inside 8s as
-- offline_conversion_events grew (~67k rows). Symptoms matched exactly:
-- CallConvertOffline last seen Aug 19 (Sheet view crossed 8s), CallXfer +
-- Test_DataMgrAPIUpload last seen Aug 17 (heavier API read crossed 8s first).
-- Rows stuck with upload_attempts=0 and no google_upload_error (never reached the
-- send loop). Crons kept reporting success because net.http_post fires fine; the
-- 500 was inside the function.
--
-- ROOT CAUSE: the base view runs
--   row_number() OVER (PARTITION BY et_date, phone_digits10 ORDER BY created_at,id)
-- over the WHOLE table, and the CTE carried the full raw_payload jsonb, so the
-- window's Sort node materialized ~67k WIDE rows and spilled to disk (external
-- merge ~8.5MB). Measured: 7.6s (right at the 8s cliff).
--
-- FIX (this migration): carry ONLY raw_payload->>'ip_address' (as ip_raw) through
-- the CTE instead of the whole jsonb. The window sort then handles narrow rows and
-- stays in memory. Measured after: 3.3s (2.3x headroom under 8s).
--
-- OUTPUT IS BYTE-IDENTICAL: the ip_address output column is computed from the same
-- raw_payload->>'ip_address' value, just extracted earlier. No filter, no ordering,
-- no other column, and no order_id/dedup logic changes. Verified 0-row diff both
-- directions (see verification query at the bottom of this file, run before apply).
--
-- NOTE ON DURABILITY: offline_conversion_events is never pruned (archive-old-sheet-rows
-- only trims the Google Sheet), so the table keeps growing and this read will creep
-- back toward 8s in ~6 weeks at current volume. The durable follow-up is to
-- precompute order_id at ingest and drop the window from the read path entirely
-- (see docs/pipeline-incident-2026-08/README.md, "Durable follow-up"). This
-- migration is the safe, zero-behavior-change restore.
--
-- ROLLBACK: re-run migration 20260807120000_offline_conversion_export_base_view.sql
-- (its definition is unchanged except for the ip source). Reversible, no data touched.

create or replace view public.v_offline_conversion_export as
with events_with_phone as (
  select
    oce.id, oce.lead_id, oce.publisher, oce.status, oce.event_type,
    oce.upload_attempts, oce.google_ads_customer_id,
    oce.gclid, oce.gbraid, oce.wbraid, oce.ringba_call_id, oce.calltools_call_id,
    oce.caller_id, oce.caller_email, oce.caller_first_name, oce.caller_last_name,
    oce.caller_zip, oce.conversion_time, oce.conversion_value, oce.currency_code,
    oce.google_ads_conversion_action_name, oce.sheet_synced_at, oce.created_at,
    nullif(oce.raw_payload->>'ip_address', '') as ip_raw,   -- CHANGED: extract ip only, not full raw_payload
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
  coalesce(r.ip_raw, nullif(r.lead_ip::text, '')) as ip_address,   -- CHANGED: use pre-extracted ip_raw (same value)
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
  'sheet_synced_at IS NULL, API by status (monetize_ready/transfer_ready) + 85-day age. '
  '2026-08-20: carry ip only (not full raw_payload) so the row_number() window sort stays '
  'under the 8s statement_timeout — output unchanged.';

grant select on public.v_offline_conversion_export to authenticated, service_role;

-- v_google_sheet_export_unsynced is a thin wrapper on the above and depends only on
-- output columns that are unchanged here, so it does not need recreating.

-- ============================================================================
-- VERIFICATION (run in a scratch session BEFORE applying to prod; expect 0/0):
--
--   -- new definition (this file) vs the currently-deployed view, both directions.
--   -- Save the SELECT body above as a CTE `new_view`, then:
--   --   select count(*) from ( table new_view except table v_offline_conversion_export ) a;  -- expect 0
--   --   select count(*) from ( table v_offline_conversion_export except table new_view ) b;  -- expect 0
-- ============================================================================
