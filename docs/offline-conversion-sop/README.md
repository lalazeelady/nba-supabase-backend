# Offline conversion pipeline — SOP

**Who this is for:** an engineer or technical ops person standing this up on a new
account, brand or call platform. It assumes you can deploy a webhook endpoint, run SQL,
and get API credentials for an ad platform. It does not assume you have seen our build.

**What it produces:** phone calls that happen offline get reported back to the ad
platform that paid for them, with the right revenue attached, so the platform can
optimise bidding against real money instead of clicks.

Read §1–§3 before you touch anything. The single most expensive mistakes in this
system are silent, and all of them are decided in the design, not the code.

---

## 1. The job, in one paragraph

Someone clicks an ad, lands on your site, and calls you (or fills a form and gets
called back). The call is routed by a call platform to a buyer, who pays you. The ad
platform never sees any of that — it only saw the click. Your job is to send the call
outcome back to the ad platform, tied to the original click, with a value on it. Two
outcomes get reported separately: the **transfer** (call connected to a buyer, $0) and
the **monetized call** (buyer paid, real revenue). Two conversion actions, two upload
streams, one call.

---

## 2. Vocabulary — get this right or nothing downstream is meaningful

| Term | What it actually is | Where it comes from |
|---|---|---|
| **Lead** | A form submission on your site | Your own site / lead API |
| **Call** | An inbound or outbound phone call | Call platform / dialer |
| **Click id** (`gclid`, `gbraid`, `wbraid`, `msclkid`, `fbclid`) | Proof of a specific ad click | The landing page URL, stored on the lead |
| **`utm_source`** | Which channel the **web session** came from | The landing page URL, stored on the lead |
| **`ib_source`** (inbound route / DID label) | The **name of the phone number the caller dialled** | The call platform. A property of the *call* |
| **Offer / program** | Which product the call was sold into | The call platform campaign |
| **Conversion action** | The named bucket in the ad platform | You create these in the ad account |
| **Order id / transaction id** | The uniqueness key the ad platform dedupes on | You choose this. See §8 |

> **The distinction that trips everyone up.** `utm_source` and click ids describe a *web
> click*, and only exist if the person filled out a form. `ib_source` describes *which
> number they dialled*, and in principle exists on every single call. They are
> independent layers from different systems. A direct caller who never filled a form has
> no click id and no `utm_source` — for that person, **`ib_source` is the only signal
> that will ever exist.** Treat it as a first-class field, not a fallback.

---

## 3. Decide these five things before you build

Write the answers down and get the business owner to sign them. Every one of them
changes what the numbers mean, and changing your mind later invalidates historical
comparisons.

**3.1 What counts as one conversion?**
Our answer: one unique *originating call*, per offer, per day. A caller who calls twice
about the same offer on the same day is one conversion. A caller who converts on two
different offers is two.

**3.2 Do you upload calls whose source you cannot identify?**
Two defensible rules, and they are not close in effect:
- *Deny-list:* upload unless you positively identify a non-paid source. Maximises
  volume, sends the ad platform traffic it did not generate.
- *Allow-list:* upload only when positively attributed. Clean, undercounts.

Our answer: **allow-list.** An unattributed call can come from anywhere, including a
channel that platform did not pay for. Expect this to cost you real revenue — ours is
~19% of call revenue — and measure it as its own metric.

**3.3 Do you report the transfer, the sale, or both?**
Ours: both, to two separate conversion actions. Transfers carry $0 so revenue is not
double-counted.

**3.4 What is the click-recency limit?**
Ad platforms reject conversions whose click is older than a fixed window (90 days for
Google). Match leads to calls only inside that window — an older match is also stale
attribution and will degrade bidding.

**3.5 Who owns the numbers?**
One person signs off that uploaded revenue ≈ platform-reported revenue each week.
Without this the pipeline rots silently.

---

## 4. Architecture

Five stages. Keep them separate — the value of this design is that any stage can be
inspected, replayed or rolled back without touching the others.

```
 [1] Call platform fires a postback per call event
         │   transfer → /postback-transfer-webhook
         │   monetize → /postback-monetize-webhook
         ▼
 [2] Webhook validates, sanitises, stores  ──────►  postbacks          (one row per call event)
         │                                            │
         │  (DB trigger on insert)                    ▼
 [3] Lead match + platform attribution           postbacks.lead_id, platform, confidence
         │
         ▼
 [4] Queue one upload row per postback        ──►  platform_uploads    (per platform, per action)
         │                                          status: pending|sent|failed|skipped
         ▼
 [5] Uploader cron sends to the ad platform API
```

**Why a queue instead of uploading in the webhook:** a webhook that uploads inline loses
events when the ad API is down, cannot be replayed, and gives you no place to see *why*
a call did not upload. The queue makes "skipped" a first-class, visible state.

---

## 5. Build steps

### 5.1 Create the conversion actions in the ad account
One per outcome (e.g. `CallXfer`, `CallConvertOffline`). Set counting to **"Every"**,
not "One", or repeat business from the same click is silently discarded. Note the
destination / conversion action ids — you need them in §5.5.

### 5.2 Agree the postback contract with the call platform
Give them a written spec and version it. Demand these fields on **both** postback URLs:

| Field | Why it is non-negotiable |
|---|---|
| `call_id` (the dialer's own call id) | The only exact dedupe key. Without it you fall back to phone+day, which cannot tell a genuine call-back from one call counted twice |
| `event=transfer\|monetize` | See §12.1. This one has bitten us |
| `offer` / `program` | Otherwise every offer lands in one undifferentiated bucket |
| `ib_source` | See §2. The only signal for direct callers |
| `transaction_id` (your lead id) | Strongest lead match |
| `caller_id` in E.164 | Fallback match + dedupe key |
| `status` | So you can drop "no connect" calls before they are counted |
| All click ids: `gclid`, `gbraid`, `wbraid`, `msclkid`, `fbclid` | One per ad platform. Omitting `msclkid` from the URL makes Bing un-attributable no matter how good your data is |
| `conversion_value` and `conversion_time` | Revenue and when |
| A shared secret in a **header**, not the URL | URLs are written to logs |

Ask them two questions in writing:
1. Can one call ever be monetized twice (two buyers, or a second sale)? If yes you need
   a per-conversion id, not a per-call id.
2. Which field is `caller_id` — the caller's number, or the tracking number they dialled?
   If it is the tracking number, phone matching and phone-based dedupe both collapse.

### 5.3 Build the webhook
One shared handler, two thin endpoints that differ only in the event type they set.
Ours: [`_shared/postback-handler.ts`](../../supabase/functions/_shared/postback-handler.ts).

It must, in this order:
1. **Check the secret.** Wrong or missing → 401.
2. **Check the publisher/account tag.** Not yours → HTTP 200, log it, do not store, do
   not retry. Other people's traffic is not an error. But alert on a *sustained* run of
   these, because a misconfigured pixel of your own looks identical.
3. **Validate** required fields → 422 naming every problem at once.
4. **Drop "no connect"** → HTTP 200, not stored. Do this before dedupe, or a dead call
   claims the dedupe key that a real call needed.
5. **Sanitise unresolved tokens.** Any value that is wholly `[tag:User:gclid]`,
   `{{contact.x}}` or `%FIELD%` is the sender's template that did not resolve. Treat as
   absent. Stored, it looks exactly like real data and will be matched and uploaded.
6. **Accept aliases per field.** Senders rename things. First non-empty value wins.
7. **Store** one row, keyed unique on `(call_id, event_type)`. A re-fire returns
   HTTP 200 with `inserted: false` — success, not an error.
8. **Keep `raw_payload`** with the secret stripped. You will need it.

Return enough in the response body to debug a test call without opening the database:
resolved source, offer, event type, how the lead matched, and whether a row was inserted.

### 5.4 Lead match and attribution (database trigger on insert)

**Match order** — first hit wins, and only leads created inside the click-recency
window (§3.4):
1. `transaction_id` = your lead id
2. `transaction_id` = the call platform's own lead id
3. click id → 4. email → 5. phone (newest lead before the call, with an hour of slack)

**Attribution order** — first hit wins. Postback values beat lead values; the lead only
fills gaps:

| Signal | Confidence |
|---|---|
| Click id (`gclid`/`gbraid`/`wbraid` → google, `msclkid` → bing, `fbclid` → meta) | absolute |
| `utm_source` | confident |
| `ib_source`, via an editable route-name → platform table | confident |
| Nothing | **unknown** |

Keep the route map in a **table, not code**. Route names get added by whoever manages
the phone numbers, and you will be adding rows forever. An unmapped route name is not an
attribution failure — it is a number you have not classified yet, and it should be
visibly distinct from a call with no signal at all.

### 5.5 Queue and upload
One `platform_uploads` row per postback, per ad platform, per conversion action. Status
`pending | sent | failed | skipped`, with a `skip_reason` when skipped. **Never delete a
row to express "we did not upload this"** — skip it with a reason so it stays countable.

The uploader is a cron job that reads pending rows and sends them. Rate-limit it
(ours: ~1 row/second, ≤135 per invocation, every 15 minutes).

### 5.6 Upload safety — this is what stops you double-charging
Two independent switches, both of which must be on before anything real is sent:
1. A **master mode flag**: `validate_only` by default. In validate mode the uploader
   still runs and still calls the API, but with the platform's dry-run flag set — so you
   get real validation errors with zero risk. Flip to `live` deliberately.
2. A **per-offer hold flag**. Any offer still being uploaded by an older pipeline stays
   held, or the ad platform counts the call twice under two different order ids.

Default a *new* offer to not-held, so adding an offer does not require a code change.

---

## 6. Attribution and the unknown bucket

Report four buckets, always, and never collapse them:

| Bucket | Meaning | Uploads? |
|---|---|---|
| Attributed to your platform | click id, utm, or mapped route | yes |
| Attributed to another platform | e.g. this call came from Bing | no — correctly |
| **Identified route, unmapped** | you know which number they dialled, you have not classified it | no — **fix the map** |
| **True unknown** | no click id, no utm, no route name | no |

Mixing the last two hides your only actionable metric. The third shrinks by editing a
table. The fourth only shrinks if the call platform starts sending better data.

**Expect the true-unknown bucket to be dominated by direct callers who never filled a
form** — in ours, 97% of it. For those calls `ib_source` is the only possible signal, so
a dialer that sometimes omits `ib_source` puts a hard floor under your unknown rate that
no amount of work on your side can lift. Measure the floor, tell the business what it
costs per day, and stop treating it as a bug you can fix.

---

## 7. Dedupe — where and how

Dedupe at the **upload**, not at storage. Store every event the call platform sends, so
you can always show received vs uploaded vs dropped and reconcile against the platform's
own report.

- **Key:** the dialer's call id when you have it; otherwise caller phone + the day, in
  your reporting timezone.
- **Scope:** per offer *and* per conversion action. A transfer and a monetize event for
  the same call are two conversions in two different actions and both must upload.
- The **earliest** event wins; later ones are queued as `skipped / duplicate_call` and
  stay visible.

---

## 8. Order id — read the ad platform's dedupe rules before choosing

Google dedupes on `unique identifier + conversion name + timestamp + order id`. An order
id is an **absolute constraint**: same order id and same conversion action is rejected as
a duplicate regardless of timestamp. That cuts both ways:

- **Unique-per-call order id** (a raw call id) ⇒ the ad platform counts every row you
  send. Your pre-upload dedupe is the only thing preventing repeat callers being counted
  twice. If that logic has a hole, the platform will not catch it.
- **Stable order id** (`phone:offer:date`) ⇒ the ad platform enforces your dedupe for
  you. Survives retries, replays and re-fires that arrive after a day boundary.

Recommended: `coalesce(dialer_call_id, phone || ':' || offer || ':' || date)` — exact
when you have the call id, stable when you do not, and it upgrades itself the day the
call platform starts sending the id, with no code change.

**Do not zero out the timestamp.** It buys nothing (the order id already constrains
uniqueness) and it costs you conversion-lag and hour-of-day reporting, and can push a
conversion outside the click-recency window at the boundary.

---

## 9. Go-live sequence

1. Deploy schema, then functions — in that order, since the functions write new columns.
2. Confirm the call platform has the current spec revision. Move the share link; do not
   assume they re-read it.
3. Fire **one test transfer and one test conversion** before any live traffic. Check the
   response body: source, offer, event type, how it matched, `inserted: true`.
4. Run the reconciliation queries (§10) against that single call.
5. Leave the master switch at `validate_only` for a full day. Read every validation error.
6. Flip to `live` for one low-volume offer. Watch for 48 hours.
7. Roll out offer by offer. **Disable the old pixel for an offer in the same change that
   enables the new one** — if both fire for one call with different order ids, the ad
   platform counts it twice.

---

## 10. Reconciliation — how to prove it works

Do this for a **full, complete day**, and make sure every report you compare covers the
*same* day. (Export windows lie: a report pulled at 8pm is missing the evening.)

**Check 1 — capture.** Call platform's own revenue report vs the revenue in your table.
Should agree within ~1–2%. Gaps are almost always export cutoffs or post-call payout
revisions, both explainable per call.

**Check 2 — attribution.** Platform-attributed revenue in the call report vs in your
table. Within a few percent. Your table may run slightly *higher* — it recovers click
ids from matched leads that the call log never saw. That is fine.

**Check 3 — the upload range.** This is the real test:

```
uploaded revenue with a click id  ≤  ad platform reported revenue  ≤  total uploaded revenue
```

Below the floor means uploads are being rejected. Above the ceiling means you are
double-counting somewhere.

**Check 4 — counts.** Compare on the *same* definition or the answer is meaningless.
Dedupe your actuals by `phone+offer+date` before comparing them to deduped uploads —
comparing deduped uploads against raw call counts will show a ~14% gap that does not
exist. Counts drive revenue/call and cost/call in the ad platform, so a real gap here
distorts bidding.

---

## 11. Monitoring

Hourly, by email, with numbers in the body:
- No postbacks of either type for 2 hours during business hours.
- Lead-match rate in the last 24h more than 15 points below the prior 7 days.
- Any failed upload, or any failed validation while in `validate_only`.
- Uploads pending more than 2 hours — **only while live**, or you alert on nothing.
- Sustained events dropped at the publisher gate, **naming the values received**, so
  "someone else's traffic" and "our pixel is misconfigured" are one glance apart.

---

## 12. Failure modes that cost real money

**12.1 Two endpoints, one event type.** Our first draft pointed both postback URLs at the
transfer endpoint. Same call id ⇒ same dedupe key ⇒ the second event no-opped and
returned `{"ok":true}`. No error, no log line, 100% of that offer's revenue gone. Fix:
the event type travels in the payload (`event=`) and is honoured over the URL, so a
mis-pointed URL is recoverable instead of fatal.

**12.2 An eligibility rule that depends on a field being absent.** Ours uploaded rows
where `utm_source` *and* `ib_source` were both blank. The old call platform sent no
`ib_source` at all; the new one always sends it. Migrating an offer would have moved
those rows from "upload" to "skip" with no error anywhere — a loss caused purely by the
new platform sending *more* data. Fix: when you change an eligibility rule, prove the new
rule is a strict superset of the old one against a week of real rows before deploying.

**12.3 Unresolved template tokens.** A literal `[tag:User:gclid]` in a gclid column is
stored, matched against and uploaded. See §5.3 step 5.

**12.4 Counting rows that look ready but are filtered out.** Rows sitting at status
`ready` that the export view excludes are an invisible backlog that reports as healthy.
Your backlog metric must come from the same view the uploader reads.

**12.5 Comparing two reports from different days.** Trivial, constant, and it has wasted
more of our time than anything else on this list. Verify the date range inside every file
before you compare it to anything.

---

## 13. Migrating from an existing pipeline

1. Run both in parallel, writing to separate tables. Change nothing in the old one.
2. Move **uploads** one offer at a time, not storage. Storage can double-write safely;
   uploads cannot.
3. For each migrated offer, add a hold in the old pipeline that marks its rows
   `ignored` — stored, visible, never uploaded. Keep it reversible with one statement.
4. **Any combined "old table + new table" revenue sum must exclude the double-written
   rows**, or you will over-report during the overlap.
5. Before retiring the old pipeline, check whether its eligibility rule differs from the
   new one. Ours uploaded unknown-source rows; the new one never does. Retirement
   therefore *reduces* reported revenue by design. Tell the business the number in
   advance or it will be read as a regression.

---

## 14. Appendix — field checklist for the call platform

Track fill rate per field, per offer, weekly. A field at 0% is a contract failure; a
field that drops is an incident.

| Field | Target | What breaks without it |
|---|---|---|
| dialer call id | 100% | Exact dedupe; you fall back to phone+day |
| `ib_source` | 100% | Attribution for every caller who never filled a form |
| `event` | 100% | §12.1 |
| `offer` | 100% | Per-offer dedupe scope and all reporting |
| `status` | 100% | "No connect" calls counted as transfers |
| `transaction_id` | = your form-fill rate | Strongest lead match. Structurally capped — direct callers have no lead |
| `msclkid` / `fbclid` / other click ids | = platform share | That ad platform is un-attributable |
| `caller_id` E.164 | 100% | Phone match and dedupe fallback |

---

*Written from the NBA build, 2026-09. Worked example, code and migrations:
[`docs/postback-pipeline/README.md`](../postback-pipeline/README.md) and
[`CALIBER-CUTOVER.md`](../../CALIBER-CUTOVER.md).*
