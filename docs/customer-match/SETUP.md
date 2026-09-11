# Setup — what only you can do

> ## Deployment status — 11 Sep 2026
>
> | Step | State |
> |---|---|
> | Migration `20260911170000` (schema) | ✅ **Applied.** Master built: **63,765 people**, 71,933 calls, $942,690.67. `anon` cannot read it (verified). |
> | `upload-google-customer-match` | ✅ **Deployed v2.** Verified: rollup ran, 63,765 members queued `pending`. |
> | `pipeline-health-check` | ✅ **Deployed v9.** Verified `alert:false`, `problems:[]`, Customer Match section reporting `not_enabled`. Conversions pipeline unaffected (`backlog:0`). |
> | **Secrets (§2 below)** | ⏳ **WAITING ON YOU.** Confirmed unset — the uploader reports `enabled:false`, `configured_audiences:[]`, `audiences_without_destination:["all"]`. |
> | Validate against Google | ⏳ Blocked on the secrets |
> | Backfill the 63,765 people | ⏳ Blocked on the secrets |
> | Migration `20260911170100` (cron) | ⏳ Runs after the backfill is confirmed |
>
> **Nothing has reached Google yet.** The uploader is in dry-run until
> `GOOGLE_CUSTOMER_MATCH_ENABLED=true`.


Everything here is in the Google Ads or Supabase UI. No code depends on the order,
but nothing reaches Google until steps 1 and 2 are done.

Already confirmed and not repeated below: Customer Match terms accepted, account
eligible.

---

## 1. Google Ads — get the List ID

You already created the audience. Its **List ID** is the value the API needs.

1. **Tools → Audience manager → Your data segments**
2. Click the segment name.
3. Read **List ID** in the detail panel.

Google's Data Manager documentation states it plainly: *"The product destination ID
for ingesting audience members is the audience ID"*, and *"The audience ID is listed
next to List ID"*.

**Segment ID and List ID are the same number.** The `Segment ID` column in the table
view is the same user-list ID as the detail panel's `List ID`. If the two ever
disagree, the browser URL on the detail page settles it — it carries
`userListId=<the number>`.

**Recorded for this build: `9470111997`.**

You do not have to be certain. Step 5 of *First run* in
[`README.md`](README.md) validates the ID against Google without sending a single
member; a wrong one returns `INVALID_DESTINATION` within seconds.

### Membership duration

Set it on the audience while you are there. This pipeline is **add-only** — it never
removes anyone — so the list's membership duration is the only thing that ages people
out. Customer Match allows up to 540 days, or no expiry.

---

## 2. Supabase — set the secrets

**Edge Functions → Secrets.**

| Secret | Value |
|---|---|
| `GOOGLE_CM_AUDIENCE_ID_ALL` | `9470111997` |
| `GOOGLE_CUSTOMER_MATCH_ENABLED` | `true` |

Leave every other Google secret alone — this pipeline reuses
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
`GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_LOGIN_CUSTOMER_ID` and `UPLOADER_INVOKE_SECRET`
exactly as the conversion uploader uses them.

> `GOOGLE_CUSTOMER_MATCH_ENABLED` is deliberately **not** `GOOGLE_UPLOAD_ENABLED`.
> Turning Customer Match off — or breaking it — cannot stop offline-conversion
> uploads.

---

## 3. Apply the migrations

Supabase → SQL editor, in this order:

1. `20260911170000_customer_match_audience.sql` — schema. Sends nothing to Google.
2. Run the backfill by hand (README, *First run*, steps 2–6).
3. `20260911170100_schedule_customer_match_cron.sql` — the daily schedule.

The cron migration is separate on purpose: scheduling is what starts calling Google,
and you can unschedule it with one statement without touching any schema.

---

## 4. Deploy the functions

Via the Supabase MCP or the dashboard editor, per `DECISIONS.md`:

| Function | Change |
|---|---|
| `upload-google-customer-match` | **New.** |
| `pipeline-health-check` | **Additive.** A fourth section watching the audience pipeline, entirely silent while `GOOGLE_CUSTOMER_MATCH_ENABLED` is not `true`. Every existing check is untouched. |

`upload-google-offline-conversions` and `submit-lead` are **not** modified.

---

## 5. Reconnect the campaigns

Point the campaigns at the new audience. This pipeline does not touch campaign
targeting, so nothing changes in Ads until you do.

---

## 6. Stop maintaining the sheet

`NBA Google Customer Match` is now redundant. It is **not** deleted — see
[`ORPHANS-customer-match.md`](ORPHANS-customer-match.md) §1 for the cleanup steps and
for why deleting it is worth doing once this is proven (it holds 10 MB of plaintext
PII in Drive).

If the old sheet still feeds an audience through a Google Ads scheduled import, turn
that import off *before* deleting the sheet, or that list stops refreshing.
