-- Extend the Google Sheet export view to ALSO emit call_transferred events.
--
-- Task 1 ("CallXfer"): the ringba-transfer-webhook writes $0, count-only
-- events with event_type='call_transferred' and
-- google_ads_conversion_action_name='CallXfer'. The previous view filtered
-- `conversion_value > 0`, which excluded every $0 transfer, so they never
-- reached the Sheet.
--
-- Two surgical changes vs. 20260519000000 (everything else is byte-for-byte
-- identical, including the Order-ID precedence, phone/date fallback, A/B/C
-- suffix logic, and identifier filter):
--   1. Carry oce.event_type through the CTE so the WHERE can branch on it.
--   2. Replace the flat `conversion_value > 0` gate with:
--        event_type = 'call_transferred'   -> $0 transfers allowed
--        OR conversion_value > 0           -> revenue rows unchanged
--
-- The view already selects each row's own conversion_name
-- (coalesce(google_ads_conversion_action_name, 'CallConvertOffline')), so
-- transfer rows flow to the Sheet carrying 'CallXfer' automatically and Google
-- routes them to the CallXfer action by that column. No change to
-- sync-google-sheet is needed (it selects a fixed column list, unaffected by
-- the added CTE column).
--
-- Transfers deliberately never carry status='ready_to_upload', so the
-- Data-Manager API uploader ignores them; this view (which keys on
-- event_type/value/identifier, not status) is their only upload path.
--
-- Forward-only: historical rows already stamped sheet_synced_at are untouched.

drop view if exists public.v_google_sheet_export_unsynced;

create view public.v_google_sheet_export_unsynced as
with events_with_phone as (
  select
    oce.id,
    oce.lead_id,
    oce.publisher,
    oce.status,
    oce.event_type,
    oce.gclid,
    oce.gbraid,
    oce.wbraid,
    oce.ringba_call_id,
    oce.calltools_call_id,
    oce.caller_id,
    oce.caller_email,
    oce.caller_first_name,
    oce.caller_last_name,
    oce.conversion_time,
    oce.conversion_value,
    oce.currency_code,
    oce.google_ads_conversion_action_name,
    oce.sheet_synced_at,
    oce.created_at,
    oce.raw_payload,
    l.email      as lead_email,
    l.phone      as lead_phone,
    l.first_name as lead_first_name,
    l.last_name  as lead_last_name,
    l.ip_address as lead_ip,
    case
      when length(regexp_replace(
        coalesce(nullif(oce.caller_id, ''), nullif(l.phone, ''), ''),
        '\D', '', 'g'
      )) >= 10
        then right(regexp_replace(
          coalesce(nullif(oce.caller_id, ''), nullif(l.phone, ''), ''),
          '\D', '', 'g'
        ), 10)
      else null
    end as phone_digits10,
    to_char(oce.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD')
      as et_date
  from public.offline_conversion_events oce
  left join public.leads l on l.id = oce.lead_id
),
ranked as (
  select
    e.*,
    row_number() over (
      partition by e.et_date, e.phone_digits10
      order by e.created_at asc, e.id asc
    ) as rn_date_phone
  from events_with_phone e
)
select
  r.id as event_id,
  r.gclid as google_click_id,
  r.gbraid,
  r.wbraid,
  coalesce(r.google_ads_conversion_action_name, 'CallConvertOffline')
    as conversion_name,
  to_char(r.conversion_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS"+0000"')
    as conversion_time,
  r.conversion_value,
  coalesce(nullif(r.currency_code, ''), 'USD') as conversion_currency,
  coalesce(
    nullif(r.ringba_call_id, ''),
    nullif(r.calltools_call_id, ''),
    case
      when r.phone_digits10 is not null then
        r.et_date
        || '-' || substr(r.phone_digits10, 1, 3)
        || '-' || substr(r.phone_digits10, 4, 3)
        || '-' || substr(r.phone_digits10, 7, 4)
        || case
             when r.rn_date_phone = 1 then ''
             when r.rn_date_phone between 2 and 26
               then '_' || chr(64 + r.rn_date_phone::int)
             else '_' || r.rn_date_phone::text
           end
      else null
    end,
    r.id::text
  ) as order_id,
  coalesce(
    nullif(r.raw_payload->>'ip_address', ''),
    nullif(r.lead_ip::text, '')
  ) as ip_address,
  coalesce(nullif(r.caller_email, ''), nullif(r.lead_email, '')) as email,
  case
    when r.caller_id ~ '^\+'
      then r.caller_id
    when r.caller_id ~ '^1[0-9]{10}$'
      then '+' || r.caller_id
    when r.caller_id ~ '^[0-9]{10}$'
      then '+1' || r.caller_id
    when r.lead_phone ~ '^\+'
      then r.lead_phone
    when r.lead_phone ~ '^1[0-9]{10}$'
      then '+' || r.lead_phone
    when r.lead_phone ~ '^[0-9]{10}$'
      then '+1' || r.lead_phone
    else nullif(coalesce(r.caller_id, r.lead_phone), '')
  end as phone,
  coalesce(nullif(r.caller_first_name, ''), nullif(r.lead_first_name, ''))
    as first_name,
  coalesce(nullif(r.caller_last_name, ''), nullif(r.lead_last_name, ''))
    as last_name,
  null::text as session_attributes,
  null::text as user_agent,
  r.publisher,
  r.status,
  r.sheet_synced_at,
  r.created_at as event_created_at
from ranked r
where r.publisher = 'NBA'
  and r.sheet_synced_at is null
  and (
    -- Transfers (CallXfer) are $0 count-only; revenue rows keep the > 0 gate.
    r.event_type = 'call_transferred'
    or r.conversion_value > 0
  )
  and (
    -- Row needs at least ONE identifier Google can match on. Otherwise
    -- Data Manager rejects with "all identifier fields empty".
    nullif(r.gclid, '') is not null
    or nullif(r.gbraid, '') is not null
    or nullif(r.wbraid, '') is not null
    or coalesce(nullif(r.caller_email, ''), nullif(r.lead_email, '')) is not null
    or coalesce(nullif(r.caller_id, ''), nullif(r.lead_phone, '')) is not null
  )
order by r.conversion_time asc;

comment on view public.v_google_sheet_export_unsynced is
  'NBA-publisher offline-conversion events to push to the Google Sheet. '
  'Includes revenue rows (event_type=call_converted_revenue, value>0, action '
  'CallConvertOffline) AND $0 count-only transfer rows '
  '(event_type=call_transferred, action CallXfer). Order ID falls back through '
  'ringba_call_id -> calltools_call_id -> YYYY-MM-DD-XXX-XXX-XXXX (ET date + '
  'last 10 phone digits, _B/_C on repeat) -> event UUID, so column H is never '
  'blank. Rows with NO identifier are filtered out (Data Manager rejects them).';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
