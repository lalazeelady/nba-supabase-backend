-- Give submit-lead a place to record WHY a submission failed, and support
-- flagging leads that were saved but never completed CRM dispatch (previously
-- these could sit at crm_status='pending' indefinitely).

alter table public.leads
  add column if not exists crm_error text;

comment on column public.leads.crm_error is
  'Error message when a saved lead failed CRM dispatch (set by submit-lead catch). Null on success.';
