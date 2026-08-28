-- Offline-CV accuracy, step 1: rename ringba_call_id -> conversion_call_id.
--
-- Why: the field never held the ORIGINAL inbound call id — it holds the id of the
-- TRANSFERRED/CONVERTED call, wherever that happened:
--   * Ringba calls  -> the Ringba call id ('RGB…')
--   * Caliber calls -> the Caliber call id
--   * (CallTools interim) -> the CallTools numeric id, until CT is retired at the Caliber cutover
-- One clearly-named field removes the "is this the original call?" confusion.
--
-- Rename preserves all data and (in Postgres) auto-updates dependent indexes and view
-- definitions. plpgsql FUNCTION bodies are NOT auto-updated — the two functions that read
-- this column (set_offline_conversion_order_id, derive_internet_transfer_event) are
-- recreated in the migrations that follow (120200, 120300), and the edge functions are
-- updated in the same branch. Apply this BEFORE those.
--
-- Historical migration files keep the old name in their text (already applied — not rerun).

alter table public.offline_conversion_events
  rename column ringba_call_id to conversion_call_id;

-- Keep the index name aligned with the new column name (the index itself keeps working
-- through the rename; this is cosmetic so greps/plans read clearly).
alter index if exists offline_conversion_events_ringba_call_id_idx
  rename to offline_conversion_events_conversion_call_id_idx;

comment on column public.offline_conversion_events.conversion_call_id is
  'Call id of the TRANSFERRED/CONVERTED call: Ringba (RGB…) or Caliber id (or CallTools numeric '
  'id during the interim). Not necessarily the original inbound call id. Basis of the per-call '
  'Order ID for Ringba; internet (CT/Caliber) keys on phone+ET-day instead.';
