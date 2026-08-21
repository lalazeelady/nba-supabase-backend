-- Durable fix, step 3 of 4: backfill order_id on existing rows.
--
-- Runs AFTER the trigger (000100) so any row arriving during/after this backfill
-- already has an order_id from the trigger (and is skipped by the `is null` guard).
--
-- Source is the current view, whose order_id is the exact windowed value — so the
-- stored column equals what the view produced. Only eligible rows appear in the
-- view; non-eligible rows are never emitted, so leaving their order_id null is fine.
--
-- NOTE: this reads the still-windowed view once (~11s), so run with a raised
-- timeout:  set statement_timeout = '180s';  before executing. Idempotent.

update public.offline_conversion_events t
set order_id = v.order_id
from public.v_offline_conversion_export v
where v.event_id = t.id
  and t.order_id is null;
