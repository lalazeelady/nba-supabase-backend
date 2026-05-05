-- Normalize emails before they reach the Google Sheet export so Customer
-- Match / Enhanced Conversions for Leads matches at the highest possible
-- rate. Two transformations:
--   1. Lowercase every email (Google hashes case-sensitively, so "A@x.com"
--      and "a@x.com" hash to different values and won't match).
--   2. For gmail.com only, strip dots from the local part. Gmail treats
--      "first.last@gmail.com" and "firstlast@gmail.com" as the same inbox;
--      Google Ads' canonicalization expects the dotless form. Other domains
--      are NOT touched (some servers do treat dots as significant).
--
-- Implemented as a view-only change. The `sync-google-sheet` edge function
-- continues to SHA-256 hash whatever the view returns, so it'll start
-- hashing the normalized values automatically on its next run -- no
-- function redeploy or backfill needed.

-- 1. Helper function. SQL, immutable, safe to inline in the view.
create or replace function public.normalize_email_for_google(raw_email text)
returns text
language sql
immutable
as $$
  select case
    when raw_email is null then null
    -- Only treat as gmail when the lowercased value is structurally a
    -- single-@ gmail.com address. Avoids accidentally rewriting malformed
    -- inputs like "a@b@gmail.com" into a valid-looking gmail.
    when lower(raw_email) ~ '^[^@]+@gmail\.com$'
      then replace(split_part(lower(raw_email), '@', 1), '.', '') || '@gmail.com'
    else lower(raw_email)
  end;
$$;

comment on function public.normalize_email_for_google(text) is
  'Lowercases an email; for single-@ gmail.com addresses also strips dots '
  'from the local part. Used by v_google_sheet_export_unsynced to feed '
  'normalized emails into Customer Match / Enhanced Conversions for Leads.';

-- 2. Recreate the export view with the email column wrapped. Everything
-- else is byte-identical to the previous definition
-- (20260501030000_view_skip_rows_with_no_identifier.sql).
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
  -- Email -- normalized for Google ingest (lowercase + gmail dot-strip).
  public.normalize_email_for_google(
    coalesce(nullif(oce.caller_email, ''), nullif(l.email, ''))
  ) as email,
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
  'whatsoever are filtered out -- Data Manager would reject them anyway. '
  'Email column is normalized via public.normalize_email_for_google() for '
  'highest-possible Customer Match / ECL match rate.';

grant select on public.v_google_sheet_export_unsynced to authenticated, service_role;
