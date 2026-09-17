-- Owner 2026-09-17: match a postback only to a lead created in the 90 days before the call.
-- Why: Google rejects a conversion whose click is older than 90 days, and a lead that old is
-- stale attribution anyway. Measured before the change: 478 of 479 matches were already inside
-- the window (99%); 1 match used a gclid from a lead older than 90 days, which Google would
-- have rejected. Applied live 2026-09-17 (function + one re-match of existing rows).
create or replace function public.postback_find_lead(
  p_transaction_id text, p_gclid text, p_email text, p_phone text, p_at timestamptz,
  out lead_id uuid, out method text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  -- Google's click window. A lead older than this cannot supply a usable click id.
  v_oldest timestamptz := p_at - interval '90 days';
begin
  if nullif(p_transaction_id, '') is not null then
    select l.id into lead_id from leads l
      where l.transaction_id = p_transaction_id and l.created_at >= v_oldest;
    if lead_id is not null then method := 'transaction_id'; return; end if;
    select l.id into lead_id from leads l
      where l.caliber_lead_id = p_transaction_id and l.created_at >= v_oldest
      order by l.created_at desc limit 1;
    if lead_id is not null then method := 'caliber_lead_id'; return; end if;
  end if;

  if nullif(p_gclid, '') is not null then
    select l.id into lead_id from leads l where l.gclid = p_gclid and l.created_at >= v_oldest
      order by (l.created_at <= p_at + interval '1 hour') desc, l.created_at desc limit 1;
    if lead_id is not null then method := 'gclid'; return; end if;
  end if;

  if nullif(p_email, '') is not null then
    select l.id into lead_id from leads l
      where l.email in (p_email, lower(p_email)) and l.created_at >= v_oldest
      order by (l.created_at <= p_at + interval '1 hour') desc, l.created_at desc limit 1;
    if lead_id is not null then method := 'email'; return; end if;
  end if;

  if p_phone ~ '^[0-9]{10}$' then
    select l.id into lead_id from leads l
      where right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = p_phone
        and l.created_at >= v_oldest
      order by (l.created_at <= p_at + interval '1 hour') desc, l.created_at desc limit 1;
    if lead_id is not null then method := 'phone'; return; end if;
  end if;

  lead_id := null; method := null;
end;
$$;

revoke all on function public.postback_find_lead(text, text, text, text, timestamptz) from public, anon, authenticated;

update public.postbacks p
   set lead_id = m.lead_id,
       match_method = m.method,
       matched_at = case when m.lead_id is null then null else now() end
  from (
    select p2.id, f.lead_id, f.method
      from public.postbacks p2
      cross join lateral postback_find_lead(p2.transaction_id, p2.gclid, p2.email, p2.phone, p2.conversion_time) f
  ) m
 where p.id = m.id and p.lead_id is distinct from m.lead_id;
