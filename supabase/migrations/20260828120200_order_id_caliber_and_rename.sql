-- Offline-CV accuracy, step 2: order_id trigger — add a Caliber phone/day branch,
-- and adopt the conversion_call_id rename. Everything else is byte-identical to the
-- prior version (20260821000100), so Ringba and CallTools-interim behavior is UNCHANGED.
--
-- Grain by source (order_id is the Google Order ID → the de-dup grain):
--   * Ringba (conversion_call_id 'RGB…')      -> conversion_call_id  (per-call, GROSS)
--   * CallTools interim (non-RGB, not caliber) -> conversion_call_id  (contact id — LEFT AS-IS)
--   * Caliber (source='caliber')               -> phone + ET-day, NO rank (collapse → phone/day)
--   * no call id + phone (rare fallback)       -> phone + ET-day + _B/_C rank (kept distinct)
--   * nothing                                  -> row id
--
-- Caliber uses phone/day (owner's rule: unexplained multi-fires per phone). Its $6 CCO and
-- its $0 derived transfer both land on the same phone/day order_id, so their counts match and
-- same-day repeats from one number collapse to one — exactly the intended internet behavior.

create or replace function public.set_offline_conversion_order_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone10 text;
  v_etdate  text;
  v_rank    int;
begin
  -- Preserve an explicitly-provided order_id (re-inserts / manual tooling).
  if nullif(NEW.order_id, '') is not null then
    return NEW;
  end if;

  -- last-10 phone from caller_id, else the matched lead's phone (shared by both branches).
  select case
           when length(regexp_replace(coalesce(nullif(NEW.caller_id,''), nullif(l.phone,''), ''), '\D','','g')) >= 10
           then right(regexp_replace(coalesce(nullif(NEW.caller_id,''), nullif(l.phone,''), ''), '\D','','g'), 10)
           else null
         end
    into v_phone10
  from (select 1) _ left join public.leads l on l.id = NEW.lead_id;

  v_etdate := to_char(NEW.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD');

  -- ---- Caliber: phone + ET-day, collapse (no rank). Both CCO and transfer share it. ----
  if NEW.source = 'caliber' then
    if v_phone10 is not null then
      NEW.order_id :=
        v_etdate
        || '-' || substr(v_phone10,1,3)
        || '-' || substr(v_phone10,4,3)
        || '-' || substr(v_phone10,7,4);
    elsif nullif(NEW.conversion_call_id, '') is not null then
      NEW.order_id := NEW.conversion_call_id;          -- caliber w/o phone: fall to the call id
    else
      NEW.order_id := NEW.id::text;
    end if;
    return NEW;
  end if;

  -- ---- Everything else: UNCHANGED from 20260821000100 (only the column is renamed) ----
  -- 1) call ids win, no rank needed
  if nullif(NEW.conversion_call_id, '') is not null then
    NEW.order_id := NEW.conversion_call_id;             -- Ringba RGB (per-call) | CT contact id
    return NEW;
  elsif nullif(NEW.calltools_call_id, '') is not null then
    NEW.order_id := NEW.calltools_call_id;
    return NEW;
  end if;

  -- 2) phone-fallback with rank (rare: no call id, but a phone). Kept distinct.
  if v_phone10 is null then
    NEW.order_id := NEW.id::text;                       -- 3) no identifier at all -> id
    return NEW;
  end if;

  select 1 + count(*)
    into v_rank
  from public.offline_conversion_events oce
  left join public.leads l on l.id = oce.lead_id
  where to_char(oce.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD') = v_etdate
    and case
          when length(regexp_replace(coalesce(nullif(oce.caller_id,''), nullif(l.phone,''), ''), '\D','','g')) >= 10
          then right(regexp_replace(coalesce(nullif(oce.caller_id,''), nullif(l.phone,''), ''), '\D','','g'), 10)
          else null
        end = v_phone10;

  NEW.order_id :=
    v_etdate
    || '-' || substr(v_phone10,1,3)
    || '-' || substr(v_phone10,4,3)
    || '-' || substr(v_phone10,7,4)
    || case
         when v_rank = 1 then ''
         when v_rank between 2 and 26 then '_' || chr(64 + v_rank)
         else '_' || v_rank::text
       end;
  return NEW;
end;
$$;

comment on function public.set_offline_conversion_order_id() is
  'Sets order_id at insert. Caliber -> phone+ET-day (collapse). Ringba/CT interim -> '
  'conversion_call_id (RGB per-call / CT contact id, unchanged). Rare no-call-id -> phone+rank -> id.';

-- Trigger definition unchanged; function body swapped above.
