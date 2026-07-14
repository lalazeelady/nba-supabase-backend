-- offline_conversion_events had no UTM columns, so UTMs could not be carried
-- on the Ringba->Supabase->Google leg even when available. Add them so the
-- webhook can store UTMs forwarded by Ringba/CallTools, and so the re-match
-- backfill can populate them from the linked lead.
--
-- Note: Google Ads offline conversions attribute on click IDs (gclid/gbraid/
-- wbraid), NOT UTMs. These columns are for attribution/reporting completeness,
-- not for the Google upload itself.

alter table public.offline_conversion_events
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text;
