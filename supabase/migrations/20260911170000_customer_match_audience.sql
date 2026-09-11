-- Google Ads Customer Match — audience pipeline
--
-- Replaces the manual "NBA Google Customer Match" Google Sheet (plaintext PII in
-- Drive, last edited 2026-08-11) with an API path that mirrors the offline-conversion
-- uploader: Supabase -> edge function -> Google Data Manager API.
--
-- MEMBERSHIP: every monetized call with revenue, from EVERY source.
--   Deliberately NOT the offline-conversion rule. `v_offline_conversion_export`
--   applies a Google/YouTube source deny-list, because a conversion may only be
--   reported to the channel that earned it. An audience has no such constraint — a
--   customer is a customer whichever channel produced them — so this path reads
--   `offline_conversion_events` directly and applies NO source filter. Changing the
--   deny-list cannot affect this pipeline, and vice versa.
--
-- WHY A MATERIALIZED VIEW (this is load-bearing, do not "simplify" it to a view):
--   The person-level rollup aggregates ~72,000 events and joins ~160,000 leads. On
--   this instance it measures 14.7s WARM. `service_role` carries an 8s
--   statement_timeout (migration 20260821000300), so an uploader reading a plain view
--   would time out on EVERY run — and silently, because pg_cron's net.http_post only
--   dispatches and never sees the response. That is the Aug-2026 silent outage
--   exactly. So the rollup runs ONCE per day inside refresh_customer_match_members(),
--   which carries its own raised statement_timeout, and the uploader only ever does
--   indexed lookups against the stored result.
--   Bonus: ad-hoc queries against the master are instant instead of 15 seconds.
--
-- NORMALIZATION RULE: keys are normalized in SQL (a member key must be stable or the
--   same person is uploaded twice). Attributes are normalized in TypeScript, next to
--   the hashing that consumes them — so the master carries RAW, human-readable
--   email/name/zip, which is what makes it useful to export.
--
-- Purely additive. No existing object is altered or dropped.

-- ---------------------------------------------------------------------------
-- 1. Normalizers
-- ---------------------------------------------------------------------------

-- NANP 10-digit key, or NULL. NULL means "cannot identify this caller"; those rows
-- are dropped rather than given an invented key.
-- IMMUTABLE so it can back an expression index.
create or replace function public.cm_phone10(raw text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when digits is null                                then null
    when length(digits) = 10                           then digits
    when length(digits) = 11 and left(digits, 1) = '1' then right(digits, 10)
    else null
  end
  from (select nullif(regexp_replace(coalesce(raw, ''), '\D', '', 'g'), '') as digits) d;
$$;

comment on function public.cm_phone10(text) is
  'Normalize any phone format to a bare NANP 10-digit string; NULL if not NANP. The Customer Match member key.';

-- Program / buyer slug.
--
-- Reads `offline_conversion_events.offer` ONLY. As of Sep 2026 that column is
-- populated on 0 of 71,936 monetized calls — no pixel sends it — so every caller
-- resolves to 'unknown' and lands in the universal audience alone. That is the
-- intended behaviour today.
--
-- `ib_source` is deliberately NOT a fallback (owner's call, Sep 2026). It names the
-- phone LINE dialled, not the buyer, so mapping it would place people in a buyer's
-- audience on a guess. Only 'nba-internet-calls' names a program at all.
--
-- When a pixel starts sending `offer`, new calls resolve to a real slug with no code
-- change. Historical calls can never be backfilled — nothing in the data identifies
-- the buyer — so they stay 'unknown' permanently.
create or replace function public.cm_program(p_offer text)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(
    nullif(regexp_replace(lower(btrim(coalesce(p_offer, ''))), '[^a-z0-9]+', '_', 'g'), ''),
    'unknown'
  );
$$;

comment on function public.cm_program(text) is
  'Map offline_conversion_events.offer to an audience slug; ''unknown'' when the buyer is not recorded. Does not read ib_source - see migration header.';

-- ---------------------------------------------------------------------------
-- 2. Supporting indexes
-- ---------------------------------------------------------------------------
-- The monetized working set. Without this the rollup seq-scans 109k rows (7.9s).
-- Predicate uses `conversion_value > 0` (not coalesce) so the planner can prove a
-- match: NULL > 0 is already false, so the two are equivalent, but only this form
-- is indexable.
create index if not exists offline_cv_monetized_time_idx
  on public.offline_conversion_events (conversion_time)
  where event_type = 'call_converted_revenue' and conversion_value > 0;

comment on index public.offline_cv_monetized_time_idx is
  'Customer Match rollup working set. Keep the predicate in step with mv_monetized_callers.';

-- ---------------------------------------------------------------------------
-- 3. mv_monetized_callers — the person-level MASTER
-- ---------------------------------------------------------------------------
--
-- One row per caller who has ever monetized. THIS is the object to query or export
-- for any ad-hoc question: "all ACA callers in Q3", "everyone worth over $200".
-- It knows nothing about Google Ads, so it stays useful no matter what happens to
-- the audiences downstream.
--
-- Identity vs profile — the two halves are sourced differently, on purpose:
--   phone  from the PIXEL first (`caller_id` is the number that actually dialled,
--          which is what makes someone a member), falling back to the lead.
--   email / name / zip / state from `leads` first, falling back to the pixel.
--          DECISIONS.md makes `leads` canonical, it is server-validated before
--          insert, and it is far better populated (100% email vs the pixel's ~87%;
--          CONFIG-TODO.md §1 documents the pixel's name tokens resolving empty on
--          79% of postbacks). The pixel remains the ONLY source for the ~30% of
--          monetized calls that match no lead, so it stays the fallback.
--   v_offline_conversion_export is pixel-first throughout. The divergence is
--   deliberate: that view mirrors what the Sheet sent; this one optimizes for
--   identity-match quality.
--
-- Each attribute independently takes the most recent NON-NULL value across the
-- caller's events, rather than everything from the latest event — so a caller whose
-- newest postback carried no zip keeps the zip an older one did carry.
create materialized view public.mv_monetized_callers as
with ev as (
  select
    oce.source,
    oce.conversion_time,
    oce.conversion_value,
    oce.lead_id,
    public.cm_program(oce.offer) as program,

    -- identity
    coalesce(
      public.cm_phone10(nullif(oce.caller_id, '')),
      public.cm_phone10(nullif(l.phone, ''))
    ) as phone10,

    -- profile
    nullif(coalesce(nullif(l.email, ''),      nullif(oce.caller_email, '')),      '') as email,
    nullif(coalesce(nullif(l.first_name, ''), nullif(oce.caller_first_name, '')), '') as first_name,
    nullif(coalesce(nullif(l.last_name, ''),  nullif(oce.caller_last_name, '')),  '') as last_name,
    nullif(coalesce(nullif(l.zip, ''),        nullif(oce.caller_zip, '')),        '') as zip,
    nullif(coalesce(nullif(l.state, ''),      nullif(oce.caller_state, '')),      '') as state,

    -- context, for slicing an export
    nullif(coalesce(nullif(oce.utm_source, ''), oce.raw_payload ->> 'utm_source'), '') as utm_source,
    nullif(oce.ib_source, '')    as ib_source,
    nullif(oce.landing_page, '') as landing_page
  from public.offline_conversion_events oce
  left join public.leads l on l.id = oce.lead_id
  where oce.event_type = 'call_converted_revenue'
    -- revenue only: a $0 "monetized" row is a call that was never billed
    and oce.conversion_value > 0
    -- 44 rows carry junk conversion_time (as early as 2001-01-01); real volume
    -- starts 2025-03. The upper bound catches clock-skew rows from the future.
    and oce.conversion_time >= timestamptz '2025-01-01'
    and oce.conversion_time <= now() + interval '1 day'
    -- NBA's own callers only. 'NBA' or unset (498 pre-2026-04 rows predate the
    -- column being populated). An explicit OTHER publisher is someone else's
    -- customer and must never enter an NBA audience.
    and (oce.publisher is null or oce.publisher in ('', 'NBA'))
)
select
  phone10                                                                            as member_key,
  '+1' || phone10                                                                    as phone_e164,
  (array_agg(email        order by (email        is null), conversion_time desc))[1] as email,
  (array_agg(first_name   order by (first_name   is null), conversion_time desc))[1] as first_name,
  (array_agg(last_name    order by (last_name    is null), conversion_time desc))[1] as last_name,
  (array_agg(zip          order by (zip          is null), conversion_time desc))[1] as zip,
  (array_agg(state        order by (state        is null), conversion_time desc))[1] as state,
  'US'::text                                                                         as country,
  (array_agg(lead_id      order by (lead_id      is null), conversion_time desc))[1] as latest_lead_id,
  (array_agg(utm_source   order by (utm_source   is null), conversion_time desc))[1] as latest_utm_source,
  (array_agg(ib_source    order by (ib_source    is null), conversion_time desc))[1] as latest_ib_source,
  (array_agg(landing_page order by (landing_page is null), conversion_time desc))[1] as latest_landing_page,
  min(conversion_time)                                                               as first_monetized_at,
  max(conversion_time)                                                               as last_monetized_at,
  count(*)                                                                           as monetized_calls,
  count(*) filter (where lead_id is not null)                                        as calls_matched_to_lead,
  round(sum(conversion_value)::numeric, 2)                                           as total_revenue,
  array_agg(distinct program order by program)                                       as programs,
  array_agg(distinct source  order by source)                                        as sources
from ev
where phone10 is not null
group by phone10;

comment on materialized view public.mv_monetized_callers is
  'MASTER: one row per monetized caller, all sources, no Google filter. Query or CSV-export for any ad-hoc audience question. Refreshed daily by refresh_customer_match_members(). programs is {unknown} until a pixel sends offer.';

-- UNIQUE index is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY, which is what
-- keeps the daily refresh from taking an ACCESS EXCLUSIVE lock on readers.
create unique index if not exists mv_monetized_callers_member_key_idx
  on public.mv_monetized_callers (member_key);
create index if not exists mv_monetized_callers_last_monetized_idx
  on public.mv_monetized_callers (last_monetized_at desc);
create index if not exists mv_monetized_callers_programs_idx
  on public.mv_monetized_callers using gin (programs);

-- ---------------------------------------------------------------------------
-- 4. v_customer_match_candidates — who belongs in which audience
-- ---------------------------------------------------------------------------
--
-- Google Ads has NO hierarchy between customer lists: every list is a flat,
-- independent set of hashed identities, and Google will not derive one list from
-- another. The "program lists are a subset of the universal list" relationship is
-- therefore maintained HERE, by emitting a person once for 'all' and once more for
-- each program they monetized on.
--
-- The universal list is fed DIRECTLY, not derived from the program lists. That
-- ordering is the whole point: program is unknown on 100% of calls today, so a
-- derived universal list would be EMPTY. Fed directly it is complete now, and the
-- program lists fill in on top later.
--
-- Identifiers only — no PII. Membership is a key question; PII is fetched separately
-- at upload time.
create or replace view public.v_customer_match_candidates
with (security_invoker = true) as
  -- the universal list: every monetized caller, program known or not
  select 'all'::text as audience_key, m.member_key
  from public.mv_monetized_callers m
union all
  -- per-program lists: a strict subset of the universal list, by construction.
  -- 'unknown' never gets a list of its own — those people are already in 'all'.
  select p.program as audience_key, m.member_key
  from public.mv_monetized_callers m
  cross join lateral unnest(m.programs) as p(program)
  where p.program <> 'unknown';

comment on view public.v_customer_match_candidates is
  'Audience membership: one row per (audience_key, member_key). Read only by refresh_customer_match_members().';

-- ---------------------------------------------------------------------------
-- 5. customer_match_members — the upload LEDGER
-- ---------------------------------------------------------------------------
--
-- Which person went to which Google audience, when, and what Google said.
--
-- Holds NO PII beyond the phone digits that form the key. Email, name and zip are
-- joined from mv_monetized_callers at upload time and never persisted here, so this
-- pipeline adds no new personal data at rest.
--
-- Keyed on (audience_key, member_key), NOT member_key alone. A person who monetizes
-- on ACA in March and Energy in June is genuinely two memberships; a phone-only key
-- would record the first and silently lose the second.
create table if not exists public.customer_match_members (
  id                     uuid primary key default gen_random_uuid(),
  audience_key           text        not null,
  member_key             text        not null,   -- NANP 10-digit, from cm_phone10()
  status                 text        not null default 'pending',
  upload_attempts        integer     not null default 0,
  first_seen_at          timestamptz not null default now(),
  last_upload_attempt_at timestamptz,
  uploaded_at            timestamptz,
  google_audience_id     text,                   -- the List ID this member was sent to
  google_upload_response jsonb,
  google_upload_error    jsonb,
  constraint customer_match_members_unique unique (audience_key, member_key),
  constraint customer_match_members_status_check check (
    status in ('pending', 'awaiting_destination', 'uploaded', 'failed')
  )
);

comment on table public.customer_match_members is
  'Upload ledger for Google Ads Customer Match. One row per (audience, person). Phone digits and status only - no other PII at rest.';
comment on column public.customer_match_members.status is
  'pending = queued. awaiting_destination = no Google List ID configured for this program yet; the health check IGNORES this status so an unconfigured program cannot page anyone. uploaded = accepted by Google. failed = permanent rejection or attempt cap reached.';
comment on column public.customer_match_members.member_key is
  'NANP 10-digit phone; the stable identity key. See cm_phone10().';

create index if not exists customer_match_members_queue_idx
  on public.customer_match_members (status, audience_key, first_seen_at);
create index if not exists customer_match_members_uploaded_idx
  on public.customer_match_members (uploaded_at desc) where status = 'uploaded';
-- Exactly the uploader's access path: `where status='pending' order by first_seen_at`.
-- The composite index above leads with audience_key, so it cannot serve that ordering
-- without a sort. On a 63k backlog a sort is survivable, but the 8s statement_timeout
-- is the known hazard in this pipeline and this index removes the question.
create index if not exists customer_match_members_pending_idx
  on public.customer_match_members (first_seen_at) where status = 'pending';

alter table public.customer_match_members enable row level security;
-- No policies: service_role (the edge function) bypasses RLS; everyone else gets
-- nothing. Matches how leads / offline_conversion_events are protected.

-- ---------------------------------------------------------------------------
-- 6. v_customer_match_upload_queue — what the uploader reads
-- ---------------------------------------------------------------------------
--
-- An indexed join between the ledger and the stored master. No aggregation, so a
-- 10,000-row batch is 10,000 index probes and stays far inside the 8s timeout.
create or replace view public.v_customer_match_upload_queue
with (security_invoker = true) as
select
  m.id              as member_id,
  m.audience_key,
  m.member_key,
  m.upload_attempts,
  m.first_seen_at,
  c.phone_e164,
  c.email,
  c.first_name,
  c.last_name,
  c.zip,
  c.state,
  c.country
from public.customer_match_members m
join public.mv_monetized_callers c on c.member_key = m.member_key
where m.status = 'pending';

comment on view public.v_customer_match_upload_queue is
  'Pending Customer Match members with the PII needed to hash them. Read only by upload-google-customer-match.';

-- ---------------------------------------------------------------------------
-- 7. refresh_customer_match_members() — the daily rollup + merge
-- ---------------------------------------------------------------------------
--
-- Carries its OWN statement_timeout. `service_role` defaults to 8s (migration
-- 20260821000300) and the rollup measures ~15s on this instance, so without this the
-- uploader would fail on every run — silently, because pg_cron cannot see an edge
-- function's response. See the migration header.
--
-- The INSERT is insert-only by design. A person already in the ledger is left
-- completely alone: an 'uploaded' row is never reset to 'pending', so nobody is ever
-- re-sent to Google. "When did this person last monetize" is a question for
-- mv_monetized_callers, which is why there is no last_seen_at column to churn here.
create or replace function public.refresh_customer_match_members()
returns table (members_added bigint, master_rows bigint)
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_added bigint;
  v_rows  bigint;
begin
  -- CONCURRENTLY needs the unique index above, and keeps readers unblocked.
  refresh materialized view concurrently public.mv_monetized_callers;

  with ins as (
    insert into public.customer_match_members (audience_key, member_key, status)
    select c.audience_key, c.member_key, 'pending'
    from public.v_customer_match_candidates c
    on conflict (audience_key, member_key) do nothing
    returning 1
  )
  select count(*) into v_added from ins;

  select count(*) into v_rows from public.mv_monetized_callers;

  return query select v_added, v_rows;
end;
$$;

comment on function public.refresh_customer_match_members() is
  'Refresh mv_monetized_callers, then insert newly-monetized people into customer_match_members as pending. Never modifies an existing ledger row. Carries a raised statement_timeout on purpose.';

-- ---------------------------------------------------------------------------
-- 8. cm_release_awaiting() — bring a program online once its audience exists
-- ---------------------------------------------------------------------------
--
-- When a pixel starts sending `offer`, people resolve to a program whose Google Ads
-- audience does not exist yet. Those rows park at 'awaiting_destination' so a backlog
-- for a non-existent list cannot page anyone.
--
-- The uploader calls this for every audience key that HAS an id configured, so adding
-- the secret is the only step needed — the parked backlog releases itself on the next
-- run. There is no manual SQL to remember.
create or replace function public.cm_release_awaiting(p_audience_key text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released bigint;
begin
  update public.customer_match_members
     set status = 'pending',
         upload_attempts = 0,
         google_upload_error = null
   where audience_key = p_audience_key
     and status = 'awaiting_destination';

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

comment on function public.cm_release_awaiting(text) is
  'Flip awaiting_destination rows back to pending for one audience, once its Google Ads List ID is configured. Called automatically by the uploader.';

-- ---------------------------------------------------------------------------
-- 9. cm_upload_backlog() — what the health check reads
-- ---------------------------------------------------------------------------
--
-- Counts people the uploader SHOULD have delivered by now. Mirrors
-- offline_cv_api_backlog(): it applies the SAME eligibility the uploader applies, so
-- the watchdog can never alert on rows the uploader would never have sent.
-- 'awaiting_destination' is excluded on purpose — see cm_release_awaiting().
create or replace function public.cm_upload_backlog(
  grace_hours  integer default 48,
  max_attempts integer default 6
)
returns table (audience_key text, pending bigint, oldest_pending timestamptz)
language sql
security definer
set search_path = public
set statement_timeout = '8s'
as $$
  select m.audience_key,
         count(*) as pending,
         min(m.first_seen_at) as oldest_pending
  from public.customer_match_members m
  where m.status = 'pending'
    and m.upload_attempts < max_attempts
    and m.first_seen_at < now() - make_interval(hours => grace_hours)
  group by m.audience_key;
$$;

comment on function public.cm_upload_backlog(integer, integer) is
  'Customer Match delivery backlog for pipeline-health-check. Excludes awaiting_destination.';

-- ---------------------------------------------------------------------------
-- 9b. Batch outcome RPCs
-- ---------------------------------------------------------------------------
--
-- One round trip per batch instead of chunked PATCHes. A PostgREST update filtered
-- by `id=in.(...)` puts every id in the QUERY STRING, so a 5,000-row batch would
-- blow the URL length limit and have to be split into ~128 calls. These take the ids
-- as an array in the body instead.
--
-- The outcome model is the conversion uploader's, unchanged: a retryable failure
-- leaves the row pending so the next run picks it up, and only becomes 'failed' at
-- the attempt cap.
create or replace function public.cm_record_outcome(
  p_ids          uuid[],
  p_outcome      text,                    -- 'uploaded' | 'retryable' | 'permanent'
  p_audience_id  text    default null,
  p_payload      jsonb   default null,
  p_max_attempts integer default 6
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows bigint;
begin
  if p_outcome not in ('uploaded', 'retryable', 'permanent') then
    raise exception 'cm_record_outcome: unknown outcome %', p_outcome;
  end if;

  update public.customer_match_members m
     set upload_attempts        = m.upload_attempts + 1,
         last_upload_attempt_at = now(),
         google_audience_id     = coalesce(p_audience_id, m.google_audience_id),
         uploaded_at = case when p_outcome = 'uploaded' then now() else m.uploaded_at end,
         google_upload_response = case when p_outcome = 'uploaded' then p_payload else m.google_upload_response end,
         google_upload_error    = case when p_outcome = 'uploaded' then null      else p_payload end,
         status = case
           when p_outcome = 'uploaded'  then 'uploaded'
           when p_outcome = 'permanent' then 'failed'
           -- retryable: stay pending so the next run retries; fail only at the cap
           when m.upload_attempts + 1 >= p_max_attempts then 'failed'
           else m.status
         end
   where m.id = any(p_ids);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.cm_record_outcome(uuid[], text, text, jsonb, integer) is
  'Apply one Google batch outcome to every member in the batch, in a single statement.';

-- Park a whole audience when no Google List ID is configured for it. See
-- cm_release_awaiting() for the reverse.
create or replace function public.cm_mark_awaiting(p_audience_key text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows bigint;
begin
  update public.customer_match_members
     set status = 'awaiting_destination'
   where audience_key = p_audience_key
     and status = 'pending';

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.cm_mark_awaiting(text) is
  'Park pending members of an audience that has no Google List ID configured, so the health check does not alert on them.';

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
--
-- Supabase default privileges grant SELECT on new objects in `public` to anon and
-- authenticated. These objects carry lead PII, so REVOKE is mandatory, not tidiness.
-- A materialized view cannot carry RLS and ignores security_invoker, so the revoke is
-- the ONLY thing protecting mv_monetized_callers.
--
-- NOTE for later, NOT changed here: v_offline_conversion_export,
-- v_offline_cv_upload_daily and v_google_sheet_export_unsynced are owned by postgres,
-- have no security_invoker, and DO grant SELECT to anon — so they bypass the RLS on
-- `leads` and expose email/phone/name/zip to the publishable key. Pre-existing and
-- out of scope. See docs/customer-match/ORPHANS-customer-match.md §5.

revoke all on public.mv_monetized_callers            from anon, authenticated;
revoke all on public.v_customer_match_candidates     from anon, authenticated;
revoke all on public.v_customer_match_upload_queue   from anon, authenticated;
revoke all on public.customer_match_members          from anon, authenticated;

grant select on public.mv_monetized_callers          to service_role;
grant select on public.v_customer_match_candidates   to service_role;
grant select on public.v_customer_match_upload_queue to service_role;
grant all    on public.customer_match_members        to service_role;

revoke all on function public.refresh_customer_match_members()    from public;
revoke all on function public.cm_release_awaiting(text)           from public;
revoke all on function public.cm_upload_backlog(integer, integer) from public;
revoke all on function public.cm_record_outcome(uuid[], text, text, jsonb, integer) from public;
revoke all on function public.cm_mark_awaiting(text) from public;

grant execute on function public.refresh_customer_match_members()    to service_role;
grant execute on function public.cm_release_awaiting(text)           to service_role;
grant execute on function public.cm_upload_backlog(integer, integer) to service_role;
grant execute on function public.cm_record_outcome(uuid[], text, text, jsonb, integer) to service_role;
grant execute on function public.cm_mark_awaiting(text) to service_role;
