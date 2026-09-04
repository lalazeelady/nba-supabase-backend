-- Pipeline field parity: capture everything the funnel already collects (or the
-- edge function already has in hand) instead of discarding it at the leads insert,
-- and give the Ringba/Caliber webhooks somewhere to put the caller context that
-- already arrives on the postback but currently survives only inside raw_payload.
--
-- Purely additive: every column is nullable with no default and no constraint, so
-- existing inserts, views, RPCs and the Sheet/Data-Manager export are unaffected.
-- Safe to run before the matching edge-function deploys.

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------

-- Click identifiers the funnel already captures and posts. They were reaching
-- Caliber but had no column here, so they were dropped at the insert.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ttclid    text;  -- TikTok
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS li_fat_id text;  -- LinkedIn
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS twclid    text;  -- X / Twitter
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS epik      text;  -- Pinterest

-- Session context. Both are read from request headers on every submission and
-- handed to Caliber's consent block, then thrown away. Retaining them gives us
-- our own TCPA evidence trail and makes user_agent available as an Enhanced
-- Conversions signal.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS referrer   text;

-- Timing. form_duration_ms is currently retained only for submissions we REJECT
-- (bot_drops); keeping it for accepted leads lets us reconstruct the real consent
-- moment. click_timestamp is the initial landing time supplied by the funnel.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS form_duration_ms  integer;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS consent_timestamp timestamptz;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS click_timestamp   timestamptz;

-- Intent: the landing-page tiles ("what brings you here today" -> food / utilities
-- / housing / other). Collected into sessionStorage on every funnel today and
-- posted nowhere. Stored comma-joined so it passes through query-string postbacks
-- and the Sheet export unchanged.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS needs text;

-- Publisher/sub-publisher identity, to match the Ringba `pub` tag that gates
-- webhook ingest and the CallTools contact `pubid` the enrich URL reads.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS publisher text;

COMMENT ON COLUMN public.leads.needs IS
  'Comma-joined benefit interests from the funnel landing tiles (food,utility,housing,other).';
COMMENT ON COLUMN public.leads.publisher IS
  'Publisher / sub-publisher identity; mirrors the Ringba Publisher:Name tag.';
COMMENT ON COLUMN public.leads.click_timestamp IS
  'Initial ad-click / landing time supplied by the funnel, not the submission time.';

-- ---------------------------------------------------------------------------
-- offline_conversion_events
-- ---------------------------------------------------------------------------

-- Caller context that Ringba already sends on a subset of pixels. `address` and
-- `ip_address` arrive on every postback but neither webhook had a parser entry
-- for them, so they were readable only via raw_payload.
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS caller_address text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS caller_city    text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS ip_address     text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS user_agent     text;

COMMENT ON COLUMN public.offline_conversion_events.ip_address IS
  'Caller IP from the postback, else backfilled from the matched lead.';
COMMENT ON COLUMN public.offline_conversion_events.user_agent IS
  'Caller user agent from the postback, else backfilled from the matched lead.';
