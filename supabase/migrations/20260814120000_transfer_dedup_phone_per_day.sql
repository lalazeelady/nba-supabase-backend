-- CallXfer dedup → ONE per caller-phone per Eastern-Time day (both paths), so
-- uploads to Google equal "distinct phone numbers per day" in the Ringba /
-- CallTools reports. Supersedes the call-id dedup (migration 20260804140000).
-- The ringba-transfer-webhook was re-keyed to phone+ET-date in the same change.
-- Forward-only: already-uploaded transfers are unaffected.

create or replace function public.derive_internet_transfer_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone10 text;
  v_dedupe  text;
  v_status  text;
begin
  -- Skip Ringba (RGB) calls — the pixel handles those.
  if NEW.ringba_call_id is not null and NEW.ringba_call_id ilike 'RGB%' then
    return null;
  end if;

  -- dedupe_key: ONE CallXfer per caller per Eastern-Time day, so uploads match
  -- the CallTools report's distinct-phones-per-day. Fall back to the call id
  -- (then click:time) only when no caller phone is present.
  v_phone10 := regexp_replace(coalesce(NEW.caller_id, ''), '\D', '', 'g');
  if length(v_phone10) >= 10 then
    v_phone10 := right(v_phone10, 10);
  else
    v_phone10 := null;
  end if;

  if v_phone10 is not null then
    v_dedupe := 'ringba:call_transferred:' || v_phone10 || ':'
      || to_char(NEW.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD');
  elsif NEW.ringba_call_id is not null and NEW.ringba_call_id <> '' then
    v_dedupe := 'ringba:call_transferred:' || NEW.ringba_call_id;
  else
    v_dedupe := 'ringba:call_transferred:'
      || coalesce(NEW.gclid, NEW.gbraid, NEW.wbraid, 'no_click') || ':'
      || to_char(NEW.conversion_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  end if;

  if (NEW.gclid is not null or NEW.gbraid is not null or NEW.wbraid is not null
      or NEW.lead_id is not null or nullif(NEW.caller_email, '') is not null
      or nullif(NEW.caller_id, '') is not null
      or (NEW.caller_first_name is not null and NEW.caller_last_name is not null
          and NEW.caller_zip is not null))
  then
    v_status := 'transfer_ready';
  else
    v_status := 'transfer_unmatched';
  end if;

  insert into public.offline_conversion_events (
    source, event_type, status, lead_id, transaction_id, ringba_call_id,
    calltools_call_id, caller_id, gclid, gbraid, wbraid, conversion_time,
    conversion_value, currency_code, caller_email, caller_first_name,
    caller_last_name, caller_zip, caller_state, publisher,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    google_ads_conversion_action_name, raw_payload, dedupe_key
  ) values (
    NEW.source, 'call_transferred', v_status, NEW.lead_id, NEW.transaction_id,
    NEW.ringba_call_id, NEW.calltools_call_id, NEW.caller_id, NEW.gclid, NEW.gbraid,
    NEW.wbraid, NEW.conversion_time,
    0,
    NEW.currency_code, NEW.caller_email, NEW.caller_first_name, NEW.caller_last_name,
    NEW.caller_zip, NEW.caller_state, NEW.publisher,
    NEW.utm_source, NEW.utm_medium, NEW.utm_campaign, NEW.utm_content, NEW.utm_term,
    'CallXfer',
    coalesce(NEW.raw_payload, '{}'::jsonb)
      || jsonb_build_object('_derived_transfer_from_event_id', NEW.id::text),
    v_dedupe
  )
  on conflict (dedupe_key) do nothing;

  return null;
end;
$$;

comment on function public.derive_internet_transfer_event() is
  'Derives a $0 CallXfer from each INTERNET (non-RGB) monetization. dedupe_key is '
  'ONE per caller-phone per Eastern-Time day, so CallXfer uploads equal the CallTools '
  'report''s distinct-phones-per-day. Skips Ringba (RGB) calls (pixel handles those).';
