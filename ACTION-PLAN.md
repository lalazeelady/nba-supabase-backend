# NBA — Action Plan

Started 2026-09-14. This file is the **single source of truth** for open work.

**How to use it**
- `[ ]` open · `[~]` in progress · `[x]` done · `[-]` dropped.
- Never delete an item. Mark it `[x]` or `[-]` and add the date and one line why.
- Update this file in the same session that changes anything.
- Owner: **You** = the owner, in a vendor UI or a decision. **Claude** = a coding session.

---

## Priority order (owner, 2026-09-14)

**ASAP — prevents a repeat of 9/11**
1. ~~P1.4 Upgrade compute to Small~~ — **done 2026-09-14 9:01pm ET**, during the outage (`docs/pipeline-incident-2026-09-14/`)
2. P2.1 Fix the rematch job — **now more urgent:** it hit its 2-minute timeout on most runs on 9/14. Job 11 is paused until this fix.
3. P2.2 Fix the health check's full scan of `api_logs`
4. P5.1 Close the public PII exposure
5. P3.2 Part A — alert when a lead or postback fails to save *(Claude recommends; owner to confirm)*

**Finish what is already in progress** — not prevention, but required
- P1.1–P1.3 Recovery scan, replay (deadline 2026-12-05), Customer Match upload check
- P2.4 Re-enable the Customer Match rollup after P2.1. Until then, no new customers join the audience.

**Then:** P3.1 Retire the CallTools test pixel (cleanup).

**Everything else is nice to have.**

---

## Why this list exists

The original task was to move Google Ads **Customer Match** off a manual Google Sheet onto
the Data Manager API. That was delivered (PR #15, merged 2026-09-14). While doing it:

1. **An outage, Fri 2026-09-11, 4:17pm–10:55pm ET.** The Customer Match backfill ran a
   heavy job through PostgREST, and a migration forced a PostgREST schema reload
   (`PGRST002`). Lead inserts and webhook inserts failed. Lost: **120 lead submissions,
   56 monetized-call postbacks, 6 transfer postbacks.** Root condition: the database
   server is too small (1 GB memory, 1.35 GB data).
2. **The real load was found.** Two recurring jobs cause 85% of all disk reads: the
   rematch job (68%) and the hourly health-check scan of `api_logs` (17%). Database size
   is secondary.
3. **Several pre-existing gaps were found:** a trial CallTools pixel sending $63k of
   conversions to a test-only table, public PII exposure through three views, silent
   webhook failures, retired Sheet-path code still running, and stale branches.

The developer-token sunset (Google, 2026-09-09) does **not** affect these pipelines. Both
uploaders use the Data Manager API, which never used a developer token.

---

## Operational rules — read before touching the database

1. **Until the compute upgrade, the server is fragile.** Heavy reads push live data out
   of memory.
2. **No DDL during business hours.** DDL = migrations, `CREATE INDEX`, `CREATE/ALTER`
   function or view. Every DDL makes PostgREST reload its schema. On this server the
   reload can stall, and every API call fails (`PGRST002`), including lead inserts.
   **Only in the quiet window: 3am–8am ET.** Measured Tue–Thu 9/8–9/10: 9pm–midnight ET
   still sees ~30–80 lead requests an hour, midnight–2am ~5–20, and 3am onward none.
   Those numbers predate the 2026-09-14 schedule change (calls taken only until 9pm ET),
   so re-measure (P1.6). Until then, 3–8am ET is the known-safe window.
   `cron.alter_job` / `cron.schedule` are row updates, so they are safe at any time.
3. **Never run heavy work through PostgREST** (`supabase.rpc`, `?refresh_only=true`).
   The ~60s gateway timeout strands connections and exhausts the pool that `submit-lead`
   and the webhooks share. Run heavy work as SQL in pg_cron.
4. **No `pg_sleep` in SQL.** No unbounded reads on `api_logs`, `leads` (date filters),
   `cron.job_run_details` or `net._http_response` during traffic. Answer time questions
   with the Supabase log explorer.
5. Build indexes with `CREATE INDEX CONCURRENTLY`. If a build is interrupted, drop the
   INVALID index and retry.
6. PostgREST returns at most 1,000 rows per request, silently. Page every read.
7. The deployed edge function is the source of truth. Sync the repo after every deploy
   (`nba3/DECISIONS.md`).

Full detail: `docs/customer-match/README.md` → *Operational cautions*.

---

## Phase 1 — Time-sensitive (next 48 hours)

- [ ] **P1.1 Read the recovery-scan result** · Claude · after 12:45am ET 2026-09-15
  - Why: finds the saved payloads of the 61 conversions lost on 9/11.
  - Do: read `api_logs` where `transaction_id = 'recovery-scan:2026-09-15'` (indexed
    lookup). Report `found`. If no row exists, check `cron.job` for
    `cv-recovery-scan-once` (job 14). If it is still there, it failed: unschedule it.
- [ ] **P1.2 Replay the recovered conversions** · You approve, Claude does
  - Do: re-send each saved payload to its own webhook. The webhook de-duplicates on the
    call ID, so a replay is safe. Confirm each row reaches `status = 'uploaded'`.
  - Deadline: the uploader skips conversions older than 85 days → **2026-12-05**.
  - Depends: P1.1.
- [ ] **P1.3 Verify the first Customer Match upload run** · Claude · after 5:35am ET 2026-09-15
  - Done when: `customer_match_members` shows 0 `pending`, and the hourly
    "Customer Match delivery STALLED" email stops.
- [x] **P1.4 Upgrade Supabase compute: Micro → Small** · You · **done 2026-09-14 9:01pm ET**, during the outage (confirmed: `max_connections` 90, `shared_buffers` 512 MB)
  - Where: https://supabase.com/dashboard/project/quhxbgsgtfvrasyjvaba/settings/addons →
    Compute size → Small. About +$5/month after the $10 Pro credit.
  - The database restarts (a short outage). Do it in the quiet window (3–8am ET). **Not between
    12:30 and 1:15am ET on 2026-09-15** (the recovery scan runs then).
  - Then tell Claude "upgraded".
- [x] **P1.5 Post-upgrade health check** · Claude · **done 2026-09-14 9:24pm ET**
  - Done when: leads insert, webhooks insert, uploads succeed, and there are no `PGRST002`
    errors in the logs. Depends: P1.4.
  - Result: no `PGRST002` after startup (20 min), 0 server errors, leads and postbacks save,
    239 conversions uploaded at 9:15pm ET.
  - Watch: that upload run returned 504 at the 150-second function limit after its 239 rows.
    The outage backlog makes runs long. If the 504 repeats after the backlog clears, lower the
    cron `?limit=250`.
- [ ] **P1.6 Re-measure after-9pm traffic under the new hours** · Claude · after 2–3 nights
  - Why: from 2026-09-14, calls are taken only until 9pm ET (calls in progress may run
    past 9). Website leads come from ads and organic search, so they may not stop at 9.
  - Do: in the log explorer, count `submit-lead` and webhook requests per hour, 9pm–3am ET,
    for the first 2–3 nights. If near zero after ~9:30pm, move the quiet window to start
    at 9:30pm ET and update rule 2.

### Outage 2026-09-14 follow-ups

Full report: `docs/pipeline-incident-2026-09-14/README.md` and `ORPHANS.md`.

- [ ] **P1.7 Count the leads and postbacks lost on 9/14** · Claude
  - Window: 4:40pm–9:02pm ET. Known so far (4:40–8:48pm): 108 failed lead inserts,
    32 failed postback inserts. Some lead failures can be retries of the same lead.
  - Do: count distinct `transaction_id` values that never reached `leads`. Then decide
    replay or accept, as on 9/11.
- [ ] **P1.8 Watch the Apps Script report `lead_report_daily_recent`** · Claude, then You
  - Facts: 95 of 95 calls failed on 9/14 on Micro. After the upgrade to Small, calls succeed
    (HTTP 200, about 750 ms). The overloaded server was the main cause.
  - Risk: 750 ms is not far from the 3-second public-key timeout. P2.3 (`leads(created_at)`
    index) makes each call cheaper.
  - You: the trigger still ran at 9:08 and 9:22pm ET, so the pause did not take effect. Check
    for a second trigger. Keep it on if you want the Sheet current.
  - Also make `nba3/DECISIONS.md` ("grant to PUBLIC") agree with migration
    `20260714000000` (revoke from `anon`).
- [ ] **P1.9 Decide about the Caliber roadmap app on the NBA database** · You decide
  - `calibercalls-priorityroadmap.netlify.app` reads and writes `roadmap_items` in this
    database. No document mentions it. It shares the lead pipeline's server.
  - Recommended: move it to its own Supabase project. Also check that `roadmap_items`
    has row-level security.
- [ ] **P1.10 Alert when a cron job hits its timeout repeatedly** · Claude
  - Why: job 11 was cancelled at 2 minutes on most runs on 9/14, and nothing alerted.
    Fold into P3.2 Part A or the health check.
- [ ] **P1.11 (Consider) Add a root `NBA/CLAUDE.md` that points to `nba3/CLAUDE.md` and this file** · Claude
  - Why: a session opened at `NBA/` does not load the project rules.

## Phase 2 — Performance fixes (after the upgrade · quiet window 3–8am ET)

- [ ] **P2.1 Fix the rematch job** · Claude · DDL
  - Why: `rematch_offline_conversion_events()` runs every 10 min, averages 68s, and causes
    **68% of all disk reads**. Each run re-checks every unmatched conversion since April.
  - Do: limit it to conversions that can still reach Google (not yet uploaded, inside the
    85-day window). Keep behaviour identical for those rows.
  - Done when: its average run time in `pg_stat_statements` is under ~2s.
- [ ] **P2.2 Fix the health check's full scan of `api_logs`** · Claude
  - Why: the publisher-drop probe reads all 847 MB every hour — **17% of disk reads**.
  - Option A (no DDL): the webhooks write `api_type = 'publisher-drop'` on those log
    rows, and the health check filters on `api_type` (a partial index exists).
  - Option B: `CREATE INDEX CONCURRENTLY` on `api_logs(created_at)`.
- [ ] **P2.3 Add an index on `leads(created_at)`** · Claude · DDL, CONCURRENTLY
  - Why: every date-filtered query scans all 160k leads.
- [ ] **P2.4 Re-enable the Customer Match rollup (job 12)** · Claude
  - Do: `cron.alter_job((select jobid from cron.job where jobname = 'customer-match-refresh-daily'), active := true)`.
  - Why it's off: until it runs, no **new** monetized callers join the audience.
  - Depends: P1.4, P2.1.
- [ ] **P2.5 Re-measure after one week** · Claude
  - Do: compare `pg_stat_statements` top queries. Decide whether to stay on Small.
  - Also identify the historic `leads.phone ilike` query (752 min total DB time). Confirm
    whether anything still runs it.
- [ ] **P2.6 (Consider) Speed up the health check's last-upload query** · Claude
  - 1.2% of disk reads. Low priority.

## Phase 3 — Webhook reliability and the CallTools test pixel

- [ ] **P3.1 Retire the CallTools test pixel and its test sink** · You, then Claude · cleanup
  - Owner, 2026-09-14: **not a revenue gap.** The pixel was set up either for the
    CallTools-side internet upload process or to test the retired Google Ads action
    `Test_DataMgrAPIUpload`.
  - Facts: since 2026-08-28, `ringba-conversion-webhook-test` stored 10,537 events in
    `offline_conversion_test` (about 500 a day). Nothing there reaches Google, so removing
    it cannot affect uploads. It only adds records and processing.
  - Do, in order:
    1. You: remove the test pixel in CallTools, so CallTools stops calling it.
    2. Claude: confirm in the logs that calls stop. Then delete the
       `ringba-conversion-webhook-test` function and the `offline_conversion_test` table
       (the table drop is DDL — quiet window).
- [ ] **P3.2 Stop silent save failures** · Claude (Part A) · You ask vendors (Part B)
  - Why: when a save fails, the webhooks still answer HTTP 200, so the sender never
    retries (62 postbacks lost on 9/11). The failure is visible only in function logs —
    the health check watches uploads, not failed saves.
  - **Part A — alert (prevention, recommended ASAP):** email when a lead or postback fails
    to save. Small change, no DDL.
  - Part B — retries (nice to have): ask Ringba, Caliber and CallTools whether they retry
    pixels that get a non-2xx response. If yes, return 5xx on a failed save.

## Phase 4 — Customer Match follow-through

- [ ] **P4.1 Connect audience `9470111997` to campaigns** · You · confirm status
- [ ] **P4.2 Retire the old Customer Match sheet** · You
  - Do, in order:
    1. Turn off any Google Ads scheduled import from the sheet.
    2. Unlink the old audience from campaigns.
    3. Export a copy if wanted.
    4. Delete the sheet.
  - Sheet: "NBA Google Customer Match", Drive ID `1vTQqPITgpsOh3sQauswijCzweE8flceUL4AaXIvbfXw`.
  - Why delete: it holds about 63k people's name, email, phone and address in plaintext.
- [ ] **P4.3 Add `&offer=` to the Ringba and Caliber conversion pixels** · You
  - Values: `aca`, `energy`, `internet`, `medicare`, `final_expense`, `auto`. The webhooks
    already read this field.
- [ ] **P4.4 Per-program audiences** · You + Claude
  - Do: create one audience per program in Google Ads. Add a Supabase secret
    `GOOGLE_CM_AUDIENCE_ID_<PROGRAM>` for each. No code change.
  - Depends: P4.3 data arriving, P2.4.
- [ ] **P4.5 Give Customer Match alerts their own email subject** · Claude
  - Why: today a Customer Match problem arrives titled "Offline-conversion pipeline".

## Phase 5 — Security

- [ ] **P5.1 Close the public PII exposure** · Claude · DDL, quiet window
  - Facts: `v_offline_conversion_export`, `v_offline_cv_upload_daily` and
    `v_google_sheet_export_unsynced` bypass row security and can be read with the
    publishable key. That key is public (it ships in the funnel's JavaScript). Exposed
    fields: email, phone, first name, last name, zip.
  - 2026-09-14 check: 7 days of gateway logs (9/8–9/14) show only our own edge
    functions reading these views (162–192 reads a day). No sign of outside access.
    Not an emergency — fix in a planned night window.
  - Do: first confirm nothing reads these views with that key (Apps Script, dashboards).
    Then set `security_invoker = true` and revoke `anon` / `authenticated`. The SQL is in
    `docs/customer-match/ORPHANS-customer-match.md` §5.
- [ ] **P5.2 (Consider) Move the webhook secret out of pixel URLs** · You + Claude
  - Why: the secret appears in plaintext in Supabase edge logs. The webhooks already
    accept the `x-webhook-secret` header, if the vendors support custom headers.
- [ ] **P5.3 (Optional) Google Cloud project owners** · You
  - Confirm Owner/Editor roles on Cloud project `893010372944`. Google will send Ads API
    admin mail there after the API Center closes (first half of 2027).

## Phase 6 — Data retention

- [ ] **P6.1 Decide a retention period for `api_logs`** · You decide, Claude builds
  - Facts: 847 MB, 62% of the database, kept since 2026-04-02. It holds copies of data
    already stored elsewhere.
  - Suggest: keep at least 90 days. It is the recovery source, and it matches Google's
    upload window. Delete older rows in batches, in the quiet window.
  - Note: deleted space is reused by new rows, but the file does not shrink without
    `VACUUM FULL` / `pg_repack`. Those lock the table, so run them only if disk size
    matters.

## Phase 7 — Cleanup: orphans and the retired Sheet path

- [ ] **P7.1 Unschedule jobs 3 and 4 on or after 2026-09-17** · Claude
  - Jobs: `sync-google-sheet-15min` and `archive-old-sheet-rows-daily`.
  - Why: the offline-conversion Sheet path retired on 2026-09-03, and its rollback window
    closes around 9/17. These jobs still read the big tables.
- [ ] **P7.2 Delete the Sheet-era edge functions** · Claude
  - Functions: `sync-google-sheet`, `archive-old-sheet-rows`, `export-google-sheet-csv`,
    `prune-sheet-rows-by-order-id`, `backfill-google-sheet-pii`. Depends: P7.1.
- [ ] **P7.3 Delete `supabase/functions/_shared/upload-providers/`** · Claude
  - Why: no function imports it. Its `google-ads.ts` sends a developer token, which Google
    stops accepting in the first half of 2027.
- [ ] **P7.4 Fix the dry-run bug in `upload-google-offline-conversions`** · Claude
  - Why: a dry run counts as an upload attempt. After six dry runs, a row silently leaves
    the upload queue.
- [ ] **P7.5 Database contract cleanup** · Claude · one migration, quiet window
  - Drop `offline_conversion_events.ringba_call_id` and trigger
    `trg_00_sync_conversion_call_id`.
  - Remove the `ready_to_upload` alias from the uploader, `offline_cv_api_backlog()` and
    the health check, all together.
  - Drop `leads.lead_source`, after confirming no report reads it.
  - Wire through or remove the hardcoded NULL `session_attributes` / `user_agent` in
    `v_offline_conversion_export`.
  - After P7.1: `sheet_synced_at` and `v_google_sheet_export_unsynced`.
  - **Verify first:** older notes call `google_ads_customer_id` unused, but the uploader
    reads it.
- [ ] **P7.6 Remove the legacy secret `GOOGLE_DATA_MANAGER_DESTINATION_ID`** · You
  - `_CALLMONETIZE` is set, so the old fallback is unneeded. Also confirm the
    `Test_DataMgrAPIUpload` action is paused in Google Ads.
- [ ] **P7.7 (Consider) Mark the 153 stranded rows expired** · Claude
  - Why: they are older than 90 days, can never upload, and inflate "pending" counts.
- [ ] **P7.8 (Consider) Full email normalization for offline conversions** · Claude
  - `normalize_email_for_google()` handles gmail dots only. Google also wants spaces and
    `+tags` removed, and `googlemail.com` treated as gmail. Re-check match rates after.
- [ ] **P7.9 Clear the type-check errors in `pipeline-health-check`** · Claude · cosmetic
- [ ] **P7.10 Undocumented lead source `apply.nationalbenefitalliance.com`** · You decide
  - About 6% of lead volume, Meta traffic, sends no `landing_page`. Adopt it or retire it.
  - Source: `ORPHANS-pipeline.md`.
- [ ] **P7.11 Review vendor-side items in `CONFIG-TODO.md`** · You
  - Ringba pixel name tokens, `ib_source` ordering, CallTools custom fields, the
    `employment` enum.

## Phase 8 — Repositories

- [ ] **P8.1 Backend PR #14 `field-parity-audit`** (docs, open since 2026-09-05) · merge or close
- [ ] **P8.2 nba3 PR #39 `field-parity-audit`** (docs, open since 2026-09-05) · merge or close
- [ ] **P8.3 Delete the backend branch `gads-customer-match-datamanager-api`** · Claude
  - It is squash-merged as `8942b6a`.
- [ ] **P8.4 Review 8 nba3 branches that aren't merged into `main`** · Claude lists, You decide
  - `apply4-conform-ub-styling`, `docs-claudemd-dualcrm-sync`, `docs-funnel-playbook`,
    `field-parity-audit`, `nba-10dlc-consent-parity`, `nba-consent-sms-only`,
    `sitemap-cleanup`, `youtube-source-funnel-yt1`.
  - Some may already be live through a squash merge. For each: if live, delete the
    branch; if not, decide.

## Phase 9 — Documentation

- [ ] **P9.1 Fix the backend path in `nba3/CLAUDE.md`** · Claude
  - It says `/Users/larazielin/Desktop/nba/nba-supabase-backend/`. The real path is
    `/Users/larazielin/WORKSPACES/claude-workspace/claude-code/NBA/nba-supabase-backend`.
  - Its backend section also predates the dual-CRM setup (`DECISIONS.md` wins).
- [ ] **P9.2 Keep `docs/customer-match/README.md` → "Production state" current** · Claude
- [ ] **P9.3 Mark removed items in the `ORPHANS-*.md` files** · Claude
- [ ] **P9.4 Check the call-center hours shown on the site** · You
  - `nba3/CLAUDE.md` records the funnel header pill as `M–Th 9:30a–8p · F 9:30a–6p ET`.
    Confirm the funnel pages, popup and thank-you pages match the hours you now operate.

---

## Closed

- [x] 2026-09-14 — **Outage 4:40pm–9:02pm ET** diagnosed. Cause: server out of capacity (probably the disk I/O budget); no DDL. Report: `docs/pipeline-incident-2026-09-14/README.md`.
- [x] 2026-09-14 — Owner restarted the database at 8:41pm ET. It did not help (PostgREST `PGRST002`, 100% 503).
- [x] 2026-09-14 — Cron jobs 3 and 11 paused (owner approved). Rollback SQL is in the incident report.
- [-] 2026-09-14 — Pause of the Apps Script trigger for `lead_report_daily_recent`: **not in effect.** Calls continued at 9:08 and 9:22pm ET and now succeed on Small (see P1.8).
- [x] 2026-09-14 — Compute upgraded to Small at 9:01pm ET. Service restored at 9:02pm ET.
- [x] 2026-09-14 — Customer Match pipeline built, deployed, and merged (PR #15, `8942b6a`). 61,000 of 63,765 delivered to audience `9470111997`.
- [x] 2026-09-14 — Offline conversions verified end to end. Google Ads shows recent conversions on both actions.
- [x] 2026-09-14 — Developer-token sunset: no impact (Data Manager API path).
- [x] 2026-09-14 — One lost conversion ($10, 9/11 4:17pm ET) replayed; uploaded 17:15 UTC.
- [x] 2026-09-14 — Customer Match upload job 13 re-enabled. Rollup job 12 stays off until P2.4.
- [-] 2026-09-14 — 120 lead submissions lost on 9/11: accepted, no recovery (owner decision; people still saw the thank-you page and call button).

---

## Key facts

| Thing | Value |
|---|---|
| Supabase project | `quhxbgsgtfvrasyjvaba` (NBA, us-east-2, Postgres 17), org `fkbpulxltrhzruxsvejd`, **Pro** plan |
| Compute | Micro (1 GB) → target **Small** (P1.4) |
| Customer Match audience | List ID `9470111997` (secret `GOOGLE_CM_AUDIENCE_ID_ALL`) |
| Google Cloud project | `893010372944` (Google Ads API access EXPLORER, customer `435-872-7539`) |
| Backend repo | GitHub `lalazeelady/nba-supabase-backend` · `/Users/larazielin/WORKSPACES/claude-workspace/claude-code/NBA/nba-supabase-backend` |
| Site repo | `/Users/larazielin/WORKSPACES/claude-workspace/claude-code/NBA/nba3` |

**Cron jobs**

| ID | Name | Schedule (UTC) | State |
|---|---|---|---|
| 3 | `sync-google-sheet-15min` | every 15 min | **paused 2026-09-14** (outage) — retired path, P7.1 |
| 4 | `archive-old-sheet-rows-daily` | 09:07 | on — retired path, P7.1 |
| 8 | `upload-google-offline-conversions` | every 15 min | on |
| 10 | `pipeline-health-check-hourly` | :20 | on |
| 11 | `rematch-offline-conversions` | every 10 min | **paused 2026-09-14** (outage) — turn on after P2.1 |
| 12 | `customer-match-refresh-daily` | 09:30 | **off** — P2.4 |
| 13 | `upload-google-customer-match-daily` | 09:35 | on |
| 14 | `cv-recovery-scan-once` | 04:45 on 2026-09-15 | one-time, deletes itself — P1.1 |

**Edge functions (IDs for log queries)**

| Function | ID | Deployed |
|---|---|---|
| `submit-lead` | `fe9e14ca-9bd3-467e-a027-0ac9797e1038` | v63 |
| `ringba-conversion-webhook` | `1556053b-fd2e-4e51-b81a-d8ff369762ad` | v46 |
| `ringba-transfer-webhook` | `a1569e18-5995-4759-876d-720541e2e855` | v16 |
| `upload-google-offline-conversions` | `8e25a878-1d52-4d01-a83f-476cb00f1a4e` | v43 |
| `upload-google-customer-match` | `bfa3034a-344f-457b-9d5c-fb41f7516826` | v5 |
| `pipeline-health-check` | `8a6a1519-187f-4bb6-89cf-d16fafa351f8` | v9 |
| `ringba-conversion-webhook-test` | `6ec9dcbd-bb46-4c18-b98f-222f4ba69518` | v3 — P3.1 |

## Related documents

- `nba3/CLAUDE.md`, `nba3/DECISIONS.md` — project rules and design decisions
- `docs/customer-match/README.md` — Customer Match design and operational cautions
- `docs/customer-match/ORPHANS-customer-match.md` — orphans and findings from this work
- `ORPHANS-pipeline.md`, `CONFIG-TODO.md` — earlier audits
- `docs/offline-cv-accuracy/SHEET-TO-API-READY.md` — offline-conversion Sheet cutover and rollback
