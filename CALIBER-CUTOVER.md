# Caliber cutover — runbook

Energy moves from Ringba to Caliber first; the other offers follow one at a
time. Ringba and Caliber postbacks fire **simultaneously** for different
offers throughout, and Internet has been on Caliber all along via a separate,
older pixel that must keep behaving exactly as it does today.

Spec handed to the Caliber POC: the **Caliber Postback Spec** artifact (rev 2).
It is the contract; this file is the receiving side.

---

## What changed on our side, and why

### 1. `event=` — the endpoint is no longer the only routing signal

Both webhooks accept `event=transfer|monetize` and honour it over the URL.

This closes a failure that would have cost 100% of Energy revenue silently. The
first draft of the Caliber URLs had **both** postbacks pointed at
`ringba-transfer-webhook`. Because the conversion carried the same `call_id`, it
built the identical `dedupe_key` (`caliber:call_transferred:<call_id>`), the
upsert found the transfer row already there, no-opped, and returned
`{"ok":true}`. No error, no log line saying anything was wrong, no revenue.

With `event=`, a mis-pointed URL is now recoverable rather than fatal.

### 2. `offer=` — Caliber is no longer one undifferentiated bucket

New column `offline_conversion_events.offer`. Before this, everything Caliber
sent was `source='caliber'`, and the conversion webhook literally labelled every
Caliber row `api_type='cv-internet-caliber'`. The moment Energy migrated it would
have been filed as Internet in every log and report, with nothing to separate
them. `api_type` is now `cv-<xfr|cco>-<source>[-<offer>]`.

An unrecognised offer value is stored verbatim rather than rejected — a typo
in a pixel must never cost an event.

### 3. Upload gate: allow-list → deny-list

**This was the largest silent-loss risk in the cutover and it is not obvious.**

`v_offline_conversion_export` decided upload eligibility by positively
identifying Google traffic, with a catch-all for rows where *both* `utm_source`
and `ib_source` were blank.

Ringba sends **no `ib_source` at all**. Caliber **always** sends one. So rows
that qualified only through that both-blank catch-all — 1,569 in a
representative 7-day window, ~28% of Ringba's volume — would have moved to
"`ib_source` set but unrecognised → skip" the moment their offer migrated, and
stopped reaching Google Ads with no error anywhere. The loss would have been
caused purely by the new platform sending *more* data than the old one.

The rule is now:

```
upload if  EITHER field positively identifies Google
else skip  if EITHER field identifies a non-Google source
else       upload (unknown)
```

Stated this way it is a **strict superset** of the old rule, which was verified
against 7 days of production data before deploy: **0 regressions**, 3,416 rows
newly eligible, 624 still correctly excluded as identified non-Google.

> An earlier draft used `utm_source` precedence instead. It read more naturally
> but would have newly *excluded* rows carrying a non-Google `utm_source`
> alongside a Google `ib_source`. The supersetting form cannot regress.

### 3b. The bug this uncovered, and the backlog it drains

The old catch-all required `utm_source` **and** `ib_source` to *both* be blank.
Internet calls always carry `ib_source='nba-internet-calls'`, so only one was
ever blank — they never qualified. The rule was treating a **phone route name**
as evidence the traffic was not Google. Measured over 14 days:

| ib_source | utm_source | rows | uploaded |
|---|---|---:|---:|
| `nba` | `google` | 5,448 | 5,444 |
| `nba-internet-calls` | `google` | 62 | 62 |
| `nba-internet-calls` | *(blank)* | 2,944 | **0 — never, not once** |
| `nba` | *(blank)* | 68 | **0** |

The catch-all only ever helped **Ringba**, which sends neither field. It looked
universal; it never was.

Worse, these rows sit at status `monetize_ready` / `transfer_ready`. They look
ready in the table and the view filters them out before the uploader sees them —
**an invisible backlog that reports as healthy.** 4,054 still-recoverable rows,
2,091 of them revenue events worth **$14,842 Google never received**, plus 114
already aged past the 90-day window and permanently lost.

**The rule therefore applies to all rows, history included** (owner's decision,
4 Sep 2026), which lets the existing cron drain that backlog with no extra
tooling: the uploader runs every 15 min at `limit=250` (~1,000/hr), so it clears
in about four hours. All 4,054 have `upload_attempts = 0`, and the uploader's own
85-day cutoff skips the aged-out rows, so there is no bulk rejection and no
false REJECTING alert.

**Rollback lever.** `offline_cv_denylist_cutover()` is set to `2000-01-01` so the
rule covers everything. Setting it to a *future* date reverts every row to the
old allow-list instantly — one statement, no view rebuild, no redeploy:

```sql
create or replace function public.offline_cv_denylist_cutover()
returns timestamptz language sql immutable
as $$ select timestamptz '2099-01-01 00:00:00+00' $$;
```

### 4. Unresolved-token sanitizer

Any value that is wholly a template token — `[tag:User:gclid]`, `{{contact.x}}`,
`%FIELD%` — is treated as absent. Ringba blanks unresolved tokens, but Caliber's
behaviour is unverified, and a literal `[tag:User:gclid]` sitting in the `gclid`
column would look like real data: stored, matched against, and uploaded.

### 5. Publisher-gate alerting

Both webhooks drop any event whose `publisher` is not exactly `NBA` — api_logs
row, HTTP 200, no retry, no email. Correct for other publishers' traffic, and
*also* exactly what a Caliber pixel looks like when its publisher token resolves
to something else or not at all. `pipeline-health-check` now alerts on sustained
drops and names the values received, so "Caliber is misconfigured" is
distinguishable from "not our call" in seconds.

### 6. "No connect" drop, both endpoints

Was on the revenue webhook only. Ringba never sends a `status` field, so this is
a no-op for it.

---

## Cutover procedure

1. **Deploy** the migration, then the three functions. Order matters: the
   webhooks write `offer`, so the column must exist first.
2. **Confirm the POC has rev 2 of the spec.** The share pin must be moved or
   they will still be reading rev 1, which has neither new parameter.
3. **One test transfer + one test conversion** from Caliber on Energy, before
   any live traffic. Check the response body:
   - `cv_source: "caliber"` — not `"ringba"`, or `cv_source` did not arrive
   - `offer: "energy"` — not `null`
   - `event_type` — matches the postback fired
   - `matched_by: "transaction_id"` — ideally; `caller_id` means it fell back
     to phone; `null` means no lead matched
   - `inserted: true` — `false` means it was treated as a re-fire
4. **Run the reconciliation queries below** against that test call.
5. **Point Energy ads at Caliber, disable the Ringba Energy pixel in the same
   change.** Ringba is being removed from the Energy path entirely — if both
   fire for one call they produce different `order_id`s and Google counts it
   twice.
6. **Watch for 48h** with query 4.

## Rollback

Nothing here is destructive. In order of blast radius:

- **Upload rule only:** move `offline_cv_denylist_cutover()` to a far-future
  date (see §3b). Every row reverts to the old allow-list instantly, no
  redeploy. Rows already uploaded stay uploaded — Google de-dupes on
  `transactionId`, so re-enabling later does not double-count them.
- **Functions:** redeploy the previous version. The `offer` column simply
  stops being written; nothing reads it as required.
- **Migration:** `offer` is nullable and additive. There is no reason to drop
  it, and dropping it would break the view.

---

## Reconciliation queries

**1. Did the test call land, and in which columns?**

```sql
select id, source, offer, event_type, status, publisher, conversion_value,
       conversion_call_id, caller_id, transaction_id, lead_id,
       order_id, dedupe_key, ib_source, utm_source, conversion_time
from offline_conversion_events
where conversion_call_id = '<caliber call_id>'
order by created_at;
```

Expect **two** rows for a call that both transferred and converted: one
`call_transferred` at `$0`, one `call_converted_revenue` at the real value.
Both share an `order_id`; that is correct, because they upload to two different
Google conversion actions.

**2. Is anything being dropped at the publisher gate?**

```sql
select response_payload->>'publisher' as publisher_received,
       response_payload->>'cv_source' as cv_source,
       response_payload->>'offer'   as offer,
       count(*)
from api_logs
where created_at > now() - interval '24 hours'
  and response_payload->>'reason' = 'non-nba-publisher'
group by 1,2,3 order by 4 desc;
```

Any row here whose `cv_source` is `caliber` is a **misconfigured pixel losing
every event**. Empty result is the healthy state.

**3. Would this event actually upload to Google?**

```sql
select e.id, e.source, e.offer, e.event_type, e.status,
       (x.event_id is not null) as passes_upload_gate
from offline_conversion_events e
left join v_offline_conversion_export x on x.event_id = e.id
where e.conversion_call_id = '<caliber call_id>';
```

`passes_upload_gate = false` on a row you expect to upload means the deny-list
excluded it — check `utm_source` / `ib_source` against
`is_non_google_source()`.

**4. Energy volume, Ringba vs Caliber, by day (the cutover watch).**

```sql
select date_trunc('day', conversion_time at time zone 'America/New_York')::date as et_day,
       source, offer, event_type,
       count(*) as events,
       count(*) filter (where status = 'uploaded') as uploaded,
       round(sum(conversion_value), 2) as value
from offline_conversion_events
where publisher = 'NBA'
  and conversion_time > now() - interval '14 days'
  and (offer = 'energy' or offer is null)
group by 1,2,3,4
order by 1 desc, 2, 4;
```

Caliber Energy should rise as Ringba Energy falls, and the **total** should stay
flat. A drop in the total is the thing to catch.

**5. Are the two grains behaving?**

```sql
select source, offer, event_type,
       count(*) as rows,
       count(distinct dedupe_key) as distinct_keys,
       count(distinct order_id)   as distinct_orders
from offline_conversion_events
where created_at > now() - interval '24 hours' and publisher = 'NBA'
group by 1,2,3 order by 1,2,3;
```

`rows` should equal `distinct_keys`. If it does not, two real events collapsed
into one — the failure the `event=` parameter exists to prevent.

**6. Did any unresolved token get through?**

```sql
select id, source, offer, gclid, gbraid, wbraid, utm_source, ib_source
from offline_conversion_events
where created_at > now() - interval '7 days'
  and (raw_payload::text like '%[tag:%' or raw_payload::text like '%{{%');
```

The sanitizer strips these before they reach a column, so hits here mean the
*pixel* is sending literals — worth telling the POC even though we absorbed it.

---

## Still open / not addressed here

- **`caller_id` semantics.** The spec asks for the caller's ANI in E.164. The
  draft URLs used Ringba's `[tag:InboundNumber:NumberE164]` token, which in
  Caliber may well be the *tracking* number instead. If it is, phone-based lead
  matching degrades and phone-fallback dedupe collapses whole days. Verify on
  the first test call — query 1 shows the value received.
- **Fields stored but never uploaded.** `ip_address`, `user_agent`,
  `landing_page`, `campaign_id`/`adgroup_id`/`creative_id`/`target_id`/
  `network`, `city`, `oppref`, `msclkid`, `fbclid` are collected and stored, but
  `upload-google-offline-conversions` sends only click id + hashed
  email/phone/name+zip. The export view even hardcodes `user_agent` to `NULL`.
  They are reporting-only today. Not a defect — just don't expect them in Google.
- **Watch the first drain.** For ~4h after the migration lands, expect the
  uploader to be clearing ~1,000/hr of previously-stuck rows. Backlog will spike
  and fall. `pipeline-health-check` should not alert (a stall needs backlog high
  AND no successful upload in an hour — uploads will be flowing), but it is the
  one window where a genuine fault would be easy to mistake for the drain.
