-- Durable fix, step 1 of 4: add the order_id column + index.
--
-- Why: the export view computed order_id with a row_number() window over the WHOLE
-- offline_conversion_events table on every read (see incident 2026-08). Storing
-- order_id once (at ingest) lets the view drop the window and read via index —
-- proven ~815ms vs ~11s, and it scales with backlog size, not table size.
--
-- Apply order matters: this (column+index) -> 000100 (trigger, so NEW rows get an
-- order_id) -> 000150 (backfill EXISTING rows) -> 000200 (view reads the column) ->
-- 000300 (restore 8s). Trigger BEFORE backfill closes the gap where a row arriving
-- mid-backfill would otherwise be missed.

alter table public.offline_conversion_events
  add column if not exists order_id text;

-- Partial index matching the API-batch predicate (unsent + ready). Makes the
-- post-rewrite read an index scan over just the backlog, not a full-table scan.
create index if not exists offline_conversion_events_api_unsent_idx
  on public.offline_conversion_events (conversion_time)
  where uploaded_at is null
    and status in ('monetize_ready','ready_to_upload','transfer_ready');
