-- Owner 2026-09-17: dedupe WITHIN the offer. If a caller monetizes Internet and Energy on the
-- same day, both upload; only a repeat of the same offer for the same call is dropped.
-- (With calltools_call_id the key is already one call, so the offer changes nothing there; it
-- matters for the phone + ET day fallback.) Applied live the same day.
create or replace function public.queue_platform_uploads()
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare n integer;
begin
  with candidate as (
    select v.postback_id, d.platform, a.action, p.call_key, coalesce(v.offer, '(none)') as offer_key,
           p.conversion_time, p.id as pid,
           case
             when v.platform = 'unknown'                                                   then 'unknown_platform'
             when v.event_type = 'transfer' and coalesce(o.transfers_from_monetize, false) then 'transfer_counted_from_monetize'
             when v.conversion_time < now() - interval '85 days'                            then 'too_old'
             when a.action = 'monetize' and v.conversion_value <= 0                         then 'zero_value'
             when d.platform = 'google' and coalesce(v.gclid, v.gbraid, v.wbraid, v.email, v.phone) is null then 'no_identifier'
             when d.platform = 'bing'   and coalesce(v.msclkid, v.email, v.phone) is null              then 'no_identifier'
           end as reason
      from v_postbacks v
      join postbacks p on p.id = v.postback_id
      left join offer_rules o on o.offer = v.offer
      cross join lateral (
        select v.event_type as action
        union all
        select 'transfer' where v.event_type = 'monetize' and coalesce(o.transfers_from_monetize, false)
      ) a
      cross join lateral (
        select case when v.platform in ('google', 'bing') then v.platform
                    when v.platform = 'unknown'           then 'google'
               end as platform
      ) d
     where d.platform is not null
       and v.received_at > now() - interval '85 days'
       and not exists (select 1 from platform_uploads u
                        where u.postback_id = v.postback_id and u.platform = d.platform
                          and u.conversion_action = a.action)
  ),
  ranked as (
    select c.*,
           case when c.reason is null and c.call_key is not null then
             row_number() over (partition by c.call_key, c.offer_key, c.platform, c.action
                                    order by c.conversion_time, c.pid)
           end as rn,
           (c.reason is null and c.call_key is not null and exists (
              select 1 from platform_uploads u2
                join postbacks p2 on p2.id = u2.postback_id
               where u2.platform = c.platform and u2.conversion_action = c.action
                 and u2.status in ('pending', 'sent')
                 and p2.call_key = c.call_key
                 and coalesce(p2.offer, '(none)') = c.offer_key
                 and (p2.conversion_time, p2.id) < (c.conversion_time, c.pid))) as queued_before
      from candidate c
  )
  insert into platform_uploads (postback_id, platform, conversion_action, status, skip_reason)
  select postback_id, platform, action,
         case when final_reason is null then 'pending' else 'skipped' end,
         final_reason
    from (select r.*, coalesce(r.reason, case when r.rn > 1 or r.queued_before then 'duplicate_call' end) as final_reason
            from ranked r) x
  on conflict (postback_id, platform, conversion_action) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.queue_platform_uploads() from public, anon, authenticated;

-- Applied live: truncate platform_uploads + select queue_platform_uploads() to re-queue.
