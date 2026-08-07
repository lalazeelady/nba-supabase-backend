-- Naming clarity: rename offline_conversion_events.status 'ready_to_upload'
-- (the CCO / monetized-call upload-eligible state) to 'monetize_ready', so it
-- parallels the transfer path's 'transfer_ready'. Everything else
-- (uploaded/failed/matched/unmatched/transfer_*) is unchanged.
--
-- Coordinated with:
--   - ringba-conversion-webhook redeploy  (sets 'monetize_ready' on new events)
--   - upload-google-offline-conversions redeploy (selects the new name; it also
--     still accepts the old 'ready_to_upload' during the deploy window, so no
--     event is missed regardless of deploy ordering)
--
-- Forward-only data migration for existing rows.

update public.offline_conversion_events
set status = 'monetize_ready'
where status = 'ready_to_upload';
