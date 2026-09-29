-- Upload every paid call: no dedupe (owner, 2026-09-29). Google and Bing.
--
-- Why: buyers are billed for every payout, including a second payout for the same person on
-- the same day. P50 billing on 9/25 ($3,102) and 9/28 ($4,542) is close to the pipeline
-- WITHOUT dedupe ($3,066 / $4,464) and far from it WITH dedupe ($2,952 / $4,284). The rest
-- of the gap is calls Caliber never posted back.
--
-- caliber_call_id is a true unique id per paid transfer: in the 2026-09-28 DNI test window
-- (315 postbacks, 341 webhook hits) no id was re-fired, shared between phones or offers, or
-- monetized twice. A real re-fire (same caliber_call_id + event) is still ignored at the
-- webhook by the unique index on postbacks, so removing the upload dedupe cannot double count.
--
-- 1. queue_platform_uploads(): the call_key ranking and 'duplicate_call' skip are removed.
--    Every other skip reason is unchanged (unknown_platform, transfer_counted_from_monetize,
--    too_old, zero_value, no_identifier). Bing rows already uploaded by hand are still
--    excluded by mark_bing_manual_uploads() before every Bing batch.
-- 2. Google order id = caliber_call_id. It was phone + offer + ET day (+ revenue) so our
--    uploads would collide with the legacy pipeline's; the legacy pipeline has sent no Caliber
--    call since the 2026-09-19 internet cutover (only Ringba, last on 2026-09-22), so that
--    reason is gone. Google rejects a second conversion with the same order id in the same
--    action regardless of time, so the composed id would block every repeat payout.
--    Rows already sent keep the id they were sent with. Bing needs no change: Microsoft
--    treats (click id, goal, conversion time) as one conversion.
-- 3. Backfill: rows skipped as duplicate_call for calls on/after 2026-09-20 ET go back to
--    pending. At the time of writing: Google 598 monetize ($5,190) + 767 transfers, Bing 63
--    monetize ($486) + 89 transfers, none older than 85 days.
--
-- postbacks.call_key is still set on insert but nothing reads it for uploads any more.

create or replace function public.queue_platform_uploads()
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare n integer;
begin
  insert into platform_uploads (postback_id, platform, conversion_action, status, skip_reason)
  select c.postback_id, c.platform, c.action,
         case when c.reason is null then 'pending' else 'skipped' end,
         c.reason
    from (
      select v.postback_id, d.platform, a.action,
             case
               when v.platform = 'unknown'                                                   then 'unknown_platform'
               when v.event_type = 'transfer' and coalesce(o.transfers_from_monetize, false) then 'transfer_counted_from_monetize'
               when v.conversion_time < now() - interval '85 days'                            then 'too_old'
               when a.action = 'monetize' and v.conversion_value <= 0                         then 'zero_value'
               when d.platform = 'google' and coalesce(v.gclid, v.gbraid, v.wbraid, v.email, v.phone) is null then 'no_identifier'
               when d.platform = 'bing'   and coalesce(v.msclkid, v.email, v.phone) is null              then 'no_identifier'
             end as reason
        from v_postbacks v
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
    ) c
  on conflict (postback_id, platform, conversion_action) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.queue_platform_uploads() from public, anon, authenticated;

create or replace view public.v_platform_uploads_pending with (security_invoker = true) as
 SELECT u.id AS upload_id,
    u.platform,
    u.conversion_action,
    u.attempts,
    u.validated_at,
    v.postback_id,
    v.event_type,
    v.offer,
    v.caliber_call_id,
    v.conversion_time,
    v.conversion_value,
    v.gclid,
    v.gbraid,
    v.wbraid,
    v.msclkid,
    v.email,
    v.phone,
    v.first_name,
    v.last_name,
    v.zip,
    v.platform AS attributed_platform,
    v.confidence,
    -- one paid transfer = one Caliber call id (the webhook rejects a postback without one)
    v.caliber_call_id AS order_id
   FROM platform_uploads u
     JOIN v_postbacks v ON v.postback_id = u.postback_id
  WHERE u.status = 'pending'::text;

revoke all on public.v_platform_uploads_pending from anon, authenticated;

update public.platform_uploads u
   set status = 'pending', skip_reason = null, last_result = null
  from public.postbacks p
 where p.id = u.postback_id
   and u.skip_reason = 'duplicate_call'
   and (p.conversion_time at time zone 'America/New_York')::date >= date '2026-09-20';
