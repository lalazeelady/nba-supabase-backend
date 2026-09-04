-- Caliber cutover: per-offer attribution + the upload eligibility rule
--
-- Two independent changes, both driven by Energy moving from Ringba to Caliber.
--
-- 1. offline_conversion_events.offer
--    Until now every Caliber event landed under source='caliber' with nothing
--    distinguishing Internet from Energy (and, later, ACA). The webhooks now
--    carry an explicit `offer` param; this stores it.
--
-- 2. v_offline_conversion_export — allow-list becomes deny-list
--    The old rule uploaded a row only when it could POSITIVELY identify the
--    traffic as Google:
--
--        utm_source ILIKE 'google'
--     OR ib_source ~* '(google|youtube)'
--     OR ib_source IN ('NBA_ThankYou','NBA_Funnel','NBA_InactivityPopup')
--     OR (utm_source IS NULL AND ib_source IS NULL)   <-- the catch-all
--
--    Ringba sends NO ib_source at all, so ~28% of its volume (1,569 rows in a
--    representative 7-day window) qualified only via that last catch-all.
--    Caliber ALWAYS sends ib_source. So at cutover those rows would have moved
--    from "both blank -> upload" to "ib_source set but unrecognised -> skip",
--    and stopped reaching Google Ads silently — losing conversions purely
--    because the new platform sends MORE data than the old one did.
--
--    The rule is therefore inverted to match how the business actually defines
--    it:
--
--        upload if EITHER field positively identifies Google,
--        else skip if EITHER field identifies a non-Google source,
--        else upload (unknown).
--
--    Stated this way the new rule is a strict SUPERSET of the old one: every
--    row the allow-list accepted is still accepted (positively-Google rows
--    match clause 1, both-blank rows fall through to clause 3), and the only
--    change is that unknown-but-not-denied rows now upload too. An earlier
--    draft used utm_source precedence instead, which read more naturally but
--    would have newly EXCLUDED rows carrying a non-Google utm_source alongside
--    a Google ib_source — a regression the supersetting form cannot cause.
--
--    APPLIES TO ALL ROWS, INCLUDING HISTORY (owner's decision, 4 Sep 2026).
--
--    Investigating this turned up a live bug the change also fixes. The old
--    catch-all required utm_source AND ib_source to BOTH be blank. Internet
--    calls always carry ib_source='nba-internet-calls', so only one was ever
--    blank and they never qualified — the rule treated a PHONE ROUTE NAME as
--    evidence the traffic was not Google. Measured over 14 days:
--
--      ib_source            utm_source   rows    uploaded
--      nba                  google       5,448   5,444
--      nba-internet-calls   google          62      62
--      nba-internet-calls   (blank)      2,944       0   <-- never, not once
--      nba                  (blank)         68       0
--
--    Those rows sit at status 'monetize_ready'/'transfer_ready' — they look
--    ready in the table, and the view filters them out before the uploader
--    sees them. An invisible backlog that reports as healthy: 4,054 still
--    recoverable rows, 2,091 of them revenue events worth $14,842 that Google
--    never received, plus 114 already aged past the 90-day window and lost.
--
--    Applying the rule to history lets the existing cron drain that backlog:
--    the uploader runs every 15 min at limit=250 (~1,000/hr), so it clears in
--    roughly four hours. All 4,054 have upload_attempts=0, and the uploader's
--    own 85-day cutoff skips the aged-out rows, so no bulk rejection.

-- No explicit BEGIN/COMMIT: matches the other migrations in this directory and
-- lets the migration runner own the transaction.

-- 1. offer ------------------------------------------------------------------

alter table public.offline_conversion_events
  add column if not exists offer text;

comment on column public.offline_conversion_events.offer is
  'Campaign the call belongs to (energy / aca / internet / medicare / ...), from '
  'the webhook `offer` param. Null for events predating the Caliber cutover and '
  'for any sender that does not send it.';

-- Reporting splits by offer within a source, over a time range.
create index if not exists idx_oce_offer_event_time
  on public.offline_conversion_events (offer, event_type, conversion_time desc);

-- 2. helpers ------------------------------------------------------------------

-- The moment the deny-list takes effect. Set in the past, so it applies to ALL
-- rows including history — that is what drains the stuck backlog described
-- above.
--
-- It stays a FUNCTION rather than a literal inlined into the view because it is
-- also the rollback lever: setting it to a future date reverts every row to the
-- old allow-list instantly, with one statement and no view rebuild or redeploy.
--
--   create or replace function public.offline_cv_denylist_cutover()
--   returns timestamptz language sql immutable
--   as $$ select timestamptz '2099-01-01 00:00:00+00' $$;   -- full rollback
create or replace function public.offline_cv_denylist_cutover()
returns timestamptz
language sql
immutable
as $$ select timestamptz '2000-01-01 00:00:00+00' $$;

comment on function public.offline_cv_denylist_cutover() is
  'Events created at/after this instant use the deny-list upload rule; earlier '
  'events keep the historical allow-list. Set to 2000-01-01 so the rule applies '
  'to everything. Set it to a FUTURE date to roll the whole rule back instantly.';

-- TRUE when a source string is identifiably NOT Google traffic. Anything this
-- does not recognise is treated as unknown, and unknown still uploads — Google
-- simply fails to match a row that never came from a Google click, whereas
-- wrongly excluding one loses a real conversion permanently.
--
-- Deliberately NOT listed: 'organic', 'direct', and brand/route names like
-- 'nba', 'helping-hands', 'utility-benefits'. Those are unknown, not non-Google.
create or replace function public.is_non_google_source(src text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    btrim($1) ~* '(meta|facebook|instagram|bing|microsoft|msn|yahoo|tiktok|linkedin|twitter|snapchat|pinterest|reddit|taboola|outbrain|email|sms|10dlc|shortcode)',
    false
  )
$$;

comment on function public.is_non_google_source(text) is
  'Deny-list test for the offline-conversion upload gate. TRUE = identifiably '
  'non-Google, so do not upload. Unrecognised values are NOT non-Google.';

-- TRUE when a source string POSITIVELY identifies Google traffic. This is the
-- old allow-list, kept intact and promoted to a function so the new rule can
-- guarantee it remains a superset of the old behaviour.
create or replace function public.is_google_source(src text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    btrim($1) ilike 'google'
    or btrim($1) ~* '(google|youtube)'
    or btrim($1) in ('NBA_ThankYou', 'NBA_Funnel', 'NBA_InactivityPopup'),
    false
  )
$$;

comment on function public.is_google_source(text) is
  'Allow-list test for the offline-conversion upload gate. TRUE = positively '
  'Google/YouTube traffic, or one of the NBA funnel inbound routes.';

-- 3. the export view ----------------------------------------------------------
-- NOTE: `offer` is appended LAST. CREATE OR REPLACE VIEW can only add columns
-- at the end — inserting one mid-list fails against the existing view.

create or replace view public.v_offline_conversion_export as
with base as (
  select
    oce.*,
    nullif(coalesce(nullif(oce.utm_source, ''), oce.raw_payload ->> 'utm_source'), '') as utm_source_eff,
    nullif(coalesce(nullif(oce.ib_source,  ''), oce.raw_payload ->> 'ib_source'),  '') as ib_source_eff
  from public.offline_conversion_events oce
)
select
  b.id as event_id,
  b.gclid as google_click_id,
  b.gbraid,
  b.wbraid,
  coalesce(b.google_ads_conversion_action_name, 'CallConvertOffline') as conversion_name,
  to_char((b.conversion_time at time zone 'UTC'), 'YYYY-MM-DD HH24:MI:SS"+0000"') as conversion_time,
  b.conversion_value,
  coalesce(nullif(b.currency_code, ''), 'USD') as conversion_currency,
  coalesce(nullif(b.order_id, ''), b.id::text) as order_id,
  coalesce(nullif(b.raw_payload ->> 'ip_address', ''), nullif(l.ip_address, '')) as ip_address,
  coalesce(nullif(b.caller_email, ''), nullif(l.email, '')) as email,
  case
    when b.caller_id ~ '^\+'          then b.caller_id
    when b.caller_id ~ '^1[0-9]{10}$' then '+' || b.caller_id
    when b.caller_id ~ '^[0-9]{10}$'  then '+1' || b.caller_id
    when l.phone ~ '^\+'              then l.phone
    when l.phone ~ '^1[0-9]{10}$'     then '+' || l.phone
    when l.phone ~ '^[0-9]{10}$'      then '+1' || l.phone
    else nullif(coalesce(b.caller_id, l.phone), '')
  end as phone,
  coalesce(nullif(b.caller_first_name, ''), nullif(l.first_name, '')) as first_name,
  coalesce(nullif(b.caller_last_name,  ''), nullif(l.last_name,  '')) as last_name,
  null::text as session_attributes,
  null::text as user_agent,
  b.publisher,
  b.status,
  b.sheet_synced_at,
  b.created_at as event_created_at,
  b.event_type,
  b.conversion_time as conversion_time_ts,
  b.upload_attempts,
  b.google_ads_customer_id,
  coalesce(nullif(b.caller_zip, ''), nullif(l.zip, '')) as zip,
  b.source,
  b.ib_source_eff as ib_source_effective,
  b.offer
from base b
left join public.leads l on l.id = b.lead_id
where b.publisher = 'NBA'
  and (b.event_type = 'call_transferred' or b.conversion_value > 0)
  and (
        nullif(b.gclid,  '') is not null
     or nullif(b.gbraid, '') is not null
     or nullif(b.wbraid, '') is not null
     or coalesce(nullif(b.caller_email, ''), nullif(l.email, '')) is not null
     or coalesce(nullif(b.caller_id,    ''), nullif(l.phone, '')) is not null
  )
  -- Legacy guard, unchanged: a Ringba row carrying a `status` field is an old
  -- mis-filed Caliber postback, not a Ringba conversion.
  and not (b.source = 'ringba' and b.raw_payload ? 'status')
  and (
    case
      when b.created_at >= public.offline_cv_denylist_cutover() then
        -- NEW RULE. Positively Google wins; otherwise skip only what is
        -- identifiably non-Google; unknown uploads. Strict superset of OLD.
        (
             public.is_google_source(b.utm_source_eff)
          or public.is_google_source(b.ib_source_eff)
          or not (
                  public.is_non_google_source(b.utm_source_eff)
               or public.is_non_google_source(b.ib_source_eff)
             )
        )
      else
        -- OLD RULE (allow-list), preserved verbatim for pre-cutover rows.
        (
             b.utm_source_eff ilike 'google'
          or b.ib_source_eff ~* '(google|youtube)'
          or b.ib_source_eff in ('NBA_ThankYou', 'NBA_Funnel', 'NBA_InactivityPopup')
          or (b.utm_source_eff is null and b.ib_source_eff is null)
        )
    end
  );

