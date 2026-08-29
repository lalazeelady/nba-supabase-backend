-- Offline-CV accuracy, step 1: introduce conversion_call_id ZERO-DOWNTIME (expand phase).
--
-- Rationale for the new field: `ringba_call_id` never held the ORIGINAL inbound call id — it
-- holds the id of the TRANSFERRED/CONVERTED call (Ringba 'RGB…' or Caliber id). One clearly
-- named field removes the confusion.
--
-- Why NOT a hard rename: the webhooks write this column on every live conversion. A rename would
-- break every in-flight insert in the gap between the DDL and the webhook redeploy, losing
-- conversions. Instead we EXPAND: add the new column, backfill it, and keep BOTH columns in sync
-- with a BEFORE-INSERT trigger so it doesn't matter whether the (old) deployed webhook writes
-- ringba_call_id or the (new) webhook writes conversion_call_id — both land populated, and every
-- trigger/view reads a consistent value throughout the switch. The old column is dropped later
-- in a CONTRACT migration (20260828120600) once nothing writes it.
--
-- The sync trigger is named trg_00_* so it fires BEFORE trg_set_order_id (Postgres runs
-- same-timing triggers alphabetically), guaranteeing order_id/derive see conversion_call_id set.

alter table public.offline_conversion_events
  add column if not exists conversion_call_id text;

-- Backfill existing rows (one-time; single-column update, index-light).
update public.offline_conversion_events
  set conversion_call_id = ringba_call_id
  where conversion_call_id is null and ringba_call_id is not null;

create index if not exists offline_conversion_events_conversion_call_id_idx
  on public.offline_conversion_events (conversion_call_id)
  where conversion_call_id is not null;

-- Keep ringba_call_id <-> conversion_call_id mirrored on insert during the transition.
create or replace function public.sync_conversion_call_id()
returns trigger
language plpgsql
as $$
begin
  if nullif(NEW.conversion_call_id,'') is null and nullif(NEW.ringba_call_id,'') is not null then
    NEW.conversion_call_id := NEW.ringba_call_id;
  elsif nullif(NEW.ringba_call_id,'') is null and nullif(NEW.conversion_call_id,'') is not null then
    NEW.ringba_call_id := NEW.conversion_call_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_00_sync_conversion_call_id on public.offline_conversion_events;
create trigger trg_00_sync_conversion_call_id
  before insert on public.offline_conversion_events
  for each row execute function public.sync_conversion_call_id();

comment on column public.offline_conversion_events.conversion_call_id is
  'Call id of the TRANSFERRED/CONVERTED call: Ringba (RGB…) or Caliber id. Canonical going '
  'forward; kept in sync with the legacy ringba_call_id until the contract migration drops it.';
