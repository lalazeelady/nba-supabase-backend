-- Lead match: never match a call to a lead created after it (2026-09-27).
-- Cause of the hourly "N upload(s) FAILED" health email: gclid / email / phone matches
-- preferred an earlier lead but fell back to a later one, and the hourly rematch attached
-- leads filled in days after the call. Microsoft rejected those Bing uploads
-- (ConversionTimeEarlierThanClickTime). 65 postbacks were affected (4 already sent to Google,
-- 1 to Bing; those stay sent). Fix: accept only leads created up to 1h after the call;
-- re-match the 65; the 8 rejected Bing rows become skipped / 'lead_after_call'.
CREATE OR REPLACE FUNCTION public.postback_find_lead(p_transaction_id text, p_gclid text, p_email text, p_phone text, p_at timestamp with time zone, OUT lead_id uuid, OUT method text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  -- Google's click window. A lead older than this cannot supply a usable click id.
  v_oldest timestamptz := p_at - interval '90 days';
  -- A call cannot come from a lead filled in after it. gclid / email / phone matches only
  -- accept leads created before the call (1h allowance for clock skew). Before 2026-09-27 a
  -- later lead was used when no earlier one existed, and Microsoft rejected those uploads
  -- (ConversionTimeEarlierThanClickTime). transaction_id is an exact match and is unchanged.
  v_latest timestamptz := p_at + interval '1 hour';
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
    select l.id into lead_id from leads l
      where l.gclid = p_gclid and l.created_at between v_oldest and v_latest
      order by l.created_at desc limit 1;
    if lead_id is not null then method := 'gclid'; return; end if;
  end if;

  if nullif(p_email, '') is not null then
    select l.id into lead_id from leads l
      where l.email in (p_email, lower(p_email)) and l.created_at between v_oldest and v_latest
      order by l.created_at desc limit 1;
    if lead_id is not null then method := 'email'; return; end if;
  end if;

  if p_phone ~ '^[0-9]{10}$' then
    select l.id into lead_id from leads l
      where right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = p_phone
        and l.created_at between v_oldest and v_latest
      order by l.created_at desc limit 1;
    if lead_id is not null then method := 'phone'; return; end if;
  end if;

  lead_id := null; method := null;
end;
$function$;

-- The 8 Bing rows Microsoft rejected were never valid conversions: not failures to alert on.
update public.platform_uploads u
   set status = 'skipped', skip_reason = 'lead_after_call'
  from public.postbacks p join public.leads l on l.id = p.lead_id
 where p.id = u.postback_id and u.status = 'failed'
   and l.created_at > p.conversion_time + interval '1 hour';

-- Re-match the 65 postbacks tied to a later lead under the new rule (earlier lead, or none).
update public.postbacks p
   set (lead_id, match_method) = (select f.lead_id, f.method
                                    from public.postback_find_lead(p.transaction_id, p.gclid, p.email, p.phone, p.conversion_time) f),
       matched_at = now()
  from public.leads l
 where l.id = p.lead_id and p.match_method <> 'transaction_id'
   and l.created_at > p.conversion_time + interval '1 hour';
