# Task 3 — Can Capturing gclid/Session in Supabase Recover Unattributed Ringba Revenue?

## The question, restated
20–30% of Ringba revenue has "no value" for campaign/ad group/keyword because those callers
**called without submitting a form**, so there's no gclid to tie the call to a Google click. Can
capturing session info (gclid + contact info) in Supabase recover more of it?

## Measured numbers (not estimates)
From `offline_conversion_events` (NBA revenue events):

| Metric | Count | % |
|---|---|---|
| Total revenue events | 39,233 | 100% |
| Has a click id | 27,747 | 70.7% |
| **No click id** | 11,486 | **29.3%** |
| No click id but has revenue | 11,444 | 29.2% |
| — of those, **have email or phone** | **11,428** | **99.9% of no-click** |
| — of those, already matched to a submitted lead | 297 | tiny |

**This last row is the key.** Nearly every no-click revenue event already carries a phone (11,388)
and often an email (8,000) — forwarded from CallTools — but is **not** tied to a submitted lead.

## Your reframing was correct — here's why it works
The earlier version of this doc dismissed session capture because "a no-form visitor has no
identifier to join on." That was wrong. The right model:

> Many "no-form" callers **did** start the funnel and **typed their email/phone at the contact
> step**, then abandoned before hitting submit. On every funnel page we already capture gclid
> (`captureUTM()`). If we **persist the gclid + the email/phone the moment they're typed** — even
> without a submit — we have a `email/phone ⟷ gclid` record. Later, when that same person calls,
> CallTools collects their email/phone and forwards it on the Ringba postback. **We match the
> postback's email/phone to the stored session → recover the gclid → attribution.**

The join key is **email/phone**, captured on both sides (funnel partial + phone call). No DNI, no
GFN change, no number pool. This is a natural extension of the match the webhook already does — it
just widens the pool from *submitted leads* to *funnel-abandoners*.

**Addressable ceiling:** up to ~11,400 no-click revenue events *have* a matchable email/phone. The
**recoverable subset** = those callers who actually reached the funnel contact step and typed
contact info before abandoning. We can't know that fraction until we start capturing — but given
99.9% carry an identifier, even a modest recovery rate is worth real money.

## How it would work (design sketch — not built)
1. **Partial-capture on the funnel** (site repo): on the contact step, as email/phone are entered
   (on blur, before submit), POST `{gclid, gbraid, wbraid, email, phone, transaction_id, ts}` to a
   new lightweight endpoint. Bot fields (honeypot/time-trap) respected; no CRM call, no PII to
   CallTools — just a Supabase row.
2. **New table** `funnel_sessions` (or reuse a partial-leads concept): normalized `email` +
   `phone_last10` indexed for fast match, plus the click ids.
3. **Match at conversion time**: the Ringba webhook's `matchLead()` gains a fallback — after failing
   to match a submitted lead, look up `funnel_sessions` by `caller_id`/`caller_email` and, on a hit,
   backfill `gclid/gbraid/wbraid` onto the event. Everything downstream (Sheet/upload) already keys
   on those click ids.

### What this is better than (vs. what you already run)
- You **already** upload hashed email/phone/name for no-click rows via **Enhanced Conversions for
  Leads (ECL)** — that's why some of this revenue "finds attribution once imported to Google." ECL
  is a *probabilistic* PII match inside Google.
- Session capture recovers the **deterministic gclid** for funnel-abandoners — a stronger, exact
  match, and it gives *you* the click id in your own DB (useful for your own reporting and for the
  Caliber future, Task 2b).
- So the two are complementary: ECL is the free baseline (already live); session capture lifts the
  match rate above it for the abandoner segment.

## Important caveats (flag before building)
- **Consent/privacy:** you'd be storing email/phone a user typed but did **not** submit. This is
  first-party data you're capturing on your own site, but it should be reviewed against your privacy
  policy / TCPA posture (you're not *contacting* them from this data — just attributing — which is a
  lighter posture, but worth a conscious decision).
- **Match quality:** normalize aggressively (lowercase email, last-10 phone). Guard against a shared
  household phone matching the wrong session; prefer email match, then phone, most-recent session.
- **Recovery is a subset, not all 11k.** Cold callers who never touched the funnel are unrecoverable
  by this method (only DNI would get them — off the table for now per your call).

## Recommendation
1. **Keep leaning on ECL** (already live) as the baseline.
2. **Build the partial-capture + match** — this is the real Task 3, and your instinct sized it well.
   Sequence it **after Task 1** (and it can run on the current stack, no Caliber dependency).
3. **Optional first step:** a tiny read-only report estimating how many recent no-click callers'
   phone/email *would* have matched a funnel visit — but we can only measure that *after* capture is
   live, so honestly the fastest path to the answer is to **ship the capture and watch the match
   rate**. Low-risk: capture alone changes nothing downstream until we turn on the match fallback.

## Open questions for you
1. Privacy sign-off on storing pre-submit email/phone for attribution only?
2. Build order — after Task 1, before or alongside Caliber (Task 2)?
3. Prefer email-first or phone-first matching when both exist? (I'd default: email, then phone.)
