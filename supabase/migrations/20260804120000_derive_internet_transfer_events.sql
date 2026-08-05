-- Derive a CallXfer ($0 transfer) event from every INTERNET monetization.
--
-- Rationale: a CallTools/internet transfer monetizes *at the moment of
-- transfer*, so a monetization IS the transfer (unlike a Ringba call, which
-- has a distinct Incoming-transfer event captured by ringba-transfer-webhook).
-- Rather than run a separate CallTools transfer pixel, we derive the transfer
-- from the monetization row via this trigger.
--
-- Fingerprint (confirmed against live data 2026-08-04):
--   * Ringba call monetization  -> ringba_call_id LIKE 'RGB%', avg ~$25  -> SKIP
--       (its transfer already arrives via the Incoming pixel; deriving one
--        here would double-count).
--   * Internet monetization      -> non-'RGB' call id, flat $6, 99.7% have a
--       phone -> derive a CallXfer $0 row.
--
-- The derived row uses the SAME per-caller-per-ET-day dedupe_key the
-- ringba-transfer-webhook uses, so:
--   * multiple same-day internet monetizations for one caller collapse to one
--     CallXfer (ON CONFLICT DO NOTHING on the unique dedupe_key index), and
--   * if that caller ALSO had a Ringba pixel transfer the same day, the two
--     collapse into a single CallXfer (correct: one qualified transfer/caller/day).
--
-- Zero changes to the revenue webhook. Forward-only (fires on new inserts).
-- Survives the internet-to-Caliber move: Caliber internet monetizations are
-- also non-'RGB', so they keep deriving transfers until the full Ringba->Caliber
-- cutover, at which point this rule is revisited.

create or replace function public.derive_internet_transfer_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone10 text;
  v_etdate  text;
  v_dedupe  text;
  v_status  text;
begin
  -- Only Ringba-published monetizations are in scope; skip real Ringba calls
  -- (they already get a transfer via the Incoming pixel).
  if NEW.ringba_call_id is not null and NEW.ringba_call_id ilike 'RGB%' then
    return null;
  end if;

  -- Build the transfer dedupe_key identically to ringba-transfer-webhook:
  -- prefer phone+ET-day, then call id, then click:time.
  v_phone10 := regexp_replace(coalesce(NEW.caller_id, ''), '\D', '', 'g');
  if length(v_phone10) >= 10 then
    v_phone10 := right(v_phone10, 10);
  else
    v_phone10 := null;
  end if;
  v_etdate := to_char(NEW.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD');

  if v_phone10 is not null then
    v_dedupe := 'ringba:call_transferred:' || v_phone10 || ':' || v_etdate;
  elsif NEW.ringba_call_id is not null and NEW.ringba_call_id <> '' then
    v_dedupe := 'ringba:call_transferred:' || NEW.ringba_call_id;
  else
    v_dedupe := 'ringba:call_transferred:'
      || coalesce(NEW.gclid, NEW.gbraid, NEW.wbraid, 'no_click')
      || ':' || to_char(NEW.conversion_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  end if;

  -- Same status logic as the webhook: ready if any identifier is present.
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
    0,                              -- transfers are $0, count-only
    NEW.currency_code, NEW.caller_email, NEW.caller_first_name, NEW.caller_last_name,
    NEW.caller_zip, NEW.caller_state, NEW.publisher,
    NEW.utm_source, NEW.utm_medium, NEW.utm_campaign, NEW.utm_content, NEW.utm_term,
    'CallXfer',
    coalesce(NEW.raw_payload, '{}'::jsonb)
      || jsonb_build_object('_derived_transfer_from_event_id', NEW.id::text),
    v_dedupe
  )
  on conflict (dedupe_key) do nothing;

  return null;  -- AFTER trigger; return value ignored
end;
$$;

comment on function public.derive_internet_transfer_event() is
  'Derives a $0 CallXfer transfer event from each INTERNET (non-RGB) monetization, '
  'since an internet transfer monetizes at transfer. Skips Ringba (RGB) calls, which '
  'get their transfer from the Incoming pixel. Uses the same per-caller-per-ET-day '
  'dedupe_key as ringba-transfer-webhook (ON CONFLICT DO NOTHING).';

drop trigger if exists trg_derive_internet_transfer on public.offline_conversion_events;

-- WHEN pre-filters so the function only runs for INTERNET monetizations
-- (non-RGB); Ringba (RGB) revenue rows never invoke it. The function keeps its
-- own RGB guard too, as defense in depth.
create trigger trg_derive_internet_transfer
  after insert on public.offline_conversion_events
  for each row
  when (
    NEW.event_type = 'call_converted_revenue'
    and (NEW.ringba_call_id is null or NEW.ringba_call_id not ilike 'RGB%')
  )
  execute function public.derive_internet_transfer_event();
