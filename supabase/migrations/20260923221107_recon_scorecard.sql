-- SUPERSEDED. The v_recon_scorecard defined below is the FIRST draft (one row per
-- metric, route_unmapped bucket, no revenue in the dedupe key). It was replaced the same
-- day -- see 20260923223434 and 20260923224106. This file is kept because its version is
-- already in the remote migration history; it will never re-run against this project.
-- On a rebuild from zero, apply it and then re-apply the later files in order.
-- The authoritative current definition lives in the database:
--   select pg_get_viewdef('public.v_recon_scorecard'::regclass, true);

-- Daily reconciliation scorecard (2026-09-23)
--
-- One row per (ET day, metric). Metrics: cco_revenue, cco_conversions, xfer_conversions.
-- Source of truth is `postbacks` (Caliber). Ringba/offline_conversion_events is NOT included:
-- its last event was 2026-09-22 17:58 ET, so this view is complete from 2026-09-23 onward.
--
-- Dedupe key (owner, 2026-09-23): ET date | offer | click id when present | phone.
-- Earliest event for a key wins, which is what the uploader does.
--
-- Transfers: the `internet` offer takes its transfer count from monetized calls
-- (offer_rules.transfers_from_monetize). Every other offer uses its transfer postbacks.

-- Ad-platform reported numbers, entered by hand from the ad UI.
create table if not exists public.platform_reported (
  conversion_date_et date    not null,
  platform           text    not null check (platform in ('google','bing')),
  cco_revenue        numeric,
  cco_conversions    integer,
  xfer_conversions   integer,
  note               text,
  updated_at         timestamptz not null default now(),
  primary key (conversion_date_et, platform)
);

comment on table public.platform_reported is
  'What the ad platform UI reports for a day. Entered by hand; nothing writes this automatically.';

create or replace view public.v_recon_scorecard as
with base as (
  select
    v.conversion_date_et                           as d,
    coalesce(v.offer,'-')                          as offer,
    v.phone,
    v.conversion_time,
    v.conversion_value,
    v.platform,
    v.ib_source,
    v.event_type,
    coalesce(nullif(v.gclid,''), nullif(v.gbraid,''), nullif(v.wbraid,'')) as google_click,
    nullif(v.msclkid,'')                                                    as bing_click
  from public.v_postbacks v
),
universe as (
  -- CCO: monetized calls carrying revenue
  select b.*, 'cco'::text as universe
    from base b
   where b.event_type = 'monetize' and b.conversion_value > 0
  union all
  -- Transfers: internet counts them from monetized calls, everyone else from transfer postbacks
  select b.*, 'xfer'::text as universe
    from base b
    left join public.offer_rules r on r.offer = b.offer
   where case when coalesce(r.transfers_from_monetize, false)
              then b.event_type = 'monetize' and b.conversion_value > 0
              else b.event_type = 'transfer'
         end
),
dedup as (
  select distinct on (universe, d, offer, coalesce(google_click, bing_click, ''), phone)
         universe, d, offer, phone, conversion_value, platform, ib_source, google_click, bing_click
    from universe
   order by universe, d, offer, coalesce(google_click, bing_click, ''), phone, conversion_time
),
metrics(metric, universe, measure) as (
  values ('cco_revenue','cco','sum'),
         ('cco_conversions','cco','count'),
         ('xfer_conversions','xfer','count')
),
postback_side as (
  select m.metric, d.d,
    sum(case when m.measure='sum' then d.conversion_value else 1 end)                                    as total_postback,
    sum(case when m.measure='sum' then d.conversion_value else 1 end) filter (where d.platform='google') as google_attributed,
    sum(case when m.measure='sum' then d.conversion_value else 1 end) filter (where d.platform='bing')   as bing_attributed,
    sum(case when m.measure='sum' then d.conversion_value else 1 end)
      filter (where d.platform in ('meta','openai','owned'))                                             as other_attributed,
    sum(case when m.measure='sum' then d.conversion_value else 1 end)
      filter (where d.platform='unknown' and coalesce(d.ib_source,'') <> '')                             as route_unmapped,
    sum(case when m.measure='sum' then d.conversion_value else 1 end)
      filter (where d.platform='unknown' and coalesce(d.ib_source,'') =  '')                             as unknown_true
  from dedup d
  join metrics m on m.universe = d.universe
  group by m.metric, d.d
),
up as (
  select (p.conversion_time at time zone 'America/New_York')::date as d,
         case when u.conversion_action='transfer' then 'xfer' else 'cco' end as universe,
         u.platform, u.status, p.conversion_value,
         (coalesce(nullif(p.gclid,''), nullif(p.gbraid,''), nullif(p.wbraid,'')) is not null) as has_google_click,
         (nullif(p.msclkid,'') is not null)                                                   as has_bing_click
    from public.platform_uploads u
    join public.postbacks p on p.id = u.postback_id
   -- 'sent' is a real upload; 'pending' is eligible-and-queued, which is where Bing sits
   -- while it is dry-run only. Skipped and failed rows are excluded on purpose.
   where u.status in ('sent','pending')
),
upload_side as (
  select m.metric, up.d,
    sum(case when m.measure='sum' then up.conversion_value else 1 end) filter (where up.platform='google') as google_uploaded,
    sum(case when m.measure='sum' then up.conversion_value else 1 end)
      filter (where up.platform='google' and up.has_google_click)                                          as google_uploaded_click_id,
    sum(case when m.measure='sum' then up.conversion_value else 1 end) filter (where up.platform='bing')   as bing_uploaded,
    sum(case when m.measure='sum' then up.conversion_value else 1 end)
      filter (where up.platform='bing' and up.has_bing_click)                                              as bing_uploaded_click_id
  from up
  join metrics m on m.universe = up.universe
  group by m.metric, up.d
)
select
  coalesce(p.d, u.d)                        as conversion_date_et,
  coalesce(p.metric, u.metric)              as metric,
  round(p.total_postback, 2)                as total_postback,
  round(p.google_attributed, 2)             as google_attributed,
  round(p.bing_attributed, 2)               as bing_attributed,
  round(p.other_attributed, 2)              as other_attributed,
  round(p.route_unmapped, 2)                as route_unmapped,
  round(p.unknown_true, 2)                  as unknown_true,
  round(u.google_uploaded, 2)               as google_uploaded,
  round(u.google_uploaded_click_id, 2)      as google_uploaded_click_id,
  case coalesce(p.metric, u.metric)
    when 'cco_revenue'      then g.cco_revenue
    when 'cco_conversions'  then g.cco_conversions::numeric
    when 'xfer_conversions' then g.xfer_conversions::numeric
  end                                       as google_platform,
  round(u.bing_uploaded, 2)                 as bing_uploaded,
  round(u.bing_uploaded_click_id, 2)        as bing_uploaded_click_id,
  case coalesce(p.metric, u.metric)
    when 'cco_revenue'      then b.cco_revenue
    when 'cco_conversions'  then b.cco_conversions::numeric
    when 'xfer_conversions' then b.xfer_conversions::numeric
  end                                       as bing_platform,
  -- Google lands in range when click-id uploads <= platform <= all uploads.
  case
    when g.conversion_date_et is null then null
    else (case coalesce(p.metric, u.metric)
            when 'cco_revenue'      then g.cco_revenue
            when 'cco_conversions'  then g.cco_conversions::numeric
            when 'xfer_conversions' then g.xfer_conversions::numeric
          end) between u.google_uploaded_click_id and u.google_uploaded
  end                                       as google_in_range,
  case when u.google_uploaded > 0 then round(100.0 * (case coalesce(p.metric, u.metric)
            when 'cco_revenue'      then g.cco_revenue
            when 'cco_conversions'  then g.cco_conversions::numeric
            when 'xfer_conversions' then g.xfer_conversions::numeric
          end) / u.google_uploaded, 1) end  as google_pct_of_uploaded,
  case when p.total_postback > 0
       then round(100.0 * p.unknown_true / p.total_postback, 1) end as pct_true_unknown
from postback_side p
full join upload_side u on u.d = p.d and u.metric = p.metric
left join public.platform_reported g
       on g.conversion_date_et = coalesce(p.d, u.d) and g.platform = 'google'
left join public.platform_reported b
       on b.conversion_date_et = coalesce(p.d, u.d) and b.platform = 'bing'
order by 1 desc,
         array_position(array['cco_revenue','cco_conversions','xfer_conversions'],
                        coalesce(p.metric, u.metric));

comment on view public.v_recon_scorecard is
  'Daily reconciliation scorecard: postback totals by attribution bucket, what we upload, and what the ad platform reports. Dedupe = ET date | offer | click id when present | phone, earliest event wins. Postbacks only (Caliber); complete from 2026-09-23.';
