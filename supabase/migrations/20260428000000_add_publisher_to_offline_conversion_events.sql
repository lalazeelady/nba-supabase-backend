-- Add publisher column for scoping uploads to NBA-attributed conversions.
--
-- The Ringba webhook fires for every conversion across all publishers; only
-- those where Publisher = 'NBA' represent NBA commission revenue and should
-- be uploaded to Google Ads. Storing publisher per-event lets the uploader
-- and any downstream syncer filter cleanly without losing the audit trail.

alter table public.offline_conversion_events
  add column if not exists publisher text;

create index if not exists offline_conversion_events_publisher_status_idx
  on public.offline_conversion_events (publisher, status)
  where publisher is not null;

comment on column public.offline_conversion_events.publisher is
  'Ringba Publisher field (e.g. ''NBA''). Uploads are scoped to publisher = ''NBA''; other rows are kept for audit but skipped at upload time.';
