-- Label every api_logs row by pipeline so you can filter/cross-reference without digging
-- through raw payloads. Applied live via MCP 2026-08-28 (kept here so git == prod).
--
-- api_type values:
--   lead-to-ct | lead-to-caliber | cv-cco-ringba | cv-internet-caliber | cv-xfr-ringba | cv-upload
--
-- Cross-reference note: api_logs ALREADY carries `transaction_id` (the lead txn, when present)
-- and `caller_id` (the phone), so you can already join to leads/offline_conversion_events on
-- those. api_type adds the "which pipeline" dimension.
--
-- Populated by: submit-lead (lead-to-ct / lead-to-caliber) — LIVE now (v56).
--              ringba-conversion-webhook (cv-cco-ringba / cv-internet-caliber),
--              ringba-transfer-webhook (cv-xfr-ringba),
--              upload-google-offline-conversions (cv-upload) — with the big changeset deploy.

alter table public.api_logs add column if not exists api_type text;

comment on column public.api_logs.api_type is
  'Pipeline that produced this row: lead-to-ct | lead-to-caliber | cv-cco-ringba | '
  'cv-internet-caliber | cv-xfr-ringba | cv-upload.';

create index if not exists api_logs_api_type_idx
  on public.api_logs (api_type) where api_type is not null;
