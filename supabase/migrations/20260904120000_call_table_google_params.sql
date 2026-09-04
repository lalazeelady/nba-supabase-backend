-- Offline conversion events: carry the Google Ads ValueTrack set + landing page.
--
-- Owner's framing for this table (Sep 2026): it is the CALL table. It should not
-- duplicate everything on `leads` — anything already there can be reached by
-- joining on lead_id. It should carry the fields that serve four purposes:
--   1. attribution      (click ids, UTMs, ValueTrack, landing page)
--   2. matching         (transaction_id, caller_id, call ids)
--   3. media source when the lead join isn't available (ib_source, publisher)
--   4. offline conversions (click ids + hashed-PII inputs, value, time)
-- plus anything that only exists on the CALL itself (queue, ib_source, agent).
--
-- Additive only: nullable, no defaults, no constraints.

ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS landing_page text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS campaign_id  text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS adgroup_id   text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS creative_id  text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS target_id    text;
ALTER TABLE public.offline_conversion_events ADD COLUMN IF NOT EXISTS network      text;

COMMENT ON COLUMN public.offline_conversion_events.campaign_id IS
  'GOOGLE ADS campaign id from ValueTrack {campaignid} — NOT the CallTools dialer '
  'campaign, which the CallTools->Ringba enrich URL also calls campaignid. Keep the '
  'two on distinct Ringba tag names or this column will fill with dialer ids.';
COMMENT ON COLUMN public.offline_conversion_events.adgroup_id IS 'Google Ads ValueTrack {adgroupid}.';
COMMENT ON COLUMN public.offline_conversion_events.creative_id IS 'Google Ads ValueTrack {creative} — the ad id.';
COMMENT ON COLUMN public.offline_conversion_events.target_id IS 'Google Ads ValueTrack {targetid} — keyword/criterion id.';
COMMENT ON COLUMN public.offline_conversion_events.network IS 'Google Ads ValueTrack {network} — g / s / d / u.';
COMMENT ON COLUMN public.offline_conversion_events.landing_page IS
  'Funnel variant the lead came through (apply0/apply2/bg1/oa1/info01). Backfilled '
  'from the matched lead when the postback does not carry it.';
