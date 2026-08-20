# Offline-conversion pipeline outage — Aug 2026 (reconciliation + fix)

**Branch:** `fix-export-view-timeout` · **Status:** prepared, NOT applied to prod, NOT committed — awaiting owner go.
**Nothing in this folder or on this branch has touched production.** Diagnosis was read-only
SELECTs plus two no-op probes (`?dry_run=true` / `?validate_only=true`, which write nothing).

---

## TL;DR

Google was showing fewer conversions than reality because **both** delivery paths out of Supabase
had silently stalled — not Ringba, not CallTools, not ingestion, not Google auth. A single database
**view read was exceeding the 8-second Postgres `statement_timeout`**, so both uploader functions
500'd *before* they sent anything.

**What restored service (2026-08-20):** raising `service_role`'s `statement_timeout` 8s → 30s so the
~11s read stops being cancelled. Both paths resumed immediately; the Sheet path caught up within
minutes and the API backlog was set to drain over a few hours.

**Important:** the view-narrowing migration in this branch (drop `raw_payload` from the window sort)
is **verified byte-for-byte identical** and a small improvement, but on its own it was **NOT enough** —
the `order_id` rank forces the full-table `row_number()` window sort, which still runs ~11s. So the
30s timeout is a **stopgap**. The **durable fix** (make the read fast, then return to 8s) is pending —
see "Durable follow-up" below.

---

## Reconciliation: Ringba/CallTools → Supabase → {Sheet, Data Manager API} → Google Ads

| Stage | Health | Evidence |
|---|---|---|
| Ringba + CallTools → `ringba-conversion-webhook` (ingest) | ✅ healthy | 2,000–2,500 events/day ingested straight through Aug 20 |
| Supabase `offline_conversion_events` (capture) | ✅ healthy | all events present; nothing lost pre-Supabase |
| **Path A: `sync-google-sheet` → Sheet → Ads import** (`CallConvertOffline`) | ❌ broke ~Aug 19 | `sheet_synced` Aug 18: 2,558/2,560 → Aug 19: 652/2,240 → Aug 20: 0/100 |
| **Path B: `upload-google-offline-conversions` → Data Manager API** (`CallXfer`, `Test_DataMgrAPIUpload`) | ❌ broke ~Aug 17 | `uploaded` Aug 14: 1,862/1,898 → Aug 17: 358/2,455 → Aug 18: 63 → Aug 19: 46 → Aug 20: 0 |

Google "last seen" dates matched exactly: CallConvertOffline Aug 19; CallXfer + Test_DataMgrAPIUpload Aug 17.

**Backlog at diagnosis (sitting in Supabase, not yet in Google, growing ~2k/day):**
- Sheet path: ~799 events / ~$8,934 (since Aug 19)
- API path: ~6,801 events / ~$38,058 (since Aug 17)

Both functions re-select any un-sent eligible row every run, so **the backlog drains itself once the
view is fast again** — no manual replay. (API is bounded to conversions ≤85 days old and ≤6 attempts;
we're well inside both.)

---

## Root cause

Both functions read the view **`v_offline_conversion_export`** (the Sheet's
`v_google_sheet_export_unsynced` is a thin wrapper on it). That view computes:

```sql
row_number() OVER (PARTITION BY et_date, phone_digits10 ORDER BY created_at, id)
```

across the **entire** `offline_conversion_events` table (LEFT JOIN `leads`), and the CTE carried the
full `raw_payload` **jsonb** column. So every read had to hash-join 67k events × 124k leads and run a
**window Sort over ~67k wide rows that spilled to disk** (external merge ~8.5 MB). The consumers'
`status` / date / `limit` filters are applied *on top of* that window CTE, so they can't prune it
(that's why even `limit=5` timed out).

- Measured baseline: **7,585 ms** — right at the role's **8 s** `statement_timeout`.
- As the table grew, the two reads crossed 8 s on different days: the heavier API read first
  (**Aug 17**), the Sheet wrapper (extra `ORDER BY`) a couple days later (**Aug 19**).
- Self-reinforcing: once a path stalls, its own backlog grows the table, keeping it stalled.
- Tell-tale: stuck rows had `upload_attempts = 0` and `google_upload_error = NULL` — the SELECT died
  *before* the send loop, so nothing was attempted, nothing failed, nothing alerted. The pg_cron
  jobs kept reporting "succeeded" because `net.http_post` only dispatches the request; the 500 is
  inside the function.

Nothing was wrong with Ringba, CallTools, ingestion, Google OAuth/service-account auth, the Sheet, or
the Data Manager destinations.

---

## What was applied to production (2026-08-20, in order)

1. **`20260820120000_narrow_offline_export_view_ip_only.sql`** — `create or replace view` carrying
   only `raw_payload->>'ip_address'` (not the whole jsonb) through the window CTE. **Verified
   byte-identical** (`new EXCEPT old = 0`, `old EXCEPT new = 0`, all 30 cols / 66,269 rows). Applied.
   *Caveat:* insufficient alone — a `count(*)` test looked like 3.3s because it pruned the window, but
   the real functions select `order_id`, which references the per-day/phone rank and forces the full
   `row_number()` sort (~11s). Kept because it's harmless and a genuine (small) improvement.
2. **`20260820140000_bump_service_role_statement_timeout.sql`** — `alter role service_role set
   statement_timeout = '30s'`. **This is what actually restored delivery.** Only affects trusted
   server-side queries (edge functions); anon/authenticated stay at their limits. Reversible:
   `alter role service_role reset statement_timeout;`. **Stopgap** — remove once the read is <8s.
3. **`20260820150000_raise_upload_cron_limit.sql`** — bumped the `upload-google-offline-conversions`
   cron from the default 50 rows/run to `?limit=250` (+150s timeout) to drain the ~6.8k API backlog
   in ~4-5h instead of ~34h. Revert to 50 once caught up if preferred.

After (2): Sheet backlog 799 → ~3 within minutes; API uploads resumed. The wrapper view needed no
change.

### Why NOT a date-bound (the approach we first picked)
We planned to bound the view by date. Investigation showed that's unsafe here: `conversion_time`
contains junk values (2001-01-01 sentinels; "emittable" rows dated back to 2025), and there are
**8 emittable rows that are unsynced and >100 days old** — a date floor could silently strand real
conversions. Column-narrowing achieves the same restore with **zero** stranding risk, so we used that.

### Rollout (once approved)
1. Apply the migration to prod (`create or replace view` — reversible, touches no data).
2. Within 1–2 cron cycles (≤30 min) both paths resume; backlogs drain over the following runs.
3. Watch `uploaded` and `sheet_synced` counts climb back to ≈ingested; confirm the 3 Google actions
   start showing a current "last seen" date again.

### Rollback
Re-run `20260807120000_offline_conversion_export_base_view.sql` (the prior definition). Reversible.

---

## Durability & the durable follow-up (recommended next task)

`offline_conversion_events` is **never pruned** — `archive-old-sheet-rows` only trims the Google
Sheet ("full history also lives permanently in offline_conversion_events regardless"). So the table
grows unbounded and this read will creep back toward 8 s in **~6 weeks** at current volume.

**Durable fix:** precompute `order_id` (incl. the per-day/phone `_B/_C` dedup suffix) **at ingest**,
store it in a column, and drop the `row_number()` window from the read-path views. Reads become simple
indexed filters (sub-second, flat as the table grows), and it unblocks safe DB pruning. Bigger change
(webhook + trigger + one-time backfill of 67k rows + view rewrite + byte-diff verification), so it's a
separate follow-up — the migration above is the safe restore for today.

---

## Stall-alert monitor (approved — see files on this branch)

The incident ran silently for 3+ days because the crons reported success while the functions 500'd.
Added a lightweight health check so a future stall pages same-day:

- `supabase/functions/pipeline-health-check/index.ts` — queries backlog age + last upload/sync times
  and emails `larazielin1@gmail.com` via Resend (reuses `RESEND_API_KEY`) when either path looks
  stalled (no successful upload/sync in the last hour while eligible backlog exists).
- `supabase/migrations/20260820130000_schedule_pipeline_health_check_cron.sql` — hourly pg_cron.

Alert thresholds are conservative (1 hour) to avoid noise; tune after a week.

---

## Orphans & cleanup candidates (for later — NONE acted on)

Carried forward / re-confirmed from `docs/offline-cv-enhancements/CLEANUP-README.md`, plus new:

1. **Dual-upload double-count risk (still open).** Monetized calls now feed BOTH the Sheet
   (`CallConvertOffline`) and the API (`Test_DataMgrAPIUpload`). Both send `ringba_call_id` as the
   Order ID, so Google should de-dupe by Order ID *within an action*, but confirm in the Ads UI which
   action(s) actually count — and whether Test_DataMgrAPIUpload is meant to be a permanent parallel
   action or retired once the API path is trusted.
2. **`source` column is mislabeled.** `ringba-conversion-webhook` hardcodes `source='ringba'` for
   everyone; CallTools/internet rows are also stamped `'ringba'`. Reporting must fingerprint by
   id-format/value, not `source`. Cleanup: stamp a real source at ingest.
3. **Junk `conversion_time` values** (2001-01-01 sentinels; some 2025 dates) in
   `offline_conversion_events`. Harmless to uploads today (Order-ID/age logic still works) but they
   block any future date-bounded optimization and skew any time-based reporting. Cleanup: identify
   source of the sentinel and null/repair.
4. **`export-google-sheet-csv` & `backfill-google-sheet-pii`** edge functions — likely one-offs;
   confirm and document-as-manual or remove.
5. **No DB retention on `offline_conversion_events`** (see Durability above) — decide a retention/
   archive policy for the table itself, not just the Sheet.

## Deferred (owner's call): EDU calls
Around **Aug 7** the EDU calls process changed, so EDU transfers + monetized calls are missing from
**both** paths. Owner chose to reconcile/restore the two broken paths first and handle EDU as a
separate follow-up. Not investigated in this pass.
