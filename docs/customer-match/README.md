# Google Ads Customer Match — Supabase → Data Manager API

Replaces the manual **`NBA Google Customer Match`** Google Sheet with an API pipeline
that mirrors the offline-conversion path cut over in Sep 2026.

| | Before | After |
|---|---|---|
| Source of truth | A Google Sheet, edited by hand | `mv_monetized_callers` in Supabase |
| Freshness | Last edited 2026-08-11 (a month stale) | Daily, 05:35 ET |
| PII location | Plaintext in Google Drive | Hashed in flight; never stored outside `leads` |
| Delivery | Google Ads scheduled Sheet import | Data Manager API `audienceMembers:ingest` |
| Audience size | Whatever was pasted last | 63,698 people, complete |

---

## How it fits together

```
offline_conversion_events ──┐
                            ├─► mv_monetized_callers ──► v_customer_match_candidates
leads ──────────────────────┘   (MASTER, daily)          (audience membership)
                                        │                         │
                                        │                         ▼
                                        │              customer_match_members
                                        │                  (upload ledger)
                                        │                         │
                                        └──► v_customer_match_upload_queue ◄┘
                                                       │
                                                       ▼
                                      upload-google-customer-match  (daily cron)
                                                       │
                                                       ▼
                                   Data Manager API  audienceMembers:ingest
                                                       │
                                                       ▼
                                    Google Ads audience  List ID …1997
```

## Membership rule

**Every monetized call with revenue, from every source.**

```sql
event_type = 'call_converted_revenue'
and conversion_value > 0
and conversion_time between '2025-01-01' and now() + 1 day
and (publisher is null or publisher in ('', 'NBA'))
```

There is **no Google/YouTube source filter**, and that is deliberate. A *conversion*
may only be reported to the channel that earned it, which is why
`v_offline_conversion_export` carries a deny-list. An *audience* has no such
constraint — a customer is a customer whichever channel produced them. This pipeline
never reads that view, so the deny-list and this pipeline cannot affect each other.

Excluded and why:

| Excluded | Count | Reason |
|---|---|---|
| `conversion_value = 0` | 268 | Never billed, so not a customer |
| `conversion_time < 2025-01-01` | 44 | Junk timestamps, some as early as 2001-01-01 |
| A non-NBA `publisher` | 0 today | Would be someone else's customer |
| No NANP phone | 42 events | Nothing to key an identity on |

## The objects

| Object | What it is |
|---|---|
| `mv_monetized_callers` | **MASTER.** One row per person: PII, `first/last_monetized_at`, `monetized_calls`, `total_revenue`, `programs[]`, `sources[]`. Materialized, refreshed daily. Query or CSV-export this for any ad-hoc question. |
| `v_customer_match_candidates` | Audience membership: `(audience_key, member_key)`. Identifiers only. |
| `customer_match_members` | Upload ledger. Phone digits + status only — **no other PII at rest**. |
| `v_customer_match_upload_queue` | Pending members joined to their PII. The only thing the uploader reads. |
| `cm_phone10()` / `cm_program()` | Key normalizers. `IMMUTABLE`, so they can back indexes. |
| `refresh_customer_match_members()` | Daily rollup + queue merge. Carries its own raised `statement_timeout`. |
| `cm_record_outcome()` / `cm_mark_awaiting()` / `cm_release_awaiting()` | Batch state transitions, one round trip each. |
| `cm_upload_backlog()` | What `pipeline-health-check` reads. |

### Why `mv_monetized_callers` is materialized

**Do not "simplify" it back to a plain view.** The rollup aggregates ~72,000 events
and joins ~160,000 leads. Measured on this instance, **warm**:

```
Execution Time: 14725.774 ms
```

`service_role` carries an **8 s** `statement_timeout` (migration `20260821000300`).
A plain view would therefore time out on every run — and *silently*, because
pg_cron's `net.http_post` only dispatches and never sees the response. That is the
Aug-2026 outage exactly (`docs/pipeline-incident-2026-08/`).

So the expensive work happens once a day inside `refresh_customer_match_members()`,
which sets its own `statement_timeout = 300s`, and the uploader only ever does
indexed lookups. A useful side effect: ad-hoc queries against the master return
instantly instead of taking 15 seconds.

## Environment

Set in Supabase → Edge Functions → Secrets.

| Secret | Value | Notes |
|---|---|---|
| `GOOGLE_CUSTOMER_MATCH_ENABLED` | `true` to send | **Separate from `GOOGLE_UPLOAD_ENABLED`.** Unset/false = dry run. A Customer Match problem can never stop conversion uploads. |
| `GOOGLE_CM_AUDIENCE_ID_ALL` | `…1997` | The universal audience's Google Ads **List ID**. |
| `GOOGLE_CM_AUDIENCE_ID_<PROGRAM>` | — | One per program, later. Suffix lowercased **is** the `audience_key`. |
| `GOOGLE_CM_BATCH_SIZE` | default `5000` | Google's hard cap is 10,000. |
| `GOOGLE_CM_CONSENT` | default `granted` | Set `denied` only if consent posture changes. US traffic, TCPA consent on every lead. |
| `GOOGLE_CM_ENDPOINT` | default prod | Override for staging only. |

Reused, already set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
`GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_LOGIN_CUSTOMER_ID`, `UPLOADER_INVOKE_SECRET`.

The OAuth refresh token already carries the `datamanager` scope, which covers
`audienceMembers`. No new Google Cloud Console work is needed.

## Production state (2026-09-14)

| Piece | State |
|---|---|
| `mv_monetized_callers` | Built — 63,765 people |
| Audience `…1997` | 61,000 delivered. 2,765 pending — delivered by the next upload run |
| `upload-google-customer-match-daily` — 09:35 UTC | **Active.** Invoked with `skip_refresh=true&limit=10000` |
| `customer-match-refresh-daily` — 09:30 UTC | **Deactivated** until the Supabase compute size is upgraded. Until then, **no new** monetized callers are queued |
| Secrets | `GOOGLE_CM_AUDIENCE_ID_ALL` and `GOOGLE_CUSTOMER_MATCH_ENABLED=true` set |

After the compute upgrade, turn the rollup on (a row update, not DDL — safe):

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'customer-match-refresh-daily'),
  active := true);
```

## Operational cautions — read before changing anything

Learned in production on 2026-09-11, when building this pipeline caused a lead-pipeline
outage: **120 lead submissions and 56 conversion postbacks lost**, 20:50 UTC Friday to
02:55 UTC Saturday.

1. **The instance is undersized.** 1.35 GB of data against ~384 MB of effective cache
   (224 MB `shared_buffers`). A large scan evicts the cache; `count(*)` on `leads` went
   from ~5 s to more than 60 s under load.
2. **Never run the rollup through PostgREST** (no `?refresh_only=true`, no
   `supabase.rpc('refresh_customer_match_members')`). It runs past the ~60 s gateway
   timeout, strands connections, and exhausts the PostgREST pool that `submit-lead` and
   the webhooks share. Run it only as SQL in pg_cron.
3. **Any migration (DDL) forces a PostgREST schema-cache reload.** On this instance the
   reload can stall, and while it does every API request fails with `PGRST002` —
   lead inserts included. Apply DDL only in a quiet window, ideally after the compute
   upgrade. Enabling, disabling or retiming a cron job is a row update and is safe.
4. **PostgREST silently caps responses at 1,000 rows.** Page every read.
5. **One uploader invocation handles at most ~10,000 members** — 25,000 returns
   `WORKER_RESOURCE_LIMIT`.
6. **Don't scan big unindexed tables during traffic:** `leads` (no `created_at`
   index), `api_logs` (845 MB, no `created_at` index), `cron.job_run_details`,
   `net._http_response`. Answer time-based questions from the Supabase log explorer.
7. **Don't `pg_sleep` in SQL to wait for async work** — it holds a pooler connection.

## Verify

```sql
-- ledger health, per audience
select audience_key, status, count(*), min(first_seen_at), max(uploaded_at)
from customer_match_members group by 1,2 order by 1,2;

-- the master
select count(*) people, sum(monetized_calls) calls, sum(total_revenue) revenue
from mv_monetized_callers;

-- identifier coverage — this is what drives Google's match rate
select count(*) total,
  count(*) filter (where email is not null) with_email,
  count(*) filter (where first_name is not null and last_name is not null and zip is not null) with_address
from mv_monetized_callers;

-- what Google said, most recent first
select created_at, request_payload->>'audience_key' audience,
       request_payload->>'members' members, success, response_payload
from api_logs where api_type = 'cm-upload'
order by created_at desc limit 20;
```

Expect coverage near: **100%** phone, **87%** email, **70%** name+zip.

## Exporting a subset

`mv_monetized_callers` is the master and is independent of Google Ads. Run in the
Supabase SQL editor and use its CSV download.

```sql
select first_name, last_name, email, phone_e164, zip, state,
       total_revenue, monetized_calls, last_monetized_at, programs
from mv_monetized_callers
where last_monetized_at >= '2026-07-01'
  and 'aca' = any(programs)          -- once a pixel sends `offer`
order by total_revenue desc;
```

## Adding a program later

Once a pixel populates `offline_conversion_events.offer`:

1. Create the audience in Google Ads Audience manager, note its **List ID**.
2. Add the secret, e.g. `GOOGLE_CM_AUDIENCE_ID_ACA=<list id>`.
3. Done. **No code change, no redeploy** — provided the rollup job is active (see *Production state*).

The uploader reads every `GOOGLE_CM_AUDIENCE_ID_*` secret at runtime, and the suffix
lowercased is the `audience_key`. People who resolved to a program before its audience
existed are parked at `awaiting_destination` — a status the health check ignores — and
`cm_release_awaiting()` returns them to the queue automatically on the next run.

Program lists are a **strict subset** of the universal list: a person is emitted once
for `all` and once more for each program. Google Ads has no hierarchy between lists,
so the subset relationship is maintained here, not by Google.

## Rollback

| Undo | How |
|---|---|
| Stop sending, keep everything | Set `GOOGLE_CUSTOMER_MATCH_ENABLED=false`. Next run dry-runs. |
| Stop the schedule | `select cron.unschedule('upload-google-customer-match-daily');` and `select cron.unschedule('customer-match-refresh-daily');` |
| Stop one program | Remove that `GOOGLE_CM_AUDIENCE_ID_*` secret. Its members park, they are not lost. |
| Requeue everything | `update customer_match_members set status='pending', upload_attempts=0;` Re-sending is harmless — Google de-duplicates on the hashed identifier. |
| Full removal | Drop the two migrations' objects. Nothing else references them. |

The Google Sheet is untouched and still importable. See
[`ORPHANS-customer-match.md`](ORPHANS-customer-match.md).

## Known limits

- **Program is forward-only.** Nothing in the data identifies the buyer on the 71,855
  historical monetized calls, so `programs` reads `{unknown}` for all of them and no
  backfill is possible. New calls carry it once a pixel sends `offer`.
- **No removals.** Add-only by design (owner's call). Google expires members per the
  list's membership duration. `audienceMembers:remove` is not implemented.
- **The master is up to 24h stale**, refreshed immediately before each upload.
- **Identity is the phone.** A person who called from two numbers is two members.
