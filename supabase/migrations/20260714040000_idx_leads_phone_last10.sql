-- Functional index on the normalized last-10-digits of phone, matching the
-- expression used by rematch_offline_conversion_events() and the webhook's
-- phone fallback, so those joins are index-backed instead of seq scans.
-- (Without it the re-match backfill over ~28k events x ~76k leads times out.)
create index if not exists idx_leads_phone_last10
  on public.leads (right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10));