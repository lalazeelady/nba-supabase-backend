# Task 1 — "Call Transferred" as a $0 Count Conversion

## ✅ LIVE as of 2026-08-04
Deployed & applied to production:
- `ringba-transfer-webhook` (v1, verify_jwt=false) — Ringba Incoming transfers → `CallXfer` $0.
- Migration `20260802120000` — export view emits $0 `CallXfer` rows.
- Migration `20260804120000` — trigger derives `CallXfer` from internet (non-RGB) monetizations.
- Backfill — internet transfers for 2026-08-04 (from when the Ringba pixel went live).
- Verified: 515 transfer rows (301 Ringba pixel + 213 internet backfill + 1 live trigger), all $0,
  all `CallXfer`, 0 blank Order IDs; flowing to the Sheet on the 15-min cron.

**Repo state:** files on branch `offline-cv-enhancements`, **not yet committed** (awaiting the word).
**Follow-ups:** (1) disable the non-firing CallTools transfer pixel — not needed; (2) update
FUNNEL-PLAYBOOK.md with the carve-outs in §D2; (3) revenue Data-Manager-API double-path (Risk 1) is
still unconfirmed — does NOT affect transfers (Sheet-only).

## Decisions locked
- **Signal:** a **new Ringba postback fired on _call connected_** (buyer platform receiving the
  transfer), separate from the revenue postback. Fire on connected — not every inbound ping.
- **Build:** a **brand-new dedicated edge function** `ringba-transfer-webhook`. The existing revenue
  webhook is **not touched**. Zero risk to the working revenue path.
- **Value:** **$0, count-only.**
- **Action:** **one global `CallTransferOffline`** conversion action. *No per-program split* — the
  vertical (ACA/ENE/Internet…) is decided downstream by what the caller qualifies for, so it isn't a
  property of the click and can't drive bidding. This also means **no `program` token needed in Ringba.**
- **Attribution:** launching with partial attribution is fine; Task 3 layers on later. ✅

## What we're doing
Today Google Ads only sees the **monetized** call. We want it to also see the earlier, more-frequent
**qualified-transfer** event (agent → Ringba buyer), as a $0 count conversion on its own action, so
Smart Bidding can optimize toward "calls that qualify and transfer." Revenue stays on the existing
action, untouched.

## Data flow (new leg in **bold**, everything else unchanged)
```
CLICK AD => FUNNEL/SUBMIT => LEAD TO SUPABASE => LEAD TO CALLTOOLS
   => CALL TRANSFERS (agent → Ringba buyer)
        ├─ **NEW Ringba 'call connected' postback => ringba-transfer-webhook**
        │        **=> offline_conversion_events (event_type='call_transferred', value=$0)**
        │        **=> Google Sheet => Google Ads (CallTransferOffline)**
        └─ CALL MONETIZES => existing revenue postback => existing webhook => Google  [UNCHANGED]
```
A transferred-then-monetized call yields **two** conversions (a $0 transfer + the revenue) on two
different actions. So **transfer count ≥ monetized count** — the funnel working as intended.

## Components

### A. Ringba UI (your step)
Add a **second** postback fired on **call connected**, pointing at the new function:
```
https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/ringba-transfer-webhook?secret=<secret>
```
Send the same tokens as the revenue postback — critically **`ringba_call_id`** (required for
de-dup), plus `caller_id`, `gclid/gbraid/wbraid` if present, `pub=NBA`, and any CallTools PII tags
(email/name). Value can be omitted — the function forces $0.

### B. Google Ads UI (your step)
Create **one** offline conversion action **`CallTransferOffline`** — **Count: Every**, **Value: $0 /
don't use a value**. Start it **secondary/observe-only** for 1–2 weeks to watch volume before it
influences bidding (final call yours once volume is visible). Send me the exact action name you use.

### C. New edge function `ringba-transfer-webhook` (the build)
A trimmed copy of the revenue webhook's defensive parser, but:
- `source='ringba'`, **`event_type='call_transferred'`**, **`conversion_value=0`** (forced),
  `conversion_name='CallTransferOffline'`.
- Same lead-match + attribution backfill as revenue (transfers inherit gclid/UTMs when the call ties
  back to a lead).
- **Status rule (differs from revenue):** a transfer is `ready_to_upload` when it has a click id
  **or** ECL PII — value is *not* required (revenue's `value>0` rule stays only on the revenue path).
- Writes to the **same** `offline_conversion_events` table (event_type keeps rows distinct).
- Reuses the existing `RINGBA_WEBHOOK_SECRET` (no new secret) unless you'd prefer a separate one.

### D. De-dup — UPLOAD EVERY TRANSFER, keyed on call id (updated 2026-08-04)
- Key `ringba:call_transferred:<ringba_call_id>` → **every distinct transferred call becomes its own
  CallXfer row and uploads.** Only an exact re-fire of the *same* call id is a no-op; and even if one
  slipped through, Google de-dupes it by Order ID (= that call id). Fallback when no call id:
  `<phone|click>:<full-timestamp>` (maximally unique so distinct calls never collapse).
- Supersedes the earlier one-per-caller-per-ET-day rule (owner needed all transfers uploaded, not the
  collapsed set). Both the webhook (`buildDedupeKey`) and the internet trigger
  (`derive_internet_transfer_event`, migration `20260804140000`) key on call id.
- **Backfill (2026-08-04):** the ~87 Ringba + ~71 internet transfers previously collapsed were
  recovered from `api_logs` / re-derived (call-id keyed, `ON CONFLICT DO NOTHING`) — no existing row
  touched; Google's Order-ID de-dup covers any edge-case duplicate.
- **Independent of revenue:** the monetized event flows through the separate revenue webhook
  (`ringba:call_converted_revenue:<id>`, action `CallConvertOffline`), unaffected.

### D2. Playbook carve-outs to document post-launch (per FUNNEL-PLAYBOOK.md)
When live, update the playbook:
- **Golden rule #2 / §7b** ("zero-value postbacks ignored", view filter `value>0`): add the
  **$0 exception for `event_type='call_transferred'`** (CallXfer is a count conversion).
- **§7a status vocabulary:** add `transfer_ready` / `transfer_unmatched` — deliberately *not*
  `ready_to_upload`, so the API uploader (which selects `ready_to_upload` and ignores value) can't
  grab transfers while it's still live (§7d).
- **§7a dedup:** note the transfer variant keys on phone+ET-date (not call id) for one-per-caller/day.

### E. Upload leg — the Sheet (one path, defensively isolated)
- Update the export view to **also** emit `event_type='call_transferred'` rows with `value=0`,
  carrying each row's own `conversion_name` (the view already selects per-row conversion_name, so
  `CallTransferOffline` flows through automatically). **One migration** (new view version).
- The **same Sheet/tab** handles both actions — Google routes each row by its "Conversion Name"
  column. No new tab needed.
- Transfers are kept **out** of `status='ready_to_upload'`, so they ride the Sheet **only** and are
  unaffected by the redundant Data Manager path (CLEANUP Risk 1) regardless of how that's resolved.

## What does NOT change
- Revenue webhook, its URL, its action, its view filter, its rows — **untouched**.
- No site/funnel code, no `tel:`/GTM/GFN. `submit-lead`, CallTools, `leads` — untouched.

## Build checklist
1. [x] You: created the Google Ads action — **`CallXfer`** ($0, count-only).
2. [x] You: Ringba fires on **connected/answered** with `ringba_call_id`; transfer pixel confirmed.
3. [x] Me: built on branch `offline-cv-enhancements` (NOT deployed, NOT committed):
       - `supabase/functions/ringba-transfer-webhook/index.ts`
       - `supabase/migrations/20260802120000_view_include_call_transferred_in_sheet_export.sql`
       - Verified: schema has no CHECK constraints (new status/event_type insert cleanly); all
         inserted columns exist; view SQL compiles & runs live (0 blank Order IDs).
4. [ ] You: review the two files.
5. [ ] Me (on your go): deploy the function (dashboard paste) + apply the migration via MCP; add the
       transfer pixel's URL live in Ringba.
6. [ ] Verify: test call → row with `event_type='call_transferred'`, `value=0`,
       `conversion_name='CallXfer'` → lands in Sheet → shows in Google Ads.

## Deploy notes (when approved)
- The function reuses `RINGBA_WEBHOOK_SECRET` — no new secret needed.
- Optional env `GOOGLE_ADS_CONVERSION_ACTION_ID_CALL_TRANSFERRED` is unused by the Sheet path
  (Sheet routes by conversion name); leave unset unless we later add a Data-Manager transfer path.
- Local `deno check` reports 9 type errors — **identical to the deployed revenue webhook** (a
  supabase-js typing quirk); the edge runtime runs it fine. Intentionally matches the sibling.

## Remaining inputs from you
1. Exact Google Ads action name (after you create it).
2. Confirm Ringba fires on call-connected + includes `ringba_call_id`.
3. Reuse `RINGBA_WEBHOOK_SECRET` for the new function, or issue a separate secret? (Default: reuse.)
