# ORPHANS & findings — Customer Match build

Written while building the Sheet → Data Manager API pipeline for Customer Match
(branch `gads-customer-match-datamanager-api`, Sep 2026).

**Nothing here has been deleted or changed.** This is a review list. Verify each item
before acting on it. Sections 5–8 are findings *outside* this task that surfaced
during the build — they are reported, not fixed.

---

## 1. The Google Sheet — `NBA Google Customer Match`

| | |
|---|---|
| File | `NBA Google Customer Match` (Drive, owner `lara@luchadigital.com`) |
| ID | `1vTQqPITgpsOh3sQauswijCzweE8flceUL4AaXIvbfXw` |
| Tab | `NBA Converted Leads` |
| Columns | `First Name, Last Name, Email, Phone, Country, Postcode, address, address2, city, state` |
| Size | 10.1 MB |
| Last edited | **2026-08-11** — a month stale at cutover |

**Status: superseded.** The API pipeline delivers the same people, complete and daily.

**Why deleting it is worth doing, not just tidy:** it holds roughly 63,000 people's
name, email, phone and home address **in plaintext in Google Drive**, shared by link,
with no expiry and no access log anyone reads. That is the largest single PII exposure
in this system, and it now has no purpose.

**Cleanup order matters:**

1. Confirm no Google Ads **scheduled Sheet import** still reads it. If one does and you
   delete the sheet first, that audience silently stops refreshing.
2. Turn that import off.
3. Export a copy if you want an archive, then delete the sheet.

Also note the data quality it was carrying, which the API path does not: a row with
`cmeredith18@icloud.xom` (typo TLD), and rows where the zip column held a city name or
a state name. The new pipeline drops a malformed zip rather than sending it.

## 2. The `offer` column — inert, on purpose

`offline_conversion_events.offer` is populated on **0 of 71,936** monetized calls. No
pixel sends it. `cm_program()` reads it and everyone resolves to `'unknown'`.

This is **not** an orphan to remove — it is the hook the program/buyer audiences hang
on. Populating it is a Ringba/Caliber pixel change (see `CONFIG-TODO.md` §9, where
`offer` is already listed as an optional pixel parameter). Once it arrives, adding a
program audience is one Supabase secret and no code change.

`ib_source` was considered as an interim proxy and **rejected** (owner's call): it
names the phone line dialled, not the buyer. Only `nba-internet-calls` names a program
at all, and a wrong buyer assignment is worse than none.

## 3. `supabase/functions/_shared/upload-providers/` — fully orphaned

Six files, ~490 lines: `types.ts`, `index.ts`, `google-oauth.ts`, `dry-run.ts`,
`google-ads.ts`, `data-manager.ts`.

**No deployed function imports any of it.** Confirmed by grep across
`supabase/functions/`: the only match is a *comment* in `ringba-conversion-webhook`
explaining that functions deploy as single self-contained files. The live
`upload-google-offline-conversions` inlines its own copy of the OAuth helper, the
hashing, and both providers.

So there are now **two** divergent copies of the Data Manager provider, and the
orphaned one is the more complete (it has a `google_ads` provider the live function
dropped). `upload-google-customer-match` deliberately does **not** import from it
either — it follows the live convention.

**Verdict: safe to delete the directory.** Nothing reads it, and leaving it invites
someone to "fix" a bug in the copy that does not run.

## 4. Customer Match removals — not built

Add-only by design (owner's call). `audienceMembers:remove` exists in the API and is
not implemented, and no rule populates a removal queue. Google expires members per the
audience's membership duration.

If removals are ever wanted, the shape is already there: add a `removal_pending`
status to `customer_match_members` and a second call in the uploader. There is no
opt-out or DNC column on `leads` today, so a rule would need a source of truth first.

---

## 5. ⚠️ PII views are readable with the publishable key — pre-existing

**Not caused by this work, not changed by it. Worth fixing separately.**

Three views are owned by `postgres`, carry **no `security_invoker`**, and grant
`SELECT` to `anon`:

| View | `anon` can select | `security_invoker` |
|---|---|---|
| `v_offline_conversion_export` | **yes** | no |
| `v_offline_cv_upload_daily` | **yes** | no |
| `v_google_sheet_export_unsynced` | **yes** | no |
| `lead_report_detail` | no | **yes** |
| `lead_report_daily` | no | **yes** |

A view without `security_invoker` runs as its **owner**, so it bypasses the RLS that
protects `leads` and `offline_conversion_events`. `v_offline_conversion_export`
exposes `email`, `phone`, `first_name`, `last_name` and `zip`. The publishable
(anon) key is, by design, public — it ships in the funnel's client-side JavaScript.

The `lead_report_*` views get this right, which is what makes the difference visible:
`DECISIONS.md` records deliberately gating lead-level PII behind a secret token so
"the publishable key alone can't pull personal data". These three views defeat that.

**Suggested fix, not applied:**

```sql
alter view public.v_offline_conversion_export     set (security_invoker = true);
alter view public.v_offline_cv_upload_daily       set (security_invoker = true);
alter view public.v_google_sheet_export_unsynced  set (security_invoker = true);
revoke all on public.v_offline_conversion_export    from anon, authenticated;
revoke all on public.v_offline_cv_upload_daily      from anon, authenticated;
revoke all on public.v_google_sheet_export_unsynced from anon, authenticated;
```

**Check before running it.** The edge functions use the service-role key and are
unaffected, but confirm nothing reads these views with the anon key first — a Sheets
Apps Script or a dashboard would break. Test on one view and watch for a day.

Everything this branch adds is built the safe way: `security_invoker = true` on every
view, an explicit `revoke` from `anon` and `authenticated`, and RLS on the ledger
table. The revoke is mandatory rather than tidy, because Supabase's default privileges
grant `SELECT` on new objects in `public` to `anon` — and a **materialized view cannot
carry RLS at all**, so the revoke is the only thing protecting
`mv_monetized_callers`.

## 6. ⚠️ Dry runs strand rows in `upload-google-offline-conversions` — pre-existing

**Not changed by this work.**

The conversion uploader increments `upload_attempts` on dry runs:

```ts
if (provider.name === "dry_run") {
  await supabase.from("offline_conversion_events").update({
    upload_attempts: (row.upload_attempts ?? 0) + 1, ...
```

while its selection filters `.lt("upload_attempts", MAX_ATTEMPTS)` with
`MAX_ATTEMPTS = 6`. So **six dry-run cycles push a row past the cap permanently**. The
row keeps a ready status, never becomes `failed`, and is never selected again — so it
is invisible to the backlog probe, which applies the same eligibility.

Not currently biting: the pipeline has been live (`data_manager`) since the Sep-2026
cutover. It would bite on the next extended dry-run test, which is exactly when
someone would be least likely to suspect it.

`upload-google-customer-match` deliberately does **not** bump attempts on a dry run,
for this reason. The comment at that line points here.

## 7. Type errors in `pipeline-health-check` — pre-existing, cosmetic

`deno check` reports **4** `TS2345` errors on `main` and **5** after this branch — the
new Customer Match probe follows the file's existing
`supabase: ReturnType<typeof createClient>` pattern, which supabase-js v2 rejects
because an untyped client infers a `never` schema.

Type-check only. Deno strips types at runtime and Supabase deploys without checking,
so behaviour is unaffected. The new `upload-google-customer-match` is fully type-clean
(it types the client structurally instead); the same one-line change would clear all
five here.

## 8. `normalize_email_for_google()` is partial

The SQL helper lowercases and strips dots for `gmail.com` only. Google also wants
whitespace removed, `+tag` suffixes dropped, and `googlemail.com` treated as gmail.

Not changed — it feeds the offline-conversion path and altering it would change what
that pipeline sends. `upload-google-customer-match` implements the complete rules in
TypeScript instead, with a comment saying why it does not reuse this function. If the
two are ever unified, unify upward to the complete rules and re-verify conversion
match rates.

---

## Confirmed NOT orphans

Checked during this build and all still live: `v_offline_conversion_export` (read by
the conversion uploader), cron jobids 8/10/11, and `offline_conversion_events` itself —
this pipeline only ever **reads** it.

---

## 7. Found 2026-09-14 — operational gaps (reported, not changed)

| Item | Why it matters |
|---|---|
| `_shared/upload-providers/google-ads.ts` sends a `developer-token` header | Google sunset developer tokens on 2026-09-09 and will reject them in API releases from H1 2027. Nothing live uses this file (see §3), so there is no impact today — one more reason to delete the directory. Both live uploaders use the Data Manager API, which never needed a developer token. |
| No index on `leads.created_at` | Every date-filtered query scans 160k rows. Build it with `CREATE INDEX CONCURRENTLY` in a quiet window after the compute upgrade — a plain build blocks lead inserts. An interrupted `CONCURRENTLY` build leaves an INVALID index: drop it and retry. |
| `api_logs` is 845 MB (~520k rows) with no `created_at` index | Largest table, same scan risk. Consider retention or archiving. |
| Webhooks return 200 when their own insert fails | Ringba/Caliber never retry, so a database hiccup silently drops conversions — 56 on 2026-09-11. Visible only in function logs. Worth a health-check alert. |
| Health-check email subject always reads "Offline-conversion pipeline" | A Customer Match-only problem arrives under a conversions subject and reads as "conversions are broken." Worth giving each section its own subject line. |
