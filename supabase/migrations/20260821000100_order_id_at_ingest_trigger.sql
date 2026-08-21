-- Durable fix, step 2 of 3: compute order_id once, at insert.
--
-- Mirrors the EXACT precedence + format the view uses, so a stored order_id equals
-- what the window would have produced:
--   ringba_call_id -> calltools_call_id -> ET-date + last-10-phone + _B/_C rank
--   (rank = position among same ET-day + same phone, ordered by created_at,id) -> id.
--
-- The rank is only needed for the phone-fallback case (no call id, but a phone),
-- which is rare (~1/day historically). For that case, rank = 1 + count of existing
-- rows in the same (ET-date, phone10) partition — a new row always sorts last by
-- created_at, so count+1 == its row_number(). All other inserts are O(1).
--
-- phone10 and et_date expressions are copied verbatim from the view so results match.

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
  -- Preserve an explicitly-provided order_id (e.g. re-inserts / manual tooling).
  if nullif(NEW.order_id, '') is not null then
    return NEW;
  end if;

  -- 1) call ids win, no rank needed
  if nullif(NEW.ringba_call_id, '') is not null then
    NEW.order_id := NEW.ringba_call_id;
    return NEW;
  elsif nullif(NEW.calltools_call_id, '') is not null then
    NEW.order_id := NEW.calltools_call_id;
    return NEW;
  end if;

  -- 2) phone-fallback: phone10 = last 10 digits of caller_id, else the lead's phone
  select case
           when length(regexp_replace(coalesce(nullif(NEW.caller_id,''), nullif(l.phone,''), ''), '\D','','g')) >= 10
           then right(regexp_replace(coalesce(nullif(NEW.caller_id,''), nullif(l.phone,''), ''), '\D','','g'), 10)
           else null
         end
    into v_phone10
  from (select 1) _ left join public.leads l on l.id = NEW.lead_id;

  if v_phone10 is null then
    -- 3) no identifier at all -> id
    NEW.order_id := NEW.id::text;
    return NEW;
  end if;

  v_etdate := to_char(NEW.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD');

  -- rank among existing rows sharing (ET-date, phone10); new row is last => count+1
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
  'Sets order_id at insert (ringba -> calltools -> ET-date+phone+_B/_C rank -> id), '
  'mirroring v_offline_conversion_export so the stored value equals the old windowed one.';

drop trigger if exists trg_set_order_id on public.offline_conversion_events;
create trigger trg_set_order_id
  before insert on public.offline_conversion_events
  for each row execute function public.set_offline_conversion_order_id();
