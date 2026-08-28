# Offline-Conversion Accuracy — Build Plan

Branch: `offline-cv-accuracy` (backend repo). **Nothing is deployed or committed until you say so.**
Goal: make Google Ads offline-conversion counts *directionally* match how the business
accounts for calls — gross transfers, gross monetizations, correct source, correct time.

---

## The core idea: count per-CALL, gross (no phone/day collapse)

Google Ads de-dupes offline conversions by **Order ID** within a conversion action. So "go gross"
is really one rule:

> **Order ID must be unique per real call.** Then ingest can be gross and Google keeps every call.

Grain is **per-source** (`order_id` is the Google de-dup grain; `set_offline_conversion_order_id`
sets it at ingest):

```
Ringba  (conversion_call_id 'RGB…')  -> conversion_call_id     -- GROSS, per-call
CallTools interim (non-RGB, not caliber) -> conversion_call_id -- contact id, LEFT AS-IS (retiring)
Caliber (source='caliber')           -> phone + ET-day          -- phone/day collapse (owner's rule)
no call id + phone (rare)            -> phone + ET-day + _B/_C  -- kept distinct
nothing                              -> row id
```

- **Ringba = gross**: dedup moves from phone/day → the per-call `RGB…` id, so every qualified
  transfer/monetization counts.
- **Internet = phone/day**: Caliber (and CT interim) dedup by phone+ET-day — owner's rule, because
  internet has unexplained multi-fires per number. Internet transfer ≡ monetization ($6), 1:1.
- **Caliber** is detected by its `status` field, `no connect` is dropped before dedup, and all
  Caliber rows are **held out of Google upload until cutover** (see SWITCHOVER.md).

`dedupe_key` stays source/event-namespaced (`<source>:<event_type>:…`), so a call's $0 CallXfer and
its $6 CCO never collide, and the UNIQUE index on `dedupe_key` absorbs pixel double-fires.

---

## Phases (all on this branch)

| # | Phase | Files |
|---|---|---|
| 1 | **Gross / per-call identity** — rewrite `set_offline_conversion_order_id` (order_id + dedupe_key per call); simplify both webhooks to upsert-on-conflict (stop hand-computing the old phone/day key) | `set_offline_conversion_order_id` migration · `ringba-conversion-webhook` · `ringba-transfer-webhook` |
| 2 | **Internet = transfer≡monetization, 1:1, per call** — rewrite the derive trigger to per-call grain so internet CallXfer count == internet CCO count | `derive_internet_transfer_event` migration |
| 3 | **Conversion-time correctness** — prefer the actual current call start/end time; self-timestamp only as fallback (kills "conversion before click") | both webhooks |
| 4 | **Source filter** — upload to Google only where google-eligible OR unknown; store-but-don't-upload definitively-other | export-view migration |
| 5 | **API-ready switchover** — destination IDs already env-driven; document the one-env-var + one-Google-Ads-toggle switchover; keep Sheet running in parallel | uploader (mostly already there) + `SWITCHOVER.md` |
| 6 | **Additive tracking** — new columns (`calltools_call_uuid`, `ib_source`, `oppref`, `msclkid`, `fbclid`, `call_type`, `queue_name`; leads `lead_source`, `landing_page`); ingest phone normalized to E.164 | columns migration · both webhooks · `submit-lead` |
| 7 | **Test fires** — mark test/empty fires `status='test'`; never uploaded, never "failed" | both webhooks |
| 8 | **EDU monetizations** (last, low priority) — no source identified yet; documented stub | `EDU-TODO.md` |

## Source filter rule (locked)

Upload to Google **iff**:
```
utm_source ILIKE 'google'
OR ib_source ~* '(google|youtube)'
OR ib_source IN ('NBA_ThankYou','NBA_Funnel','NBA_InactivityPopup')   -- legacy google-era names
OR (utm_source blank AND ib_source blank)                             -- unknown → still upload
```
Everything else (Meta / Bing / MediaExpansion / email re-engagement with a non-google source) is
**stored but not uploaded**. Google only matches an uploaded row if it finds enhanced-lead data, so
uploading unknowns is safe.

## What is yours (I can't touch)

- **Google Ads UI**: create/confirm conversion-action + Data Manager destination IDs; at switchover,
  point the API CCO destination at the real CCO action and turn OFF the Sheet scheduled import.
- **Pixels**: send the fields in [`PIXEL-FIELDS.md`](PIXEL-FIELDS.md) — especially a true per-call
  `call_uuid` and the actual current-call time.
- **Turn OFF the old CT $6 monetization pixel** when the new internet pixel goes live (else internet
  CCO doubles — dedupe absorbs brief overlap by call id, but don't run both indefinitely).

## Deploy = your explicit go

I apply migrations + deploy edge functions via Supabase MCP (no dashboard paste needed). Nothing
goes live until you say "deploy." Recommend deploying at a low-traffic ET boundary and watching
counts for a day (the identity cutover is forward-only; a call that fires both before and after the
cutover could count twice — negligible at a clean boundary).
