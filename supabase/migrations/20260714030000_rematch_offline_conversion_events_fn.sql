-- Re-match backfill for offline_conversion_events (Ringba conversions).
--
-- The webhook stamps lead_id/transaction_id at ingestion time only. Events that
-- arrived before their lead existed (called first, submitted later), or that
-- came in without a transaction_id but whose caller phone is a known lead, stay
-- under-attributed. This function recovers that linkage after the fact.
--
-- SAFETY: attribution columns ONLY. It never touches status, uploaded_at,
-- last_upload_attempt_at, sheet_synced_at, google_* — so it can NOT cause a
-- re-upload to Google or a re-sync to the sheet. Idempotent: only fills columns
-- that are still empty; re-running is a no-op once everything is matched.

create or replace function public.rematch_offline_conversion_events()
returns TABLE(linked_by_phone integer, backfilled_from_lead integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_linked  integer := 0;
  v_filled  integer := 0;
begin
  -- 1. Link currently-unmatched NBA events to a lead by exact 10-digit phone.
  --    Newest lead for that phone wins (mirrors the webhook's ordering).
  with cand as (
    select oce.id,
           right(regexp_replace(coalesce(oce.caller_id, ''), '\D', '', 'g'), 10) as caller10
    from offline_conversion_events oce
    where oce.lead_id is null
      and oce.publisher = 'NBA'
  ),
  matched as (
    select c.id as event_id, l.*
    from cand c
    join lateral (
      select ld.*
      from leads ld
      where length(c.caller10) = 10
        and right(regexp_replace(coalesce(ld.phone, ''), '\D', '', 'g'), 10) = c.caller10
      order by ld.created_at desc
      limit 1
    ) l on true
  )
  update offline_conversion_events e
  set lead_id        = m.id,
      transaction_id = coalesce(nullif(btrim(e.transaction_id), ''), m.transaction_id),
      gclid          = coalesce(nullif(btrim(e.gclid), ''),  m.gclid),
      gbraid         = coalesce(nullif(btrim(e.gbraid), ''), m.gbraid),
      wbraid         = coalesce(nullif(btrim(e.wbraid), ''), m.wbraid),
      utm_source     = coalesce(e.utm_source,   m.utm_source),
      utm_medium     = coalesce(e.utm_medium,   m.utm_medium),
      utm_campaign   = coalesce(e.utm_campaign, m.utm_campaign),
      utm_content    = coalesce(e.utm_content,  m.utm_content),
      utm_term       = coalesce(e.utm_term,     m.utm_term),
      updated_at     = now()
  from matched m
  where e.id = m.event_id;
  get diagnostics v_linked = row_count;

  -- 2. For events already linked to a lead, backfill any still-missing
  --    transaction_id / click ids / UTMs from that lead.
  update offline_conversion_events e
  set transaction_id = coalesce(nullif(btrim(e.transaction_id), ''), l.transaction_id),
      gclid          = coalesce(nullif(btrim(e.gclid), ''),  l.gclid),
      gbraid         = coalesce(nullif(btrim(e.gbraid), ''), l.gbraid),
      wbraid         = coalesce(nullif(btrim(e.wbraid), ''), l.wbraid),
      utm_source     = coalesce(e.utm_source,   l.utm_source),
      utm_medium     = coalesce(e.utm_medium,   l.utm_medium),
      utm_campaign   = coalesce(e.utm_campaign, l.utm_campaign),
      utm_content    = coalesce(e.utm_content,  l.utm_content),
      utm_term       = coalesce(e.utm_term,     l.utm_term),
      updated_at     = now()
  from leads l
  where e.lead_id = l.id
    and (
      nullif(btrim(e.transaction_id), '') is null
      or (nullif(btrim(e.gclid), '') is null and nullif(btrim(l.gclid), '') is not null)
      or (e.utm_source is null and l.utm_source is not null)
    );
  get diagnostics v_filled = row_count;

  return query select v_linked, v_filled;
end;
$function$;

-- Keep it out of the public API surface.
revoke execute on function public.rematch_offline_conversion_events() from anon, authenticated;
