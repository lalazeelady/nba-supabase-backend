-- CONTRACT phase — DO NOT APPLY until everything writes conversion_call_id and nothing reads
-- ringba_call_id (i.e. after the new webhooks have been live and verified for a while).
--
-- Verify first:
--   select count(*) from public.offline_conversion_events
--   where conversion_call_id is null and ringba_call_id is not null;   -- expect 0
--
-- Then this removes the transition scaffolding: the sync trigger + the legacy column.
-- Left as a separate, un-applied file on purpose so the expand phase can bake in safely.

drop trigger if exists trg_00_sync_conversion_call_id on public.offline_conversion_events;
drop function if exists public.sync_conversion_call_id();
alter table public.offline_conversion_events drop column if exists ringba_call_id;
