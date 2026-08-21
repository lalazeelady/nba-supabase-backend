-- Durable fix, step 1 of 3: precompute order_id into a column.
--
-- Why: the export view computed order_id with a row_number() window over the WHOLE
-- offline_conversion_events table on every read (see incident 2026-08). Storing
-- order_id once (at ingest) lets the view drop the window and read via index —
-- proven ~815ms vs ~11s, and it scales with backlog size, not table size.
--
-- This step: add the column, add a partial index for the API read, and BACKFILL
-- existing rows straight from the current view so stored values are IDENTICAL to
-- what the view produces today (the view IS the source of truth for the format).
--
-- NOTE: the backfill runs the slow (windowed) view once — run this migration with a
-- raised timeout, e.g.:  set statement_timeout = '120s';  before executing.
-- Safe/idempotent: only fills rows where order_id is still null.

alter table public.offline_conversion_events
  add column if not exists order_id text;

-- Partial index matching the API-batch predicate (unsent + ready). Makes the
-- post-rewrite read an index scan over just the backlog, not a full-table scan.
create index if not exists offline_conversion_events_api_unsent_idx
  on public.offline_conversion_events (conversion_time)
  where uploaded_at is null
    and status in ('monetize_ready','ready_to_upload','transfer_ready');

-- Backfill from the current view (exact same order_id logic → identical values).
-- Only eligible rows appear in the view; non-eligible rows are never emitted, so
-- leaving their order_id null is fine (the view/consumers never read them).
update public.offline_conversion_events t
set order_id = v.order_id
from public.v_offline_conversion_export v
where v.event_id = t.id
  and t.order_id is null;
