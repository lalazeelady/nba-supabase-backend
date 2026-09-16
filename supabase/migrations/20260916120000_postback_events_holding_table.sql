-- Holding table for the postback-* webhooks (Caliber Postback Spec rev 9), 2026-09-16.
--
-- Why: postback-transfer-webhook and postback-monetize-webhook are in TEST, and they also
-- receive Internet calls. The legacy Caliber Internet pixel (ringba-conversion-webhook) already
-- uploads those calls, with a different order id (phone + ET day vs caliber_call_id). If the
-- postback rows were in offline_conversion_events, Google would count Internet twice, and a
-- test row could upload.
--
-- This table has the same columns, defaults and unique dedupe_key, but NOTHING reads it:
-- no uploader, no export or Sheet view, no Customer Match view, no rematch job, no triggers
-- (no derived transfer, no order id). offline_conversion_events and every legacy path stay
-- exactly as they are.
--
-- To go live later: point the webhooks' EVENTS_TABLE back at offline_conversion_events, and
-- decide separately what to do with the rows held here.

create table if not exists public.postback_events
  (like public.offline_conversion_events
     including defaults including constraints including indexes
     including generated including identity including comments);

comment on table public.postback_events is
  'TEST holding table for postback-transfer-webhook / postback-monetize-webhook (spec rev 9). '
  'Same shape as offline_conversion_events. Never uploaded: no view, job, trigger or audience reads it.';

-- Same protection as offline_conversion_events (RLS on, no policies), and no client grants.
alter table public.postback_events enable row level security;
revoke all on table public.postback_events from anon, authenticated;
