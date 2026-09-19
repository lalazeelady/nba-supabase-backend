-- Go-live control per offer (owner, 2026-09-19). Applied live the same day.
--
-- An offer uploads for real when BOTH are true:
--   1. GOOGLE_POSTBACK_UPLOAD_MODE = live   (one Supabase secret, the master switch)
--   2. the offer is not held here
--
-- Internet is held because its postbacks still go to BOTH pipelines: Caliber -> new webhooks
-- and CallTools -> the legacy webhook, which is the one uploading to Google today. Releasing
-- internet is a clean cutover: stop the legacy pixel, mark the already-uploaded backlog as
-- skipped, then set uploads_held = false.
-- An offer that is not listed here is NOT held, so a new Caliber offer goes live by itself.
alter table public.offer_rules add column uploads_held boolean not null default false;
comment on column public.offer_rules.uploads_held is
  'true = never upload this offer for real, even when GOOGLE_POSTBACK_UPLOAD_MODE=live. Used during a cutover while another pipeline still uploads the same calls.';

update public.offer_rules
   set uploads_held = true,
       note = note || ' · uploads held 2026-09-19: the legacy pixel still uploads internet'
 where offer = 'internet';

-- Also applied live: cron job 'upload-platform-conversions-15min' (*/15 * * * *) calling
-- upload-platform-conversions?platform=google&limit=150. While the master switch is
-- validate_only it only checks rows with Google; it starts uploading the moment the switch flips.
