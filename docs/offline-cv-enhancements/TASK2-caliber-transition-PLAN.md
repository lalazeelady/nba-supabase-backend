# Task 2 — CallTools → Caliber (and Ringba → Caliber) Transition Plan

Two independent transitions. **(a) replacing CallTools** is a low-risk swap; **(b) replacing
Ringba** is the deeper one. This plan maps every place the two vendors are wired into the backend
so nothing silently breaks when they're swapped, and preserves the standards you already hold
(non-blank Order ID, ECL PII, de-dup, audit trail).

Good news up front: **Caliber is already half-integrated.** `submit-lead` already fires CallTools
**and** Caliber in parallel, and `leads` already has `caliber_status / caliber_lead_id /
caliber_action / caliber_submitted_at` columns
([migration](../../supabase/migrations/20260430020000_add_caliber_tracking_to_leads.sql)). So (a)
is mostly "make Caliber primary and retire CallTools," not "integrate Caliber from scratch."

---

## Where CallTools & Ringba are wired in today (dependency map)

| # | Location | Depends on | What it does |
|---|---|---|---|
| 1 | `submit-lead/index.ts` | **CallTools** (+ Caliber already) | Forwards each lead to the CRM; stores `crm_*` |
| 2 | `ringba-conversion-webhook` | **Ringba** | Receives revenue postback; `source='ringba'`, `EVENT_TYPE` |
| 3 | Webhook `FIELD_VARIANTS.calltools_call_id` | **CallTools** | Parses CT call id from Ringba's forwarded tags |
| 4 | Webhook publisher gate `!= 'NBA'` ([:363](../../supabase/functions/ringba-conversion-webhook/index.ts#L363)) | **Ringba** | Ringba "publisher" concept; drops non-NBA postbacks |
| 5 | Export view Order-ID fallback #2 = `calltools_call_id` ([:108](../../supabase/migrations/20260519000000_view_populate_blank_order_id.sql#L108)) | **CallTools** | Order ID when Ringba gave no call id |
| 6 | `offline_conversion_events.calltools_call_id` column | **CallTools** | Stored per event |
| 7 | `dedupe_key` = `ringba:<type>:<call_id>` | **Ringba** | Idempotency of revenue events |
| 8 | Lead-match fallback via `caller_id` (phone) | neutral | Works regardless of vendor |

Rows 3–7 are the ones a transition touches. Everything else is vendor-neutral.

---

## Part (a) — Replace CallTools with Caliber (dialer/CRM)

**Impact on the flow: minimal.** Caliber slots in where CallTools was; Ringba, monetization, and
the whole offline-CV pipeline stay identical. Your revised flow:

```
CLICK AD => FUNNEL/SUBMIT => LEAD TO SUPABASE => LEAD TO CALIBER
   => INBOUND CALIBER CALL MERGES WITH LEAD => CALL TRANSFERS TO RINGBA
   => MONETIZES => SUPABASE => GOOGLE OFFLINE CV SHEET
```

### Phase 0 — internet-first Caliber pilot — DEFERRED (owner decision 2026-08-04)
**Not being built now.** Internet calls still flow CallTools → Supabase (they do NOT hit Caliber
directly — only via CallTools). Current state is correct as-is. Caliber integration will happen as
part of the **full** CT→Caliber project migration, not as an internet-only slice. The
internet-transfer trigger (Task 1) already works on the current CallTools stack and needs no change
until that migration. The design sketch below is retained for whenever that migration happens:

- **New dedicated edge function `caliber-conversion-webhook`** — a Caliber-field-variant mirror of
  the revenue webhook, stamping **`source='caliber'`** (fixes the long-standing source-mislabel;
  today internet is wrongly stamped `ringba` — see CLEANUP "shared webhook" finding). Revenue webhook
  untouched.
- **New `caliber_call_id`** column + Order-ID precedence becomes
  `ringba_call_id → caliber_call_id → calltools_call_id → ET-date+phone → uuid`
  (preserves [feedback-nba-order-id-format], keeps Order IDs non-blank + correctly labeled).
- **De-dup:** `caliber:call_converted_revenue:<caliber_call_id>` — namespaced by source, so Caliber
  and Ringba/CT rows coexist with no collision during the transition. ✅
- **Cutover safety (owner):** clean swap — turn Caliber's internet postback ON and the CT internet
  postback OFF together. Both firing for one internet call = two rows (different source + id) =
  double-count. A planned overlap is OK if flagged; I can add a match/guard.
- **Parity checklist before flipping** (must hold or attribution regresses):
  - [ ] Caliber forwards `gclid/gbraid/wbraid` when present (click attribution).
  - [ ] Caliber forwards caller email/phone/name/zip (ECL for no-click internet calls).
  - [ ] Caliber sends a per-call value (the flat-$6-style payout) → `conversion_value`.
  - [ ] Caliber sends a stable call id → `caliber_call_id` (de-dup + Order ID).
  - [ ] Auth: shared secret (or token) wired as an edge-function secret.
- **Prereq:** Caliber postback/API docs (field names, auth, payload sample). Build starts on receipt.
- **Foundation:** this same function handles the *full* cutover later — just point more Caliber
  postbacks (all transfers, all monetized calls) at it.

### Phased cutover (dual-run → primary → retire)
1. **Dual-run (already true).** Both CRMs receive every lead. **Action:** add monitoring — compare
   `crm_status` vs `caliber_status` acceptance rates over 1–2 weeks to prove Caliber parity.
2. **Caliber primary.** Flip a flag so Caliber is the required success and CallTools becomes
   best-effort/off. Keep CallTools firing (cheap insurance) until step 4.
3. **Data-requirement parity check** (must hold before retiring CallTools):
   - [ ] Caliber returns a **call id** we can store as `caliber_call_id` and forward through the
         transfer so it lands on the Ringba postback (→ replaces Order-ID fallback #2, row 5).
   - [ ] gclid/gbraid/wbraid + UTMs still travel lead → Caliber → Ringba (attribution intact).
   - [ ] Caliber's inbound-call → existing-lead **merge** behaves like CallTools' merge (so one
         caller doesn't create duplicate leads and split attribution).
   - [ ] ECL PII (email/name/zip) still collected on inbound calls and forwarded to Ringba for the
         no-form-caller case.
4. **Retire CallTools.** Remove the CallTools call from `submit-lead`; **repoint** Order-ID
   fallback #2 from `calltools_call_id` → `caliber_call_id` (new column + view migration); keep the
   `calltools_call_id` column read-only for historical rows. Update `CLAUDE.md`.

### Bonus you called out
Internet leads currently run a **separate transfer/revenue process**. Because Caliber unifies
transfers+revenue in one platform, the Internet path can fold into the standard path — **removing**
a whole parallel process. I'll spec that as its own mini-step once (a) is underway.

### Code/schema touched (when we build)
- `submit-lead/index.ts` — provider flag; eventually drop CallTools branch.
- New migration — `leads.caliber_call_id` (if not already forwarded) + view Order-ID repoint.
- Docs — `CLAUDE.md` CRM section.

---

## Part (b) — Replace Ringba with Caliber (call management + monetization)

**Impact: structural.** Ringba is today the *source of truth for revenue* and the *publisher gate*.
If Caliber takes over buyer routing + monetization, the **revenue postback source changes**, and
several Ringba-specific assumptions in the pipeline must generalize. You noted this should actually
be *smoother with less data loss* because dialer+monetization live in one platform — I agree, and
the plan leans on that (attribution no longer has to survive a CallTools→Ringba hop).

### What changes conceptually
```
CLICK AD => FUNNEL/SUBMIT => LEAD TO SUPABASE => LEAD TO CALIBER
   => INBOUND CALIBER CALL MERGES WITH LEAD
   => CALIBER ROUTES/QUALIFIES => CALL MONETIZES (in Caliber)
   => CALIBER REVENUE POSTBACK => SUPABASE => GOOGLE OFFLINE CV
```

### Migration approach (generalize, don't fork)
Rather than a second bespoke webhook, **generalize the existing one** so `source` is a first-class
dimension (`ringba` | `caliber`):
1. **New endpoint or `?source=caliber`** on the conversion webhook. Same defensive parser (Caliber's
   token names go into `FIELD_VARIANTS`).
2. **`source` already stored** on `offline_conversion_events` and already in `dedupe_key`
   (`<source>:<type>:<call_id>`) — so Ringba and Caliber events coexist during cutover with no
   collision. ✅ (This is why the current design ages well.)
3. **Publisher gate (row 4)** is a Ringba concept — replace with a Caliber-appropriate ingress
   filter (or drop if Caliber only ever sends NBA traffic).
4. **Order ID** precedence adds `caliber_call_id`; your date+phone and UUID fallbacks stay
   ([feedback-nba-order-id-format] preserved exactly).
5. **Task 1 transfers become internal to Caliber** — "transfer" may be a Caliber disposition rather
   than an inbound-to-Ringba event. Task 1's webhook stays; only the emitter changes.

### Dual-run safety
Because `source` namespaces everything, we can run **Ringba and Caliber revenue side-by-side** and
reconcile totals before cutting Ringba off — no data loss, reversible.

### Open decisions for (b)
- Does Caliber do **its own** monetization/buyer payouts, or still hand off to Ringba buyers? (Your
  two flow diagrams both still showed `=> RINGBA` — confirm the end state.)
- Will Caliber post back a **per-call revenue** event we can map to `conversion_value`?
- Timing vs. Google Ads: Caliber postback latency should stay inside the Google Ads offline-import
  window (transfers/revenue in the Sheet before the daily import).

---

## Recommended sequence
1. Ship **Task 1** on Ringba (works today, immediate value).
2. Do **(a) CallTools→Caliber** — low risk, already half-built, unlocks Internet-path simplification.
3. Do **(b) Ringba→Caliber** last — biggest change, and (a) will have proven Caliber's data quality.

## What I need from you to turn this into build specs
- Caliber API docs (endpoints, auth, call-id + revenue postback shape, merge behavior).
- Confirm the **end state** for (b): Caliber-native monetization vs. Caliber→Ringba buyers.
- The dual-path decision from the README (same as Task 1 — it governs the upload leg).
