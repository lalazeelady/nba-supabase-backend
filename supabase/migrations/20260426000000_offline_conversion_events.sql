-- offline_conversion_events
--
-- Normalized store of offline conversion events received from upstream
-- sources (initially Ringba) before they are uploaded to Google Ads.
--
-- Designed so that future non-form-submit attribution events (e.g. visitor
-- session matching for unknown callers) can land in the same table without
-- schema changes. The "source" + "event_type" columns differentiate them.
--
-- Status flow:
--   received        — payload stored, not yet processed
--   matched         — matched to a row in public.leads
--   unmatched       — no lead match (still kept for audit / future matching)
--   ready_to_upload — has a click identifier (gclid/gbraid/wbraid) and value > 0
--   uploaded        — Google accepted the upload
--   failed          — permanent upload failure (retries exhausted or non-retryable)
--   ignored         — admin/manual exclusion

create table if not exists public.offline_conversion_events (
  id                                uuid primary key default gen_random_uuid(),
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),

  source                            text not null default 'ringba',
  event_type                        text not null,
  status                            text not null default 'received',

  lead_id                           uuid references public.leads(id) on delete set null,
  transaction_id                    text,
  ringba_call_id                    text,
  calltools_call_id                 text,
  caller_id                         text,

  gclid                             text,
  gbraid                            text,
  wbraid                            text,

  conversion_time                   timestamptz not null,
  conversion_value                  numeric(14, 4) not null,
  currency_code                     text not null default 'USD',

  google_ads_customer_id            text,
  google_ads_conversion_action_id   text,
  google_ads_conversion_action_name text,

  upload_attempts                   integer not null default 0,
  last_upload_attempt_at            timestamptz,
  uploaded_at                       timestamptz,
  google_upload_response            jsonb,
  google_upload_error               jsonb,

  raw_payload                       jsonb not null,
  dedupe_key                        text not null unique
);

comment on table public.offline_conversion_events is
  'Normalized offline conversion events from Ringba (and future sources) staged for upload to Google Ads. See nba3/offline-conversion-tracking.md.';

comment on column public.offline_conversion_events.dedupe_key is
  'Deterministic per-event key. Format: <source>:<event_type>:<ringba_call_id> with fallback to <source>:<event_type>:<gclid>:<conversion_time>:<value> when call id is absent.';

comment on column public.offline_conversion_events.status is
  'received | matched | unmatched | ready_to_upload | uploaded | failed | ignored';

create index if not exists offline_conversion_events_status_idx
  on public.offline_conversion_events (status);

create index if not exists offline_conversion_events_gclid_idx
  on public.offline_conversion_events (gclid)
  where gclid is not null;

create index if not exists offline_conversion_events_gbraid_idx
  on public.offline_conversion_events (gbraid)
  where gbraid is not null;

create index if not exists offline_conversion_events_wbraid_idx
  on public.offline_conversion_events (wbraid)
  where wbraid is not null;

create index if not exists offline_conversion_events_lead_id_idx
  on public.offline_conversion_events (lead_id)
  where lead_id is not null;

create index if not exists offline_conversion_events_ringba_call_id_idx
  on public.offline_conversion_events (ringba_call_id)
  where ringba_call_id is not null;

create index if not exists offline_conversion_events_conversion_time_idx
  on public.offline_conversion_events (conversion_time);

-- updated_at autotouch
create or replace function public.tg_offline_conversion_events_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists offline_conversion_events_set_updated_at
  on public.offline_conversion_events;

create trigger offline_conversion_events_set_updated_at
  before update on public.offline_conversion_events
  for each row execute function public.tg_offline_conversion_events_set_updated_at();

-- RLS: matches the rest of public.* — enabled, no permissive policies.
-- Edge functions use the service role key which bypasses RLS.
alter table public.offline_conversion_events enable row level security;
