# Offline-Conversion Enhancements — Spec Package

Branch: `offline-cv-enhancements` (backend repo). **Nothing here changes running code.**
These are review documents. No migrations applied, no functions redeployed, nothing committed
until you approve.

## What's in here

| Doc | Task | Status |
|---|---|---|
| [TASK1-call-transferred-SPEC.md](TASK1-call-transferred-SPEC.md) | Add "call transferred" as a $0 count conversion in Google Ads | Spec — ready for your review |
| [TASK2-caliber-transition-PLAN.md](TASK2-caliber-transition-PLAN.md) | Plan the CallTools→Caliber and Ringba→Caliber transitions | Plan — ready for your review |
| [TASK3-session-capture-FEASIBILITY.md](TASK3-session-capture-FEASIBILITY.md) | Can capturing gclid/session in Supabase recover unattributed Ringba revenue? | Feasibility — ready for your review |
| [CLEANUP-README.md](CLEANUP-README.md) | Orphaned files/code + open risks found while mapping the system | Log — for later cleanup |

## The one decision that blocks everything

**Two upload paths to Google Ads are BOTH live right now** (both crons active, both processed
~9,863 of the same rows in the last 14 days):

1. **Sheet path** — `sync-google-sheet` → your Google Sheet → Google Ads scheduled import.
2. **Direct API path** — `upload-google-offline-conversions` → Google Data Manager/Ads API
   (rows sit at `status='uploaded'`, which only a *real* upload sets — so this is live, not dry-run).

If both actually reach the **same** Google Ads conversion action, you are double-counting.
If the Sheet import in Google Ads is turned off (Sheet = debug surface only), you're fine.
**I can't see your Google Ads UI — you need to confirm which path is authoritative.** Every task
below routes through exactly one path, so this answer shapes all three. See
[CLEANUP-README.md](CLEANUP-README.md#risk-1-dual-upload-path) for the full write-up.

## How to read these

You don't need to code. Each doc has:
- **What we're doing** (plain English)
- **The data flow** (before → after, in your CLICK AD => … notation)
- **Exactly what changes** (which file, which table, which Google Ads / Ringba UI step is yours)
- **Open questions** at the bottom — the things I need from you before building.

When you've reviewed, tell me which task to build first and I'll turn its spec into code
on this same branch (still no commit until you say so).
