-- Offline-CV accuracy, step 5: indexed exact-phone matcher for the webhooks.
--
-- The webhooks' phone fallback used `phone ILIKE '%<last10>%'`, an un-anchored substring
-- scan that can miss/mis-hit and isn't index-backed. This RPC does the SAME normalized
-- last-10-digit equality the re-match backfill uses, so it's exact and rides
-- idx_leads_phone_last10. Newest lead for that phone wins (mirrors prior ordering).
--
-- Returns the lead id (or null). SECURITY DEFINER + revoked from anon/authenticated so only
-- the service-role webhooks call it. Note: this hardens INGEST-time matching; the
-- rematch cron still catches conversions whose lead arrives AFTER ingest (timing), which no
-- ingest-time match can fix.

create or replace function public.match_lead_id_by_phone10(p10 text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select l.id
  from public.leads l
  where length(coalesce(p10,'')) = 10
    and right(regexp_replace(coalesce(l.phone,''), '\D','','g'), 10) = p10
  order by l.created_at desc
  limit 1;
$$;

revoke execute on function public.match_lead_id_by_phone10(text) from anon, authenticated;
grant execute on function public.match_lead_id_by_phone10(text) to service_role;
