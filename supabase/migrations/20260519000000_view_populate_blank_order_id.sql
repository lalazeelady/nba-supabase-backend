-- Guarantee a non-blank Order ID for every row the Google Sheet export view
-- emits. Order ID is the de-dup key Google Ads uses when ingesting the Sheet
-- as Offline Conversions, and it's also the lookup key for the manual
-- prune-sheet-rows-by-order-id cleanup tool. Blank Order IDs break both.
--
-- Before this migration, `order_id` was just `oce.ringba_call_id`, which is
-- frequently null when a CallTools call reaches us without a Ringba call id
-- attached (Ringba sometimes doesn't forward one). Those rows landed in the
-- Sheet with a blank column H.
--
-- New precedence (first non-blank wins):
--   1. oce.ringba_call_id           -- typical Ringba "RGB..." postback id
--   2. oce.calltools_call_id        -- when only CallTools provided an id
--   3. YYYY-MM-DD-XXX-XXX-XXXX      -- ET-local date + last 10 phone digits;
--                                      _B/_C/... suffix when the same
--                                      (date, phone) appears more than once
--   4. oce.id::text                 -- event UUID; last resort when no phone
--
-- The (date, phone) suffix is computed with row_number() over ALL rows in
-- offline_conversion_events (not just the unsynced ones in the view's
-- output), so a freshly-arrived second call from the same phone on the same
-- ET day correctly receives _B even when the first one was already synced.
-- Ordering is by created_at then id for determinism.
--
-- Forward-only fix. Historical rows already synced to the Sheet keep their
-- existing (sometimes blank) Order ID -- this view only governs new emissions
-- because the sync function filters on `sheet_synced_at is null`.
--
-- Implemented as a view-only change. No edge-function redeploy needed; the
-- next scheduled sync-google-sheet run picks up the new logic automatically.

drop view if exists public.v_google_sheet_export_unsynced;

create view public.v_google_sheet_export_unsynced as
with events_with_phone as (
  select
    oce.id,
    oce.lead_id,
    oce.publisher,
    oce.status,
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
    -- Last 10 digits of whichever phone we have (caller_id preferred, then
    -- the matched lead's phone). Null when neither source yields >=10 digits.
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
    -- Eastern-time date of the conversion event, for the fallback Order ID.
    -- Using ET (the business's operating timezone) means the date in the
    -- generated id reads the way the call center thinks about call days.
    to_char(oce.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD')
      as et_date
  from public.offline_conversion_events oce
  left join public.leads l on l.id = oce.lead_id
),
ranked as (
  select
    e.*,
    -- Position within (ET date, phone) over the whole table -- including
    -- already-synced rows -- so a new row gets the correct A/B/C suffix
    -- relative to its predecessors.
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
             -- A-Z suffix for occurrences 2-26; numeric fallback if we ever
             -- get a 27th same-date-same-phone event (extremely unlikely).
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
  and r.conversion_value > 0
  and r.sheet_synced_at is null
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
  'NBA-publisher revenue events to push to the Google Sheet feeding '
  'CallConvertOffline. Includes click-bearing rows (matched via '
  'gclid/gbraid/wbraid) and no-click rows (matched via PII through '
  'account-level Enhanced Conversions for Leads). Order ID falls back '
  'through ringba_call_id -> calltools_call_id -> YYYY-MM-DD-XXX-XXX-XXXX '
  '(ET date + last 10 phone digits, with _B/_C suffix on repeat) -> '
  'event UUID, so column H is never blank. Rows with NO identifier '
  'whatsoever are filtered out -- Data Manager would reject them anyway.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
