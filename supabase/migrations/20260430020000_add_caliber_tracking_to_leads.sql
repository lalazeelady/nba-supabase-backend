-- Track Caliber Leads partner submissions on each lead row, mirroring the
-- existing crm_* columns we use for CallTools. The submit-lead edge function
-- fires both requests in parallel; this gives us a per-provider audit trail.
--
-- caliber_status values:
--   pending    — lead inserted, Caliber call not yet attempted/completed
--   success    — Caliber 201 Created
--   duplicate  — Caliber 200 OK (per their dedupe policy) or 409 dedupe-rejected
--   failed     — non-2xx response or network error; check api_logs row
--   skipped    — local guard prevented the call (e.g. missing secret)

alter table public.leads
  add column if not exists caliber_status text default 'pending',
  add column if not exists caliber_lead_id text,
  add column if not exists caliber_action text,
  add column if not exists caliber_submitted_at timestamptz;

comment on column public.leads.caliber_status is
  'Caliber Leads submission status: pending/success/duplicate/failed/skipped';
comment on column public.leads.caliber_lead_id is
  'Caliber-side lead UUID returned on a successful submission.';
comment on column public.leads.caliber_action is
  'Caliber response disposition (created vs duplicate). Mirrors crm_action.';
comment on column public.leads.caliber_submitted_at is
  'Timestamp of the Caliber Leads accept response (success or duplicate).';

create index if not exists leads_caliber_status_idx
  on public.leads (caliber_status)
  where caliber_status in ('pending', 'failed');
