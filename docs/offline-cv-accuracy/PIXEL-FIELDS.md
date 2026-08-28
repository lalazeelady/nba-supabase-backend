# Required Pixel Fields — verify before go-live

The webhooks are defensive parsers (they accept many name variants and ignore extras), so **extra
fields are harmless** and you can't break ingest by adding fields. But three things must be right for
the new accuracy logic to work. Legend: ✅ already sent · ⚠️ **you need to add/fix** · ➕ optional
(future-proofing).

Accepted param-name variants are generous; the **canonical** name to send is in bold.

---

## 1. Ringba CONVERSION pixel (revenue / CCO) → `ringba-conversion-webhook`

| Field | Canonical param | Status | Notes |
|---|---|---|---|
| Ringba call id | **`ringba_call_id`** | ✅ | `RGB…` per-call id → per-call Order ID. Required. |
| Publisher | **`pub`** = `NBA` | ✅ | Non-NBA is dropped. |
| Revenue | **`conversion_value`** | ✅ | Per-fire payout. |
| **Call time** | **`conversion_time`** | ⚠️ | Must be **THIS call's** start or end time. If Ringba sends a real call time already, good — just confirm it's not a contact-level "last call" field. |
| Caller phone | **`caller_id`** | ✅ | |
| Click ids | `gclid` / `gbraid` / `wbraid` | ✅ | Whatever is present. |
| ECL PII | `email`,`first_name`,`last_name`,`zip` | ✅ | For enhanced matching when no click id. |
| UTM | `utm_source`,`utm_medium`,… | ✅ | Used by the source filter. |
| Inbound route | ➕ `ib_source` | ➕ | Often blank from Ringba (known CT→Ringba gap). Fine. |

## 2. Ringba TRANSFER pixel (CallXfer, $0) → `ringba-transfer-webhook`

| Field | Canonical param | Status | Notes |
|---|---|---|---|
| Ringba call id | **`ringba_call_id`** | ⚠️ | **Required for per-call gross** (identity switches from phone/day to this call id). Confirm it's sent on the transfer/connected postback. |
| Publisher | **`pub`** = `NBA` | ✅ | |
| **Call time** | **`conversion_time`** | ⚠️ | THIS call's connect/start time, not a contact-level field. |
| Caller phone | **`caller_id`** | ✅ | |
| Click ids / PII / UTM | as above | ✅ | Inherited from the matched lead when absent. |

## 3. CallTools INTERNET pixel (transfer ≡ $6 monetization) → `ringba-conversion-webhook`

This is the big one. Today it dedupes at the **contact** level and sends a stale time.

| Field | Canonical param | Status | Notes |
|---|---|---|---|
| **True per-call id** | **`call_uuid`** | ⚠️ | The unique CallTools call id (`{{call][id]}}`). This makes internet gross truly per-call and is the shared key to sync CT↔Ringba↔Supabase later. Until it's here we fall back to contact-id + time. |
| Contact id | `ringba_call_id` (current slot) | ✅ | Keep sending it (interim identity + fallback). |
| Publisher | **`pub`** = `NBA` | ✅ | |
| Revenue | **`conversion_value`** = `6.00` | ✅ | |
| **Call time** | **`conversion_time`** | ⚠️ | **THE BUG:** today this is "date of last call from this contact" (can be days old → "conversion before click" errors). Send **THIS call's** start or end time. If you can't, tell me and I'll timestamp at pixel-receipt (accurate to within seconds). |
| Caller phone | **`caller_id`** | ✅ | Leading-space tolerated; normalized to E.164. |
| Inbound route | **`ib_source`** | ✅→confirm | Always present in CallTools; drives the source filter. Confirm the param name (`ib_source` / `inbound_route` / `inbound_route][name]`). |
| UTM | `utm_source`,… | ✅ | Source filter. |
| Call type | ➕ `call_type` | ➕ | e.g. `inbound`. Add if easy → lets outbound callbacks flow later with no code change. |
| Queue | ➕ `queue_name` / `queue_id` | ➕ | For future queue splits/reporting. |
| Click ids | `gclid`,`gbraid`,`wbraid`, `msclkid` (Bing), `fbclid` (Meta), `oppref` (OpenAI) | ➕ | Whatever the lead carried; stored for attribution. |

---

## After you fix the pixels

Send me one real test fire from each (or point me at the rows), and I'll confirm every field landed
in the right column **before** we flip anything live. If anything's missing from the three pixels
that the new logic needs, this is where we'll catch it.
