-- P2.2 + P3.2 Part A: make api_logs readable by time.
--
-- APPLY ONLY IN THE QUIET WINDOW (3-8am ET) and NOT with apply_migration:
-- `create index concurrently` cannot run inside a transaction, so run this file's
-- statement with execute_sql (autocommit). If it is interrupted, drop the INVALID
-- index and retry (ACTION-PLAN operational rule 5).
--
-- Why: api_logs is 847 MB and has indexes only on id, api_type and transaction_id.
-- Every hour the health check's publisher-drop probe reads it by created_at, which
-- is a full scan: 17% of all disk reads on this database and the second-largest
-- contributor to the 2026-09-14 outage (docs/pipeline-incident-2026-09-14/README.md).
-- The new failed-save probe reads the same way, so one index serves both.
--
-- BRIN, not btree: api_logs is append-only, so created_at rises with physical row
-- order — exactly the shape BRIN is for. The index is a few dozen KB instead of
-- ~50 MB, and it builds in seconds instead of minutes on Small compute.
--
-- Rollback: drop index concurrently api_logs_created_at_brin_idx;
--   (the probes go back to full scans; nothing breaks)

create index concurrently if not exists api_logs_created_at_brin_idx
  on public.api_logs using brin (created_at) with (pages_per_range = 32);

comment on index public.api_logs_created_at_brin_idx is
  'Time-range reads for pipeline-health-check (publisher drops, failed saves). BRIN: api_logs is append-only.';
