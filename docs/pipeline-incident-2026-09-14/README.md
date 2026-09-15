# Database outage — Mon 2026-09-14 (diagnosis, actions, recovery)

**Branch:** `supabase-outage-2026-09-14` · **Status:** **service restored 9:02pm ET** by the compute upgrade to Small. Post-upgrade checks are open (see "Recovery checks").
**Code:** no code changed. **Commits:** none yet.

Times are Eastern (ET). UTC is in brackets where the logs use it.

---

## Summary

The Supabase database ran out of capacity at **4:40pm ET**. All API requests became very slow
(120–210 seconds) or failed. At **8:41pm ET** the owner restarted the database. The restart did not
fix it: PostgREST could not load its schema cache (`PGRST002`), so every API request got **503**.
The owner then upgraded compute from Micro to Small. The upgrade restarted the database at
**9:01pm ET**. Service came back at **9:02pm ET**: a lead saved in 249 ms.

The root condition is the same as on 9/11: the server (Micro, 1 GB) is too small for the load.
The trigger is different. On 9/11 the trigger was a schema change (DDL). **Today there was no DDL.**
The trigger was steady read load, mainly from the rematch job (cron 11).

---

## Timeline

| ET | UTC | Event |
|---|---|---|
| 9:00am | 13:00 | Business traffic starts (about 50× the night rate). |
| all day | — | Rematch job (cron 11) hits its **2-minute timeout** on most runs. It reads a lot of disk and saves nothing. |
| 4:35pm | 20:35 | Last normal 5 minutes. Requests take 50–500 ms. |
| **4:40pm** | **20:40** | **All requests stall at the same time**, including the very small `roadmap_items` table. Rematch run starts at 20:40:00. |
| 4:45pm | 20:45 | pg_cron cannot start jobs ("job startup timeout"). |
| 4:40–8:40pm | 20:40–00:40 | Partial outage. Many requests time out (504). Average response 11–33 seconds. |
| 8:41pm | 00:41:45 | **Owner restarts the database** ("terminating connection due to administrator command"). |
| 8:43pm | 00:43:51 | Postgres is up. PostgREST fails to load the schema cache. **Total outage: 100% 503.** |
| 8:47–9:02pm | 00:47–01:02 | Claude pauses cron jobs 3 and 11 (owner approved). Owner tries to pause the Apps Script trigger (calls still ran at 9:08 and 9:22pm). |
| 9:00pm | 01:00 | Owner's compute upgrade Micro → Small takes the database down (errors 521/522). |
| 9:01pm | 01:01:27 | Postgres starts on **Small** (`max_connections` 90, `shared_buffers` 512 MB). |
| **9:02pm** | **01:02** | **Service restored.** A lead saves in 249 ms (`POST /rest/v1/leads` → 201). |
| 9:02pm | 01:02:10 | Jobs 3 and 11 verified paused after the upgrade restart. |

---

## Root cause

**The server had no spare capacity. The most probable cause is that the disk I/O budget was used up.**

### Evidence

1. **Very small queries became very slow.** Reading one setting (`max_connections`) took 14 seconds.
   That read touches no table data. So the problem was the server, not one query.
2. **Everything stalled at the same moment**, small tables and large tables together.
3. **The restart did not help.** A restart clears memory pressure. A restart does not refill a disk
   I/O budget. After a restart the cache is empty, so the server must read even more from disk.
4. **No DDL today.** The postgres logs for 3:30–5:30pm ET show no `CREATE`, `ALTER`, `DROP` or
   `NOTIFY`.
5. Compute was still **Micro**: `max_connections = 60`, `shared_buffers` ≈ 224 MB. P1.4 was not done.

### Not confirmed

The Supabase MCP tools cannot read the disk I/O budget metric. **To confirm:** Dashboard →
Reports → Database → *Disk IO*. Supabase also sends an email when the budget runs low.

### What used the capacity

| Load | Evidence |
|---|---|
| **Rematch job — cron 11** | Runs every 10 min. Today most runs were cancelled at the 2-minute timeout (for example at 4:02, 4:12, 4:22, 4:32 and 4:42pm). Already the top disk reader (68%) in `ACTION-PLAN.md` → P2.1. |
| Google Apps Script → `lead_report_daily_recent` | 95 calls in 24 hours, **all failed** (5xx). A heavy report through PostgREST — this breaks operational rule 3. |
| Health check full scan of `api_logs` | Hourly (P2.2). |
| Test pixel → `offline_conversion_test` | 1,013 writes in 24 hours (P3.1). |
| Supabase dashboard (Table Editor) | 30–38 second queries after the restart. Opening tables adds load to a starved server. |
| Caliber roadmap app → `roadmap_items` | About one read every 20 seconds per open browser. Small alone, but it holds connections when the server is slow. See `ORPHANS.md`. |

---

## Impact

From 4:40pm to 8:48pm ET (edge logs, `POST` requests):

| Write | Saved | Failed |
|---|---|---|
| `leads` (from `submit-lead`) | 275 | **108** (504 × 81, 500 × 16, 503 × 9, 522 × 2) |
| `offline_conversion_events` (webhooks) | 196 | **32** (500 × 29, 503 × 2, 504 × 1) |

- One lead insert got `409` (duplicate `transaction_id`). So some failures can be retries of the
  same lead. The count of **lost people** can be lower than 108.
- From 8:43 to 9:00pm ET, **all** writes failed. Not yet counted.
- `submit-lead` always answers HTTP 200. Visitors still saw the thank-you page and the call button.
  The failures were silent.

---

## Actions taken

| # | Action | By | Reversible |
|---|---|---|---|
| 1 | Restart database (8:41pm ET) | Owner | — |
| 2 | Pause cron **11** `rematch-offline-conversions` | Claude, owner approved | Yes |
| 3 | Pause cron **3** `sync-google-sheet-15min` (retired path) | Claude, owner approved | Yes |
| 4 | Pause the Apps Script trigger for `lead_report_daily_recent`. **Not in effect:** calls still ran at 9:08 and 9:22pm ET. | Owner | Yes |
| 5 | Upgrade compute Micro → Small (P1.4), 9:00–9:01pm ET. **This restored service.** | Owner | Yes (downgrade) |

A cron pause is a row update in `cron.job`. It is not DDL. It does not make PostgREST reload.

### Effect of the pauses

- **Job 11 paused:** a conversion that arrives before its lead is saved does not get matched to
  the lead later. The uploader skips conversions older than 85 days, so do not leave it paused for
  weeks. Plan: fix it (P2.1), then turn it on again.
- **Job 3 paused:** no live effect. The Sheet path is retired. The rollback window for that path
  closes about 9/17 (P7.1).

### Rollback — turn the jobs on again

Run in the Supabase SQL editor. It is safe at any time.

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'rematch-offline-conversions'), active := true);
select cron.alter_job((select jobid from cron.job where jobname = 'sync-google-sheet-15min'),     active := true);
```

---

## Recovery checks (after the upgrade)

Use the log explorer, not heavy SQL. Status at 9:24pm ET 2026-09-14:

| # | Check | Status |
|---|---|---|
| 1 | **Compute size.** `max_connections` must be higher than 60. | ✅ 90 (`shared_buffers` 512 MB) |
| 2 | **No `PGRST002`** in PostgREST logs for 15 minutes. | ✅ 4, all in one second at 9:01:28pm (startup). None after that for 20 minutes. 0 server errors. |
| 3 | **A lead saves.** `POST /rest/v1/leads` returns 201. | ✅ 2 inserts (201), 4 updates (204). |
| 4 | **A postback saves.** `POST /rest/v1/offline_conversion_events` returns 201. | ✅ 3 inserts (201) at 9:08–9:10pm. |
| 5 | **Uploads run.** Cron 8 logs "completed", not "job startup timeout". | ✅ Run at 9:15pm succeeded. **239 conversions uploaded** (last 9:18:19pm). ⚠️ The function then returned 504 at its 150-second limit. See "Watch" below. |
| 6 | **Recovery scan (job 14) runs at 12:45am ET 2026-09-15.** Do not restart the database between 12:30 and 1:15am ET. | ⏳ Still scheduled and active. Read the result per `ACTION-PLAN.md` P1.1. |

**Watch — upload 504.** The outage left a backlog of conversions (4:40–9:02pm). A run with
`?limit=250` now needs almost the full 150-second function limit. The 239 rows it finished are
marked `uploaded`. A row that Google received but the function did not mark is sent again on the
next run; Google de-duplicates it by order ID. If the 504 still happens after the backlog clears,
lower the cron limit.

**Also seen:** the Apps Script report (`lead_report_daily_recent`) succeeds again on Small (HTTP 200,
about 750 ms). Its trigger was still running at 9:08 and 9:22pm ET. See `ORPHANS.md` §2.

---

## Lessons

1. **A restart does not fix a capacity problem.** It empties the cache and can make the next hour
   worse. Before a restart, check Disk IO and memory in the dashboard.
2. **A job that always reaches its timeout is the worst kind of load.** It uses the full time,
   saves no progress, and starts again from zero. Alert when a cron job hits its timeout
   repeatedly.
3. **Silent failures hide outages.** 108 failed lead saves raised no alert. P3.2 Part A (alert on a
   failed save) would have warned at 4:40pm.
4. **Do not open the Table Editor on large tables during an outage.** Each view runs heavy queries.

---

## Related

- `ACTION-PLAN.md` — open work. This incident updates P1.4, P2.1, P3.2 and P7.1, and adds new items.
- `docs/pipeline-incident-2026-09-14/ORPHANS.md` — findings from this diagnosis.
- `docs/pipeline-incident-2026-08/README.md` — the August outage (8-second statement timeout).
- `nba3/DECISIONS.md` — reporting design (Apps Script pull).
