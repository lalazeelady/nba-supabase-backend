-- Durable fix, step 3 of 3: read order_id from the column; DROP the window.
--
-- With order_id stored (backfilled + trigger-maintained), the view no longer needs
-- the row_number() window or the whole-table scan/sort it forced. It becomes a plain
-- join + filter that the planner can satisfy with the status / nba_unsynced /
-- api_unsent indexes. Measured read: ~815ms vs ~11s, and it scales with backlog, not
-- table size — so after this we can return service_role's statement_timeout to 8s
-- (see 20260821000300).
--
-- Output is unchanged: order_id now comes from the column (identical to the old
-- windowed value by construction; coalesce to id::text is a belt-and-suspenders
-- default for any eligible row not yet backfilled). Every other column is byte-for-
-- byte the same as 20260820120000. Verify with the EXCEPT check before applying.

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
  coalesce(nullif(oce.order_id, ''), oce.id::text) as order_id,          -- from the column now
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
  );

comment on view public.v_offline_conversion_export is
  'Canonical offline-conversion upload record. 2026-08-21: order_id is read from the '
  'stored column (precomputed at ingest) instead of a per-read row_number() window, so '
  'the read is index-driven and fast. Consumers still filter: Sheet by sheet_synced_at '
  'IS NULL, API by status (monetize_ready/transfer_ready) + 85-day age.';

grant select on public.v_offline_conversion_export to authenticated, service_role;
