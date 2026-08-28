-- Schedule the attribution re-match to run every 10 minutes.
--
-- Why: the webhooks stamp lead_id/attribution at ingest, but internet conversions often
-- arrive when their lead does not yet match (Caliber sends its OWN transaction_id, calls that
-- precede the lead, phone-format edges). rematch_offline_conversion_events() links those by
-- exact last-10 phone and backfills utm/click ids FROM the lead. On 2026-08-28 a manual run
-- linked 970 events and lifted Caliber utm_source=google from 29 -> 44.
--
-- SAFE: the function touches attribution columns ONLY (never status/uploaded_at/sheet_synced_at/
-- google_*), so it can never cause a re-upload. Idempotent. cron.schedule upserts by name.
--
-- This mirrors the live schedule applied via MCP on 2026-08-28 (kept here so git == prod).

select cron.schedule(
  'rematch-offline-conversions',
  '*/10 * * * *',
  $$select public.rematch_offline_conversion_events();$$
);
