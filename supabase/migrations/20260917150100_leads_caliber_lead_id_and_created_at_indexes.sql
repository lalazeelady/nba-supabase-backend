-- Indexes for the postback pipeline (owner approved 2026-09-17: apply today).
--
-- APPLY WITH execute_sql, ONE STATEMENT PER CALL, NOT apply_migration:
-- `create index concurrently` cannot run inside a transaction. CONCURRENTLY does not
-- block lead inserts. If a build is interrupted, drop the INVALID index and retry.
--
-- leads_caliber_lead_id_idx: postback_find_lead() accepts Caliber's own lead id in
--   transaction_id (Caliber sends it today). Without this index that lookup reads all
--   of leads for every postback.
-- leads_created_at_idx: v_call_through_daily and every date-filtered lead query
--   (ACTION-PLAN P2.3).
--
-- Rollback: drop index concurrently leads_caliber_lead_id_idx;
--           drop index concurrently leads_created_at_idx;

create index concurrently if not exists leads_caliber_lead_id_idx
  on public.leads (caliber_lead_id) where caliber_lead_id is not null;

create index concurrently if not exists leads_created_at_idx
  on public.leads (created_at);
