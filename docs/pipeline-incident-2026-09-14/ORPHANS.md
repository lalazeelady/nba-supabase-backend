# ORPHANS & findings — outage diagnosis 2026-09-14

Written while diagnosing the 2026-09-14 database outage
(branch `supabase-outage-2026-09-14`).

**Nothing here was deleted or changed**, except the two cron pauses recorded in `README.md`.
This is a review list. Verify each item before you act on it.

---

## 1. `roadmap_items` table + Caliber roadmap app — undocumented

| | |
|---|---|
| Table | `public.roadmap_items` in the **NBA** database |
| Caller | `https://calibercalls-priorityroadmap.netlify.app/` (browser app, public key) |
| Documented | **No.** No match for `roadmap_items`, `calibercalls` or `priorityroadmap` in this repo or `nba3`. |
| Traffic (24 h) | About 2,240 reads (`GET ... order=sort_order.asc`) from 2 browsers (Mac, Windows). About one read every 20 seconds per open tab. A few writes (`POST`/`PATCH`) at 10:23–10:26am and 4:14–4:30pm ET. |
| Errors | `new row for relation "roadmap_items" violates check constraint "roadmap_items_status_check"` at 4:14pm ET (2×). The app sends a status value that the table does not allow. |

**Why it matters:** a separate app shares the small, fragile database that carries the lead
pipeline. During the outage, its requests held connections for up to 210 seconds each.

**Verify before acting:**
1. Who owns the app, and is it still in use?
2. Does `roadmap_items` have row-level security? The public key can read it.

**Options (owner decides):**
- A. Move the app to its own free Supabase project. (Recommended. It removes the shared risk.)
- B. Keep it here. Reduce the polling interval, and document it.
- C. Retire it.

## 2. Apps Script report → `lead_report_daily_recent` — documented, but broken

| | |
|---|---|
| Documented | Yes — `nba3/DECISIONS.md` ("Google Sheet auto-pull = Apps Script, time-triggered every 15 minutes"). |
| Caller | `Google-Apps-Script` user agent, `POST /rest/v1/rpc/lead_report_daily_recent` |
| Result (24 h) | **95 of 95 calls failed** (5xx). This includes hours when the server was healthy. |
| Duration | About 3.2 seconds per failed call when the server was healthy. |

**Not an orphan.** It is a live reporting feature that does not work. The Sheet it feeds is probably
stale.

**Probable cause (not confirmed):** the public-key roles have a 3-second statement timeout. The
report reads `leads` by date, and `leads` has no `created_at` index (P2.3). So each call scans the
table and is cancelled at about 3 seconds. Each call still uses disk.

**Conflict to check:** `nba3/DECISIONS.md` says "grant the reporting RPCs to PUBLIC".
Migration `20260714000000_revoke_anon_pii_report_objects.sql` revokes `execute` on this function
from `anon` and `authenticated`. A missing grant usually returns 401/403, not 5xx, so this conflict
is probably not the cause today. Make the docs and the live grants agree.

**Update 9:22pm ET, after the upgrade to Small:** 2 calls to `lead_report_daily_recent` and
3 calls to `lead_report_leads` succeeded (HTTP 200, about 750 ms and 170 ms). So the permission
conflict is **not** the cause. The main cause of the 9/14 failures was the overloaded Micro server.
The timeout-plus-no-index risk stays: 750 ms is not far from the 3-second limit when load rises.

**Status:** the trigger is **still running** (calls at 9:08 and 9:22pm ET). Either the pause did
not save, or a second trigger exists. Owner to check.

**Next step:** keep it on if you want the Sheet current. P2.3 (`leads(created_at)` index) makes each
call cheaper.

## 3. Test pixel → `offline_conversion_test` — already known (P3.1)

New data from this diagnosis: **1,013 writes in 24 hours**, and it kept writing during the outage
(44 failed). It adds load and gives no value. No change to the plan in `ACTION-PLAN.md` P3.1.

## 4. Cron job 3 `sync-google-sheet-15min` — already known (P7.1)

**Paused 2026-09-14** during the outage. P7.1 planned to unschedule it on or after 9/17. It can stay
paused until then.

## 5. Documentation drift

| Item | Note |
|---|---|
| No `CLAUDE.md` in the `NBA/` root folder | Project rules live in `nba3/CLAUDE.md`. A session opened at `NBA/` does not load them automatically. Consider a small root `CLAUDE.md` that points to `nba3/CLAUDE.md` and `nba-supabase-backend/ACTION-PLAN.md`. |
| `nba3/CLAUDE.md` backend path | Still says `/Users/larazielin/Desktop/nba/...`. Already P9.1. |
| `ACTION-PLAN.md` was untracked on `main` | The "single source of truth" file was not committed. It is carried onto this branch as an untracked file. Commit it with this branch, when approved. |
