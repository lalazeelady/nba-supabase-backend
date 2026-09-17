-- Dedupe (owner, 2026-09-17, business decision). Applied live the same day.
--
-- WHERE: at the upload only. `postbacks` still keeps every event Caliber sends, so
-- reconciliation shows received vs uploaded vs dropped-as-duplicate.
-- KEY: postbacks.call_key = calltools_call_id (one inbound call), else phone + ET day.
-- SCOPE: per conversion action. One caller with 3 calls in a day uploads 1 monetize and
-- 1 transfer conversion; a transfer and a monetize event for the same call still both upload,
-- because they are different Google actions.
-- The earliest event for a call_key wins; later ones are queued as skipped / duplicate_call.
--
-- NOTE on the ranking: a single INSERT ... SELECT cannot see the rows it is inserting, so the
-- queue must rank candidates inside the statement (row_number) AND check platform_uploads for
-- an earlier event queued by a previous run.

alter table public.postbacks add column call_key text;
comment on column public.postbacks.call_key is
  'Dedupe key for uploads: calltools_call_id when present, else phone + ET day. Set on insert.';

create or replace function public.postbacks_match_lead()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare m record;
begin
  if new.lead_id is null then
    select * into m from postback_find_lead(new.transaction_id, new.gclid, new.email, new.phone, new.conversion_time);
    if m.lead_id is not null then
      new.lead_id := m.lead_id; new.match_method := m.method; new.matched_at := now();
    end if;
  end if;
  new.call_key := coalesce(
    nullif(new.calltools_call_id, ''),
    nullif(new.phone, '') || ':' || to_char(new.conversion_time at time zone 'America/New_York', 'YYYY-MM-DD'));
  return new;
end;
$$;

update public.postbacks
   set call_key = coalesce(nullif(calltools_call_id, ''),
                           nullif(phone, '') || ':' || to_char(conversion_time at time zone 'America/New_York', 'YYYY-MM-DD'))
 where call_key is null;

create index postbacks_call_key_idx on public.postbacks (call_key);

create or replace function public.queue_platform_uploads()
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare n integer;
begin
  with candidate as (
    select v.postback_id, d.platform, a.action, p.call_key, p.conversion_time, p.id as pid,
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
             row_number() over (partition by c.call_key, c.platform, c.action
                                    order by c.conversion_time, c.pid)
           end as rn,
           (c.reason is null and c.call_key is not null and exists (
              select 1 from platform_uploads u2
                join postbacks p2 on p2.id = u2.postback_id
               where u2.platform = c.platform and u2.conversion_action = c.action
                 and u2.status in ('pending', 'sent')
                 and p2.call_key = c.call_key
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

-- Applied live: truncate platform_uploads + select queue_platform_uploads() to re-queue under
-- the new rule (nothing had been sent; only validate_only / dry-run checks had run).
