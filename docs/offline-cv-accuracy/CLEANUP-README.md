# Cleanup Log & Orphans — offline-cv-accuracy

Things found while building this branch. **Nothing here is acted on automatically** — it's a
punch-list for you to prioritize later. None is required for the accuracy fix.

## Retired / superseded by this branch (verify, then delete after switchover)
- **`derive_internet_transfer_event` (old phone/day grain)** — Phase 2 replaces it with a per-call
  version. The old dedupe (`ringba:call_transferred:<phone>:<ET-date>`) undercounted internet
  transfers. Superseded, not dropped, so historical rows keep their keys.
- **Old phone/day Order-ID suffixing (`_B/_C`)** — stays only as a rare no-call-id fallback. Once
  every call carries a call id (`call_uuid`/RGB), this branch of the identity logic is dead code and
  can be removed.
- **`ready_to_upload` status alias** — pre-rename alias still accepted by the uploader. Remove once
  no rows carry it (`select count(*) … where status='ready_to_upload'` = 0).

## Dual-upload path (still live — resolve at switchover)
- `sync-google-sheet` (Sheet path) **and** `upload-google-offline-conversions` (Data Manager API)
  both run. Kept in parallel intentionally for now. At switchover: point the API CCO destination at
  the real CCO action, turn OFF the Google Ads Sheet scheduled import, then disable the Sheet cron
  (`select cron.unschedule('sync-google-sheet-15min');` — reversible). See `SWITCHOVER.md` (added in
  Phase 5). Do **not** disable the Sheet blind.

## Orphans (unchanged, unclear role)
- **`export-google-sheet-csv`** edge function — likely a manual/one-off export tool. Confirm + doc or remove.
- **`backfill-google-sheet-pii`** edge function — likely a one-time backfill, already run. Confirm + remove.
- **`DECISIONS.md`** — referenced by the *site* repo `CLAUDE.md` line 11 but does not exist in either
  repo. Either create it or drop the reference so it stops pointing at nothing.

## Notes (leave as-is)
- **`prune-sheet-rows-by-order-id`** — deliberate manual cleanup tool, keyed on Order ID. Keep.
- **`source` column is mislabeled** — `ringba-conversion-webhook` hardcodes `source='ringba'` for
  BOTH Ringba and CallTools/internet fires. Reporting must fingerprint by id format
  (`RGB…` vs numeric), value ($ vs flat $6), and now `ib_source`. A future `?source=` param on the CT
  pixel (or deriving it at ingest) would make `source` trustworthy. Low-risk, high-clarity — not done
  here to keep the branch focused.

## EDU (Phase 8, deferred)
- EDU transfers already flow through Ringba as normal transfers (counted). EDU **monetizations** are
  entered manually EOD — no pixel. Needs a data source before we can automate. See `EDU-TODO.md`.
