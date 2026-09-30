-- Google monetize uploads moved to Caliber (owner, 2026-09-29 17:00 ET).
--
-- Caliber uploads paid calls to Google directly from 2026-09-29 17:00 ET. The Google cron
-- (upload-platform-conversions-15min) was paused at 17:00. Reconciled against Caliber's upload
-- log for 17:00-22:36: 223 of 228 paid calls matched on phone + amount + time ($2,899 of
-- $2,930); 5 Internet calls ($31) were not uploaded by Caliber.
--
-- Applied live on 2026-09-30 before this file (data only):
--   * Google monetize rows for calls >= 17:00 -> skipped 'uploaded_by_caliber' (223) or
--     'caliber_missed' (5).
--   * Google transfer rows whose phone Caliber uploaded a transfer for -> skipped
--     'uploaded_by_caliber' (215). The other 24 (no Caliber transfer for that phone) were sent
--     by us once as the cutover catch-up.
--   * Calls before 17:00 left pending at the pause (405 monetize, 536 transfers) were sent by
--     us on 2026-09-29.
--
-- This file: queue_platform_uploads() queues Google monetize rows for calls on/after the
-- cutover as skipped 'uploaded_by_caliber', so nothing new waits in the Google queue.
-- Google TRANSFER rows still queue as pending (owner decision on transfers is open); the
-- Google cron stays paused, so they are not sent. Bing is unchanged.

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
               -- Caliber uploads Google paid calls itself from the cutover on
               when d.platform = 'google' and a.action = 'monetize'
                    and v.conversion_time >= timestamptz '2026-09-29 17:00:00-04'            then 'uploaded_by_caliber'
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

-- Any Google monetize row queued between the data fix and this function change
update public.platform_uploads u
   set status = 'skipped', skip_reason = 'uploaded_by_caliber'
  from public.postbacks p
 where p.id = u.postback_id and u.platform = 'google' and u.conversion_action = 'monetize'
   and u.status = 'pending' and p.conversion_time >= timestamptz '2026-09-29 17:00:00-04';
