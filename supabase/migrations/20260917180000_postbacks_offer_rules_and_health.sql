-- Postback pipeline, owner decisions 2026-09-17:
--   * No deduping beyond "same Caliber call id + same event". Caliber decides what counts as a
--     conversion. A transfer and a monetize event for the same call are two uploads.
--   * Upload every attributed transfer and every attributed monetize event with revenue.
--     Unknown-source calls are NEVER uploaded (was a pending constant; now a fixed rule).
--   * Internet: gross transfers = gross monetized calls. Each monetized internet postback also
--     uploads as the transfer (CallXfer); an internet transfer postback, if one ever arrives, is
--     not uploaded. Other offers send their own transfer postbacks.
--   * Health-check alerts for the postback pipeline (postback_health now returns problems).
--
-- platform_uploads gains conversion_action, so one postback can have a monetize AND a
-- transfer upload per platform. Rows are recreated (no live sends have happened).

-- ---------------------------------------------------------------------------
-- offer_rules
-- ---------------------------------------------------------------------------
create table public.offer_rules (
  offer                   text primary key,
  transfers_from_monetize boolean not null default false,
  note                    text
);
comment on table public.offer_rules is
  'Per-offer upload rules. transfers_from_monetize: each monetized postback also uploads as the transfer (CallXfer); transfer postbacks for the offer do not upload.';
insert into public.offer_rules (offer, transfers_from_monetize, note)
values ('internet', true, 'Owner 2026-09-17: gross transfers = gross monetized calls');
alter table public.offer_rules enable row level security;
revoke all on table public.offer_rules from anon, authenticated;

-- ---------------------------------------------------------------------------
-- platform_uploads: one row per postback per platform per conversion action
-- ---------------------------------------------------------------------------
drop view public.v_recon_daily;
drop view public.v_platform_uploads_pending;
truncate public.platform_uploads;

alter table public.platform_uploads
  add column conversion_action text not null check (conversion_action in ('transfer', 'monetize'));
alter table public.platform_uploads drop constraint platform_uploads_postback_id_platform_key;
alter table public.platform_uploads add constraint platform_uploads_postback_platform_action_key
  unique (postback_id, platform, conversion_action);

comment on column public.platform_uploads.conversion_action is
  'Which Google/Bing conversion action this upload goes to: transfer (CallXfer) or monetize (CallConvertOffline). Usually equals the postback event_type; for offer_rules.transfers_from_monetize offers a monetize postback also gets a transfer row.';

create or replace function public.queue_platform_uploads()
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare n integer;
begin
  insert into platform_uploads (postback_id, platform, conversion_action, status, skip_reason)
  select v.postback_id, d.platform, a.action,
         case when r.reason is null then 'pending' else 'skipped' end,
         r.reason
    from v_postbacks v
    left join offer_rules o on o.offer = v.offer
    -- The upload(s) this postback produces.
    cross join lateral (
      select v.event_type as action
      union all
      select 'transfer' where v.event_type = 'monetize' and coalesce(o.transfers_from_monetize, false)
    ) a
    -- Where it goes. Unknown-source calls get a Google row marked skipped, so they stay visible.
    cross join lateral (
      select case when v.platform in ('google', 'bing') then v.platform
                  when v.platform = 'unknown'           then 'google'
             end as platform
    ) d
    cross join lateral (
      select case
        when v.platform = 'unknown'                                                     then 'unknown_platform'
        when v.event_type = 'transfer' and coalesce(o.transfers_from_monetize, false)   then 'transfer_counted_from_monetize'
        when v.conversion_time < now() - interval '85 days'                             then 'too_old'
        when a.action = 'monetize' and v.conversion_value <= 0                          then 'zero_value'
        when d.platform = 'google' and coalesce(v.gclid, v.gbraid, v.wbraid, v.email, v.phone) is null then 'no_identifier'
        when d.platform = 'bing'   and coalesce(v.msclkid, v.email, v.phone) is null               then 'no_identifier'
      end as reason
    ) r
   where d.platform is not null
     and v.received_at > now() - interval '85 days'
     and not exists (select 1 from platform_uploads u
                      where u.postback_id = v.postback_id and u.platform = d.platform and u.conversion_action = a.action)
  on conflict (postback_id, platform, conversion_action) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create view public.v_platform_uploads_pending with (security_invoker = true) as
select u.id as upload_id, u.platform, u.conversion_action, u.attempts, u.validated_at,
       v.postback_id, v.event_type, v.offer, v.caliber_call_id, v.conversion_time, v.conversion_value,
       v.gclid, v.gbraid, v.wbraid, v.msclkid,
       v.email, v.phone, v.first_name, v.last_name, v.zip,
       v.platform as attributed_platform, v.confidence
  from public.platform_uploads u
  join public.v_postbacks v on v.postback_id = u.postback_id
 where u.status = 'pending';
revoke all on public.v_platform_uploads_pending from anon, authenticated;

-- One row per ET day / offer / conversion action / platform / confidence.
-- conversion_action 'transfer' for internet is counted from monetized postbacks
-- (from_monetize = true); revenue is only shown on monetize rows.
create view public.v_recon_daily with (security_invoker = true) as
select v.conversion_date_et,
       v.offer,
       a.action                                                         as conversion_action,
       a.from_monetize,
       v.platform,
       v.confidence,
       count(*)                                                         as events,
       sum(case when a.action = 'monetize' then v.conversion_value else 0 end) as revenue,
       count(*) filter (where v.lead_id is not null)                    as matched_to_lead,
       count(u.id) filter (where u.status = 'sent')                     as uploaded_events,
       coalesce(sum(case when a.action = 'monetize' then v.conversion_value else 0 end)
                filter (where u.status = 'sent'), 0)                    as uploaded_revenue,
       count(u.id) filter (where u.status = 'pending')                  as pending_events,
       count(u.id) filter (where u.status = 'failed')                   as failed_events,
       count(u.id) filter (where u.status = 'skipped')                  as skipped_events,
       count(u.id) filter (where u.validated_at is not null)            as validated_events
  from public.v_postbacks v
  left join public.offer_rules o on o.offer = v.offer
  cross join lateral (
    select v.event_type as action, false as from_monetize
     where not (v.event_type = 'transfer' and coalesce(o.transfers_from_monetize, false))
    union all
    select 'transfer', true where v.event_type = 'monetize' and coalesce(o.transfers_from_monetize, false)
  ) a
  left join public.platform_uploads u
         on u.postback_id = v.postback_id
        and u.conversion_action = a.action
        and u.platform = case when v.platform in ('google', 'bing') then v.platform else 'google' end
 group by 1, 2, 3, 4, 5, 6;
revoke all on public.v_recon_daily from anon, authenticated;

-- ---------------------------------------------------------------------------
-- postback_health: numbers + problems for pipeline-health-check
-- ---------------------------------------------------------------------------
drop function public.postback_health();

create or replace function public.postback_health(p_uploads_live boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  et            timestamp := now() at time zone 'America/New_York';
  business_hrs  boolean   := extract(isodow from et) between 1 and 5 and extract(hour from et) between 10 and 19;
  m             jsonb;
  problems      text[]    := '{}';
begin
  select jsonb_build_object(
    'last_transfer_at',              (select max(received_at) from postbacks where event_type = 'transfer'),
    'last_monetize_at',              (select max(received_at) from postbacks where event_type = 'monetize'),
    'transfers_last_2h',             (select count(*) from postbacks where event_type = 'transfer' and received_at > now() - interval '2 hours'),
    'transfers_last_7d',             (select count(*) from postbacks where event_type = 'transfer' and received_at > now() - interval '7 days'),
    'monetize_last_2h',              (select count(*) from postbacks where event_type = 'monetize' and received_at > now() - interval '2 hours'),
    'rows_last_24h',                 (select count(*) from postbacks where received_at > now() - interval '24 hours'),
    'match_rate_last_24h',           (select round(avg((lead_id is not null)::int), 3) from postbacks where received_at > now() - interval '24 hours'),
    'rows_prior_7d',                 (select count(*) from postbacks where received_at between now() - interval '8 days' and now() - interval '24 hours'),
    'match_rate_prior_7d',           (select round(avg((lead_id is not null)::int), 3) from postbacks
                                       where received_at between now() - interval '8 days' and now() - interval '24 hours'),
    'upload_checks_failed_last_24h', (select count(*) from platform_uploads
                                       where validated_at > now() - interval '24 hours' and (last_result->>'ok') = 'false'),
    'uploads_failed_last_24h',       (select count(*) from platform_uploads where status = 'failed' and last_attempt_at > now() - interval '24 hours'),
    'uploads_pending_over_2h',       (select count(*) from platform_uploads where status = 'pending' and created_at < now() - interval '2 hours'),
    'business_hours',                business_hrs
  ) into m;

  if business_hrs and (m->>'monetize_last_2h')::int = 0 then
    problems := problems || 'No monetize postbacks in the last 2 hours (weekday business hours). Check the Caliber pixel and the postback-monetize-webhook logs for 401/422.';
  end if;
  if business_hrs and (m->>'transfers_last_7d')::int > 0 and (m->>'transfers_last_2h')::int = 0 then
    problems := problems || 'No transfer postbacks in the last 2 hours, but transfers arrived this week. Check the Caliber transfer pixel.';
  end if;
  if (m->>'rows_last_24h')::int >= 50 and (m->>'rows_prior_7d')::int >= 200
     and (m->>'match_rate_last_24h')::numeric < (m->>'match_rate_prior_7d')::numeric - 0.15 then
    problems := problems || format('Lead match rate dropped: %s in the last 24h vs %s the prior 7 days. Check transaction_id / email / phone values from Caliber.',
                                   m->>'match_rate_last_24h', m->>'match_rate_prior_7d');
  end if;
  if (m->>'upload_checks_failed_last_24h')::int > 0 then
    problems := problems || format('%s upload check(s) failed in the last 24h (validate_only / dry run). See platform_uploads.last_result.', m->>'upload_checks_failed_last_24h');
  end if;
  if (m->>'uploads_failed_last_24h')::int > 0 then
    problems := problems || format('%s upload(s) FAILED in the last 24h. See platform_uploads.last_result.', m->>'uploads_failed_last_24h');
  end if;
  if p_uploads_live and (m->>'uploads_pending_over_2h')::int > 0 then
    problems := problems || format('%s upload(s) pending for over 2 hours while uploads are live. Is the uploader running?', m->>'uploads_pending_over_2h');
  end if;

  return m || jsonb_build_object('checked_at', now(), 'problems', to_jsonb(problems));
end;
$$;

revoke all on function public.queue_platform_uploads()        from public, anon, authenticated;
revoke all on function public.postback_health(boolean)        from public, anon, authenticated;
