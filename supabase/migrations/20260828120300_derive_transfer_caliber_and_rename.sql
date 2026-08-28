-- Offline-CV accuracy, step 3: derive-transfer trigger — conversion_call_id rename,
-- source-aware dedupe prefix, and carry the new attribution columns onto the derived row.
--
-- Unchanged grain: internet (non-RGB) monetization -> a $0 CallXfer, deduped phone + ET-day
-- (owner's rule for internet). This is what makes internet transfer count == internet CCO
-- count. Ringba (RGB) monetizations are skipped (their transfer arrives via the Ringba pixel).
--
-- What changed vs 20260814120000:
--   * ringba_call_id -> conversion_call_id (rename).
--   * dedupe prefix uses NEW.source, so a CALIBER monetization derives a 'caliber:call_transferred:…'
--     transfer while CallTools-interim keeps 'ringba:call_transferred:…' (CT behavior untouched).
--   * the derived row copies ib_source/oppref/msclkid/fbclid/call_type/queue/agent_name/call_status
--     so the source filter and reporting see the same attribution on the transfer as on the CCO.
--   * order_id is left to set_offline_conversion_order_id (BEFORE INSERT) — caliber -> phone/day,
--     CT -> contact id — so we don't set it here.

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
  -- Skip Ringba (RGB) calls — the Ringba transfer pixel handles those.
  if NEW.conversion_call_id is not null and NEW.conversion_call_id ilike 'RGB%' then
    return null;
  end if;

  -- dedupe_key: ONE CallXfer per caller-phone per Eastern-Time day (internet rule). Prefix by
  -- source so Caliber and CallTools stay in separate namespaces. Fall back to the call id
  -- (then click:time) only when no caller phone is present.
  v_phone10 := regexp_replace(coalesce(NEW.caller_id, ''), '\D', '', 'g');
  if length(v_phone10) >= 10 then
    v_phone10 := right(v_phone10, 10);
  else
    v_phone10 := null;
  end if;

  if v_phone10 is not null then
    v_dedupe := NEW.source || ':call_transferred:' || v_phone10 || ':'
      || to_char(NEW.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD');
  elsif NEW.conversion_call_id is not null and NEW.conversion_call_id <> '' then
    v_dedupe := NEW.source || ':call_transferred:' || NEW.conversion_call_id;
  else
    v_dedupe := NEW.source || ':call_transferred:'
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
    source, event_type, status, lead_id, transaction_id, conversion_call_id,
    calltools_call_id, caller_id, gclid, gbraid, wbraid, conversion_time,
    conversion_value, currency_code, caller_email, caller_first_name,
    caller_last_name, caller_zip, caller_state, publisher,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    ib_source, oppref, msclkid, fbclid, call_type, queue, agent_name, call_status,
    google_ads_conversion_action_name, raw_payload, dedupe_key
  ) values (
    NEW.source, 'call_transferred', v_status, NEW.lead_id, NEW.transaction_id,
    NEW.conversion_call_id, NEW.calltools_call_id, NEW.caller_id, NEW.gclid, NEW.gbraid,
    NEW.wbraid, NEW.conversion_time,
    0,                                         -- transfers are $0, count-only
    NEW.currency_code, NEW.caller_email, NEW.caller_first_name, NEW.caller_last_name,
    NEW.caller_zip, NEW.caller_state, NEW.publisher,
    NEW.utm_source, NEW.utm_medium, NEW.utm_campaign, NEW.utm_content, NEW.utm_term,
    NEW.ib_source, NEW.oppref, NEW.msclkid, NEW.fbclid, NEW.call_type, NEW.queue,
    NEW.agent_name, NEW.call_status,
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
  'Derives a $0 CallXfer from each INTERNET (non-RGB) monetization (CallTools + Caliber), '
  'deduped phone+ET-day, prefixed by source. Skips Ringba (RGB) calls. order_id is set by '
  'set_offline_conversion_order_id (caliber -> phone/day, CT -> contact id).';

-- WHEN clause of trg_derive_internet_transfer already reads the renamed column via the
-- table (Postgres updated it on rename); recreate it to be explicit and self-documenting.
drop trigger if exists trg_derive_internet_transfer on public.offline_conversion_events;
create trigger trg_derive_internet_transfer
  after insert on public.offline_conversion_events
  for each row
  when (
    NEW.event_type = 'call_converted_revenue'
    and (NEW.conversion_call_id is null or NEW.conversion_call_id not ilike 'RGB%')
  )
  execute function public.derive_internet_transfer_event();
