# Cleanup Log & Open Risks

Things found while mapping the offline-conversion system for this spec package. **None acted on** —
this is a reference list for you to prioritize later. Nothing here is required for Tasks 1–3, but
Risk 1 intersects all three.

## Risk 1 — Dual upload path (both live, CONFIRMED) ⚠️ decision needed
Two crons are **both active** and both upload the **same** rows:

- `sync-google-sheet-15min` → Google Sheet → Google Ads scheduled import (Sheet path).
- `upload-google-offline-conversions` → **Google Data Manager API** (direct path).

**CONFIRMED live, not dry-run.** Recent `status='uploaded'` rows contain real Google responses
(`{"requestId": "..."}`), **zero** dry-run markers, across 39,518 rows from 2026-04-27 through
2026-07-31 22:30. Every conversion is being sent to Google **twice** (Sheet + Data Manager), both
targeting `CallConvertOffline`.

**Why the owner didn't know it was on:** the **Data Manager API ≠ the Google Ads API** the owner is
applying for. Data Manager authenticates via service account and has been running without that
access. So "I don't have Google Ads API access yet" and "the direct path is live" are both true.

**Risk:** if both create conversions on the same action, that's double-counting. Google *usually*
de-dupes offline conversions by Order ID within an action (both paths send `ringba_call_id` as Order
ID), which may be masking it — but it's fragile and it complicates Task 1.

**Action (gated on owner check — NOT yet done):** owner verifies in Google Ads → Data manager /
Connected products + the conversion action's "how conversions are recorded" whether the Sheet import,
the API, or both are creating conversions. **Once confirmed the Sheet is authoritative**, disable the
`upload-google-offline-conversions` cron (`select cron.unschedule('upload-google-offline-conversions');`
— reversible; Sheet path unaffected). **Do NOT disable blind** — if Data Manager turns out to be the
real path and the Sheet import is off, disabling it would kill all attribution. I changed nothing.

Task 1 sidesteps this: transfer rows are kept OUT of `status='ready_to_upload'`, so they ride the
Sheet only regardless of how Risk 1 is resolved.

## Orphan 1 — `DECISIONS.md` referenced but missing
`nba3/CLAUDE.md` line 11 says design decisions "live in `DECISIONS.md`… supersedes any older prose."
**No `DECISIONS.md` exists** in either the nba3 repo or the backend repo. Either it was never
committed or lives only locally. **Action:** create it, or remove the reference from `CLAUDE.md` so
it stops pointing at nothing. (The `CLAUDE.md` here is in the *site* repo, not this backend repo.)

## Orphan 2 — `export-google-sheet-csv` & `backfill-google-sheet-pii` edge functions
Two edge functions exist alongside the live pipeline whose role in the *current* flow is unclear:
- `export-google-sheet-csv` — likely a manual/one-off export tool.
- `backfill-google-sheet-pii` — likely a one-time backfill, probably already run.

**Action (later):** confirm these are one-offs and either document them as manual tools or remove
them. Not touched.

## Finding — the conversion webhook is SHARED by Ringba AND CallTools (source column is mislabeled) ⚠️
The `ringba-conversion-webhook` hardcodes `const SOURCE = "ringba"`, so **every** row is stamped
`source='ringba'` regardless of who actually posted it. Live data shows two clearly distinct senders
hitting this one endpoint:

| Population | Count | Call-id | `agent_name` | `caller_id` | Value | Who |
|---|---|---|---|---|---|---|
| Ringba calls | 14,565 | `RGB…` (50 char) | never | clean `+1…` E.164 | variable ($16–$45) | **Ringba** (real call transfers) |
| Internet | 24,457 | 9-digit numeric | present | leading-space, no `+` | flat **$6.00** | **CallTools** (internet transfers) |

**So internet monetization DOES fire from CallTools → Supabase** (to this same webhook URL), and is
mislabeled `source='ringba'`. This corrects an earlier wrong note. Implications:
- The `source` column cannot be trusted to mean "Ringba." Reporting that splits Ringba vs internet
  must use the id-format / value / agent_name fingerprint instead.
- **Cleanup candidate:** stamp a real `source` (`ringba` vs `calltools`/`internet`) at ingest — e.g.
  a `?source=` param on the CallTools postback, or derive it from the id format. Low-risk, high-clarity.
- **Task 1 relevance:** the "call transferred" event is the *phone-call* path (agent → Ringba buyer).
  Internet is a different mechanism (CT posts a lead sale, no phone transfer). Confirm with owner
  whether internet should get its own transfer conversion or stay revenue-only.
- (573 old rows have `publisher=null`, all pre-2026-04-28, before the publisher gate; harmless.)

## Note — `prune-sheet-rows-by-order-id`
This is a **deliberate** manual cleanup tool (matches Sheet rows by Order ID), not an orphan. Keeping
Order ID non-blank ([feedback-nba-order-id-format]) is what makes it work. Leave as-is. Relevant to
Task 1: transfer rows will also need non-blank Order IDs (they get `ringba_call_id`, so ✅).

## Note — repo is 3 commits of vendor history behind on some concepts
`CLAUDE.md` (site repo) describes the backend as CallTools-only in the prose but also notes it's now
dual-CRM (CallTools + Caliber). The prose and the DECISIONS.md pointer disagree. Task 2 build should
reconcile the CRM section of `CLAUDE.md` in one pass.
