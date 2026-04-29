-- Track which conversion events have been emitted to the Google Sheet that
-- feeds Google Ads scheduled offline-conversion + ECL upload. The CSV export
-- endpoint only emits rows where this is null, then optionally stamps it on
-- successful read so the same row never appears in the Sheet twice.

alter table public.offline_conversion_events
  add column if not exists sheet_synced_at timestamptz;

create index if not exists offline_conversion_events_nba_unsynced_idx
  on public.offline_conversion_events (publisher, sheet_synced_at)
  where publisher = 'NBA' and sheet_synced_at is null;

comment on column public.offline_conversion_events.sheet_synced_at is
  'Timestamp the row was emitted into the Google Sheet feeding scheduled Google Ads upload. NULL = not yet synced. Set by export-google-sheet-csv when called with mark_synced=true.';
