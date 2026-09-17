-- Postback pipeline redesign (owner approved 2026-09-17).
--
-- One master table for Caliber postbacks, one place to look (v_postbacks), one upload
-- queue per platform, and a daily reconciliation view. Replaces the test table
-- postback_events (moved + dropped in the next migration). NOTHING here touches the
-- legacy pipeline: offline_conversion_events, its views/triggers, the Ringba webhooks,
-- the Google uploader and Customer Match are unchanged.
--
--   postbacks            one row per Caliber call event, only the fields that identify
--                        and route the call. Lead detail (names, zip, UTMs 2-5, landing
--                        page, IP, user agent) is read from leads through lead_id.
--   ib_source_platforms  editable map: inbound route name -> platform.
--   platform_uploads     one row per postback per platform (google, bing): the only
--                        record of what was sent, skipped or failed.
--   v_postbacks          postback + lead + platform attribution.
--   v_recon_daily        revenue and counts by day / offer / event / platform /
--                        confidence, next to what was uploaded.
--   v_call_through_daily leads vs calls by lead day and platform.

-- ---------------------------------------------------------------------------
-- postbacks
-- ---------------------------------------------------------------------------
create table public.postbacks (
  id                uuid primary key default gen_random_uuid(),
  received_at       timestamptz not null default now(),
  cv_source         text not null default 'caliber' check (cv_source in ('caliber')),
  -- Set by the endpoint the pixel calls, not by the sender.
  event_type        text not null check (event_type in ('transfer', 'monetize')),
  -- Normalized: lower case, 'CPN_' prefix removed ('CPN_INTERNET' -> 'internet').
  offer             text,
  conversion_time   timestamptz not null,
  conversion_value  numeric(12,2) not null default 0 check (conversion_value >= 0),
  -- Caliber's call id. Must-have; with event_type it is the dedupe key and the order id
  -- sent to Google.
  caliber_call_id   text not null check (caliber_call_id <> ''),
  calltools_call_id text,
  -- As sent by Caliber. Should be OUR leads.transaction_id; Caliber currently sends its
  -- own lead id, which the matcher also accepts (leads.caliber_lead_id).
  transaction_id    text,
  phone             text check (phone ~ '^[0-9]{10}$'),
  email             text,
  state             text,
  gclid             text,
  gbraid            text,
  wbraid            text,
  msclkid           text,
  fbclid            text,
  oppref            text,
  utm_source        text,
  ib_source         text,
  -- Filled on insert by postbacks_match_lead(); rematched hourly for 7 days.
  lead_id           uuid references public.leads(id) on delete set null,
  match_method      text check (match_method in ('transaction_id', 'caliber_lead_id', 'gclid', 'email', 'phone')),
  matched_at        timestamptz,
  -- The exact payload, secret removed. api_logs no longer keeps a second copy.
  raw_payload       jsonb not null default '{}'::jsonb,
  unique (caliber_call_id, event_type)
);

comment on table public.postbacks is
  'Master table: one row per Caliber postback (transfer / monetize). Lead detail comes from leads via lead_id. Look things up in v_postbacks.';

create index postbacks_conversion_time_idx   on public.postbacks (conversion_time);
create index postbacks_phone_idx             on public.postbacks (phone);
create index postbacks_email_idx             on public.postbacks (email);
create index postbacks_transaction_id_idx    on public.postbacks (transaction_id);
create index postbacks_calltools_call_id_idx on public.postbacks (calltools_call_id) where calltools_call_id is not null;
create index postbacks_lead_id_idx           on public.postbacks (lead_id);
create index postbacks_unmatched_idx         on public.postbacks (received_at) where lead_id is null;

alter table public.postbacks enable row level security;
revoke all on table public.postbacks from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lead matching
-- ---------------------------------------------------------------------------
-- Order: our transaction_id, Caliber's lead id, gclid, email, phone. For the fuzzy
-- keys the newest lead created before the call (1h slack) wins, else the newest.
create or replace function public.postback_find_lead(
  p_transaction_id text, p_gclid text, p_email text, p_phone text, p_at timestamptz,
  out lead_id uuid, out method text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if nullif(p_transaction_id, '') is not null then
    select l.id into lead_id from leads l where l.transaction_id = p_transaction_id;
    if lead_id is not null then method := 'transaction_id'; return; end if;
    select l.id into lead_id from leads l where l.caliber_lead_id = p_transaction_id
      order by l.created_at desc limit 1;
    if lead_id is not null then method := 'caliber_lead_id'; return; end if;
  end if;

  if nullif(p_gclid, '') is not null then
    select l.id into lead_id from leads l where l.gclid = p_gclid
      order by (l.created_at <= p_at + interval '1 hour') desc, l.created_at desc limit 1;
    if lead_id is not null then method := 'gclid'; return; end if;
  end if;

  if nullif(p_email, '') is not null then
    select l.id into lead_id from leads l where l.email in (p_email, lower(p_email))
      order by (l.created_at <= p_at + interval '1 hour') desc, l.created_at desc limit 1;
    if lead_id is not null then method := 'email'; return; end if;
  end if;

  if p_phone ~ '^[0-9]{10}$' then
    -- Expression matches idx_leads_phone_last10.
    select l.id into lead_id from leads l
      where right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = p_phone
      order by (l.created_at <= p_at + interval '1 hour') desc, l.created_at desc limit 1;
    if lead_id is not null then method := 'phone'; return; end if;
  end if;

  lead_id := null; method := null;
end;
$$;

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
  return new;
end;
$$;

create trigger postbacks_match_lead before insert on public.postbacks
  for each row execute function public.postbacks_match_lead();

-- A lead can arrive after its call (or be saved late). Retry unmatched rows for 7 days.
create or replace function public.rematch_postbacks(p_days integer default 7)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare n integer;
begin
  update postbacks p
     set lead_id = m.lead_id, match_method = m.method, matched_at = now()
    from (
      select p2.id, f.lead_id, f.method
        from postbacks p2
        cross join lateral postback_find_lead(p2.transaction_id, p2.gclid, p2.email, p2.phone, p2.conversion_time) f
       where p2.lead_id is null and p2.received_at > now() - make_interval(days => p_days)
    ) m
   where p.id = m.id and m.lead_id is not null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Inbound route -> platform (edit freely; a route not listed is 'unknown')
-- ---------------------------------------------------------------------------
create table public.ib_source_platforms (
  ib_source text primary key,
  platform  text not null check (platform in ('google', 'bing', 'meta', 'openai', 'owned')),
  note      text
);
comment on table public.ib_source_platforms is
  'Inbound call route name -> platform. Used only when the call has no click id and no utm_source. owned = our own email/SMS. Unlisted routes are unknown.';

insert into public.ib_source_platforms (ib_source, platform, note) values
  ('NBA_ThankYou',             'google', 'Google funnel thank-you line'),
  ('NBA_Funnel',               'google', 'Google funnel header line'),
  ('NBA_InactivityPopup',      'google', 'Google funnel popup line'),
  ('NBA_ThankYou Bing',        'bing',   null),
  ('NBA_Funnel Bing',          'bing',   null),
  ('NBA_InactivityPopup Bing', 'bing',   null),
  ('NBA_ThankYou Meta',        'meta',   null),
  ('nba-meta',                 'meta',   null),
  ('nba-meta-optin-thankyou',  'meta',   null),
  ('nba-meta-optin-funnel',    'meta',   null),
  ('NBA_10DLC',                'owned',  'SMS'),
  ('NBA_SMSShortCode',         'owned',  'SMS'),
  ('NBA_InboundSMS',           'owned',  'SMS'),
  ('NBA_Day1FirstEmail',       'owned',  'email'),
  ('NBA_Day1SecondEmail',      'owned',  'email'),
  ('NBA_Day1ThirdEmail',       'owned',  'email'),
  ('NBA_Day2FirstEmail',       'owned',  'email');

alter table public.ib_source_platforms enable row level security;
revoke all on table public.ib_source_platforms from anon, authenticated;

-- ---------------------------------------------------------------------------
-- v_postbacks: the one place to look
-- ---------------------------------------------------------------------------
-- Postback values win; the lead fills gaps. Attribution, first match wins:
--   click id                         -> confidence 'absolute'
--   utm_source (postback, then lead) -> 'confident'
--   ib_source route map              -> 'confident'
--   otherwise                        -> platform 'unknown', confidence 'unknown'
create view public.v_postbacks with (security_invoker = true) as
select
  p.id                                                   as postback_id,
  p.received_at,
  (p.conversion_time at time zone 'America/New_York')::date as conversion_date_et,
  p.conversion_time,
  p.cv_source,
  p.event_type,
  p.offer,
  p.conversion_value,
  p.caliber_call_id,
  p.calltools_call_id,
  p.transaction_id,
  p.lead_id,
  p.match_method,
  l.transaction_id                                       as lead_transaction_id,
  l.caliber_lead_id                                      as lead_caliber_lead_id,
  l.crm_lead_id                                          as lead_calltools_contact_id,
  l.created_at                                           as lead_created_at,
  coalesce(p.phone, nullif(right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10), '')) as phone,
  coalesce(p.email, nullif(l.email, ''))                 as email,
  coalesce(p.state, nullif(l.state, ''))                 as state,
  l.first_name, l.last_name, l.street_address, l.city, l.zip, l.ip_address, l.user_agent,
  k.gclid, k.gbraid, k.wbraid, k.msclkid, k.fbclid, k.oppref,
  k.utm_source,
  l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.landing_page,
  p.ib_source,
  ibp.platform                                           as ib_source_platform,
  split_part(a.pa, '|', 1)                               as platform,
  split_part(a.pa, '|', 2)                               as attribution,
  case split_part(a.pa, '|', 2)
    when 'click_id' then 'absolute'
    when 'none'     then 'unknown'
    else 'confident'
  end                                                    as confidence
from public.postbacks p
left join public.leads l on l.id = p.lead_id
left join public.ib_source_platforms ibp on ibp.ib_source = p.ib_source
cross join lateral (
  select
    coalesce(p.gclid,   nullif(l.gclid, ''))   as gclid,
    coalesce(p.gbraid,  nullif(l.gbraid, ''))  as gbraid,
    coalesce(p.wbraid,  nullif(l.wbraid, ''))  as wbraid,
    coalesce(p.msclkid, nullif(l.msclkid, '')) as msclkid,
    coalesce(p.fbclid,  nullif(l.fbclid, ''))  as fbclid,
    coalesce(p.oppref,  nullif(l.oppref, ''))  as oppref,
    coalesce(p.utm_source, nullif(l.utm_source, '')) as utm_source
) k
cross join lateral (
  select case
    when coalesce(k.gclid, k.gbraid, k.wbraid) is not null            then 'google|click_id'
    when k.msclkid is not null                                         then 'bing|click_id'
    when k.fbclid is not null                                          then 'meta|click_id'
    when k.oppref is not null                                          then 'openai|click_id'
    when k.utm_source ~* '^(google|youtube|adwords)'                   then 'google|utm_source'
    when k.utm_source ~* '(bing|microsoft)'                            then 'bing|utm_source'
    when k.utm_source ~* '(meta|facebook|instagram|^fb$)'              then 'meta|utm_source'
    when k.utm_source ~* '(openai|chatgpt)'                            then 'openai|utm_source'
    when ibp.platform is not null                                      then ibp.platform || '|ib_source'
    else 'unknown|none'
  end as pa
) a;

revoke all on public.v_postbacks from anon, authenticated;

-- ---------------------------------------------------------------------------
-- platform_uploads: the upload queue and its record
-- ---------------------------------------------------------------------------
create table public.platform_uploads (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  postback_id     uuid not null references public.postbacks(id) on delete cascade,
  platform        text not null check (platform in ('google', 'bing')),
  -- pending: waiting to send | sent: accepted by the platform | failed: rejected or out
  -- of retries | skipped: not eligible (see skip_reason). A validate_only / dry_run
  -- check does NOT change status; it sets validated_at and last_result.
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  skip_reason     text,
  attempts        integer not null default 0,
  last_attempt_at timestamptz,
  validated_at    timestamptz,
  sent_at         timestamptz,
  last_result     jsonb,
  unique (postback_id, platform)
);
create index platform_uploads_open_idx on public.platform_uploads (platform, created_at) where status = 'pending';

alter table public.platform_uploads enable row level security;
revoke all on table public.platform_uploads from anon, authenticated;

-- Adds one row per new postback: to its platform (google / bing), or a 'skipped' row
-- that says why it will not upload. Safe to run any time; never re-queues a row.
create or replace function public.queue_platform_uploads()
returns integer language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  -- OWNER DECISION PENDING (2026-09-17): upload calls with no known platform to Google?
  -- false = queue them for Google as skipped / unknown_platform. true = queue as pending.
  c_google_include_unknown constant boolean := false;
  n integer;
begin
  insert into platform_uploads (postback_id, platform, status, skip_reason)
  select v.postback_id, d.platform,
         case when r.reason is null then 'pending' else 'skipped' end,
         r.reason
    from v_postbacks v
    cross join lateral (
      select case when v.platform in ('google', 'bing') then v.platform
                  when v.platform = 'unknown'           then 'google'
             end as platform
    ) d
    cross join lateral (
      select case
        when v.platform = 'unknown' and not c_google_include_unknown             then 'unknown_platform'
        when v.conversion_time < now() - interval '85 days'                      then 'too_old'
        when v.event_type = 'monetize' and v.conversion_value <= 0               then 'zero_value'
        when d.platform = 'google' and coalesce(v.gclid, v.gbraid, v.wbraid, v.email, v.phone) is null then 'no_identifier'
        when d.platform = 'bing'   and coalesce(v.msclkid, v.email, v.phone) is null               then 'no_identifier'
      end as reason
    ) r
   where d.platform is not null
     and v.received_at > now() - interval '85 days'
     and not exists (select 1 from platform_uploads u
                      where u.postback_id = v.postback_id and u.platform = d.platform)
  on conflict (postback_id, platform) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- What the uploader reads: pending rows with everything needed to build the event.
create view public.v_platform_uploads_pending with (security_invoker = true) as
select u.id as upload_id, u.platform, u.attempts, u.validated_at,
       v.postback_id, v.event_type, v.offer, v.caliber_call_id, v.conversion_time, v.conversion_value,
       v.gclid, v.gbraid, v.wbraid, v.msclkid,
       v.email, v.phone, v.first_name, v.last_name, v.zip,
       v.platform as attributed_platform, v.confidence
  from public.platform_uploads u
  join public.v_postbacks v on v.postback_id = u.postback_id
 where u.status = 'pending';

revoke all on public.v_platform_uploads_pending from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------
-- One row per ET day / offer / event / platform / confidence. Unknown-platform rows
-- show their Google queue row (skipped until the owner decides otherwise).
create view public.v_recon_daily with (security_invoker = true) as
select v.conversion_date_et,
       v.offer,
       v.event_type,
       v.platform,
       v.confidence,
       count(*)                                                         as events,
       sum(v.conversion_value)                                          as revenue,
       count(*) filter (where v.lead_id is not null)                    as matched_to_lead,
       count(u.id) filter (where u.status = 'sent')                     as uploaded_events,
       coalesce(sum(v.conversion_value) filter (where u.status = 'sent'), 0) as uploaded_revenue,
       count(u.id) filter (where u.status = 'pending')                  as pending_events,
       count(u.id) filter (where u.status = 'failed')                   as failed_events,
       count(u.id) filter (where u.status = 'skipped')                  as skipped_events,
       count(u.id) filter (where u.validated_at is not null)            as validated_events
  from public.v_postbacks v
  left join public.platform_uploads u
         on u.postback_id = v.postback_id
        and u.platform = case when v.platform in ('google', 'bing') then v.platform else 'google' end
 group by 1, 2, 3, 4, 5;

revoke all on public.v_recon_daily from anon, authenticated;

-- Leads vs calls, by the day the lead was created and the lead's platform.
-- Always filter on lead_date_et (index leads(created_at)).
create view public.v_call_through_daily with (security_invoker = true) as
with lead_days as (
  select l.id,
         (l.created_at at time zone 'America/New_York')::date as lead_date_et,
         case
           when coalesce(nullif(l.gclid, ''), nullif(l.gbraid, ''), nullif(l.wbraid, '')) is not null
             or l.utm_source ~* '^(google|youtube|adwords)'           then 'google'
           when nullif(l.msclkid, '') is not null
             or l.utm_source ~* '(bing|microsoft)'                    then 'bing'
           when nullif(l.fbclid, '') is not null
             or l.utm_source ~* '(meta|facebook|instagram|^fb$)'      then 'meta'
           when nullif(l.oppref, '') is not null
             or l.utm_source ~* '(openai|chatgpt)'                    then 'openai'
           else 'unknown'
         end as platform
    from public.leads l
)
select d.lead_date_et,
       d.platform,
       count(distinct d.id)                                                   as leads,
       count(distinct p.lead_id) filter (where p.event_type = 'transfer')     as leads_transferred,
       count(distinct p.lead_id) filter (where p.event_type = 'monetize')     as leads_monetized,
       round(100.0 * count(distinct p.lead_id) filter (where p.event_type = 'transfer')
             / nullif(count(distinct d.id), 0), 2)                            as transfer_rate_pct,
       round(100.0 * count(distinct p.lead_id) filter (where p.event_type = 'monetize')
             / nullif(count(distinct d.id), 0), 2)                            as monetize_rate_pct,
       coalesce(sum(p.conversion_value) filter (where p.event_type = 'monetize'), 0) as revenue
  from lead_days d
  left join public.postbacks p on p.lead_id = d.id
 group by 1, 2;

revoke all on public.v_call_through_daily from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Health numbers for the (not yet enabled) alerts
-- ---------------------------------------------------------------------------
create or replace function public.postback_health()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'checked_at',              now(),
    'last_transfer_at',        (select max(received_at) from postbacks where event_type = 'transfer'),
    'last_monetize_at',        (select max(received_at) from postbacks where event_type = 'monetize'),
    'transfers_last_2h',       (select count(*) from postbacks where event_type = 'transfer' and received_at > now() - interval '2 hours'),
    'monetize_last_2h',        (select count(*) from postbacks where event_type = 'monetize' and received_at > now() - interval '2 hours'),
    'match_rate_last_24h',     (select round(avg((lead_id is not null)::int), 3) from postbacks where received_at > now() - interval '24 hours'),
    'match_rate_prior_7d',     (select round(avg((lead_id is not null)::int), 3) from postbacks
                                 where received_at between now() - interval '8 days' and now() - interval '24 hours'),
    'uploads_pending_over_2h', (select count(*) from platform_uploads where status = 'pending' and created_at < now() - interval '2 hours'),
    'uploads_failed_last_24h', (select count(*) from platform_uploads where status = 'failed' and last_attempt_at > now() - interval '24 hours'),
    'yesterday_by_platform',   (select coalesce(jsonb_object_agg(platform, x), '{}'::jsonb) from (
                                  select u.platform,
                                         jsonb_build_object(
                                           'eligible_revenue', coalesce(sum(v.conversion_value) filter (where u.status <> 'skipped'), 0),
                                           'uploaded_revenue', coalesce(sum(v.conversion_value) filter (where u.status = 'sent'), 0)) as x
                                    from platform_uploads u
                                    join v_postbacks v on v.postback_id = u.postback_id
                                   where v.conversion_date_et = (now() at time zone 'America/New_York')::date - 1
                                   group by u.platform) t)
  );
$$;

revoke all on function public.postback_find_lead(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.rematch_postbacks(integer)  from public, anon, authenticated;
revoke all on function public.queue_platform_uploads()    from public, anon, authenticated;
revoke all on function public.postback_health()           from public, anon, authenticated;
