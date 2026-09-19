# Postback pipeline (built 2026-09-17)

Caliber postbacks → one master table → one upload queue per platform → reports.
It runs **beside** the legacy pipeline (`offline_conversion_events`, Ringba webhooks,
`upload-google-offline-conversions`, Customer Match). Nothing legacy was changed.

## Flow

```
Caliber pixel ──► postback-transfer-webhook ─┐
                  postback-monetize-webhook ─┴─► postbacks ──(trigger)──► lead match
                                                     │
                            queue_platform_uploads() ▼
                                               platform_uploads ──► upload-platform-conversions
                                                                      Google: validate_only (default)
                                                                      Bing:   dry_run only
```

## Objects

| Object | What it is |
|---|---|
| `postbacks` | One row per Caliber call event. Unique on `(caliber_call_id, event_type)`: a re-fire is ignored. Stores only the fields that identify and route the call, plus `raw_payload` (secret removed). |
| `ib_source_platforms` | Editable map: inbound route name → platform (`google`, `bing`, `meta`, `openai`, `owned`). An unlisted route is unknown. |
| `offer_rules` | Per-offer rules. `transfers_from_monetize` (internet): each monetized postback also uploads as the transfer; transfer postbacks for that offer do not upload. |
| `platform_uploads` | One row per postback per platform per `conversion_action` (transfer → CallXfer, monetize → CallConvertOffline). `status`: pending, sent, failed, skipped (`skip_reason`). A validate_only / dry_run check sets `validated_at` and `last_result` and leaves status `pending`. |
| `v_postbacks` | **The one place to look.** Postback + lead + `platform`, `attribution`, `confidence`. |
| `v_platform_uploads_pending` | What the uploader reads. |
| `v_recon_daily` | Count and revenue by ET day / offer / conversion action / platform / confidence, next to uploaded, pending, failed, skipped and validated counts. `from_monetize = true` marks internet transfers counted from monetized postbacks. |
| `v_call_through_daily` | Leads vs transferred / monetized leads by lead day and platform. Always filter on `lead_date_et`. |
| `postback_health(p_uploads_live)` | Numbers and `problems` for `pipeline-health-check` (hourly email). |
| cron `rematch-postbacks-hourly` | Retries the lead match for unmatched rows from the last 7 days. |

### Lead match (on insert, then hourly)
1. `transaction_id` = `leads.transaction_id` (our id — what Caliber should send)
2. `transaction_id` = `leads.caliber_lead_id` (Caliber's own lead id — what it sent until 2026-09-17)
3. `gclid` → 4. `email` → 5. `phone` (newest lead created before the call, 1h slack)

Only leads created in the **90 days before the call** can match (owner, 2026-09-17): Google
rejects a conversion whose click is older than 90 days, and an older lead is stale attribution.
When the rule was applied, 478 of 479 matches were already inside the window.

### Platform attribution (first match wins)
| Signal | `attribution` | `confidence` |
|---|---|---|
| gclid / gbraid / wbraid → google, msclkid → bing, fbclid → meta, oppref → openai | `click_id` | `absolute` |
| `utm_source` (postback, else lead) | `utm_source` | `confident` |
| `ib_source` via `ib_source_platforms` | `ib_source` | `confident` |
| nothing | `none` | `unknown` |

Postback values win; the lead fills gaps. Lead detail (names, zip, UTMs 2–5, landing page,
IP, user agent) is read from `leads` through `lead_id`, never copied.

## Upload rules (owner, 2026-09-17)

- Every postback is kept. The only duplicate rule is the same `caliber_call_id` for the same
  event (an identical re-fire). A transfer and a monetize event for the same call are two rows
  and two uploads, even with the same timestamp. Caliber decides what counts as a conversion.
- Upload a transfer or a monetize event when it is attributed to that platform; a monetize
  event also needs revenue. **Unknown-source calls are never uploaded** (queued as
  `skipped / unknown_platform` so they stay visible).
- Internet: gross transfers = gross monetized calls. Each monetized internet postback uploads
  twice: CallConvertOffline (revenue) and CallXfer ($0). Other offers send transfer postbacks.
- Matching unknown-source calls to leads in other ways was tested on 2026-09-17 (221 calls,
  $1,425): case-insensitive email recovered 0, legacy phone data recovered 7 ($45). Not added.
- **Unknown** = no click id (its own or from a matched lead), no usable `utm_source`, and no
  mapped route name: only call data. These never upload **on any offer** (owner, 2026-09-19);
  an unknown call can come from any source, including Meta. The fix is `ib_source` on every
  postback, not a looser upload rule.
- **"No connect" calls are dropped at the webhook**, before they are stored and therefore before
  dedupe, on every offer. This needs Caliber to send `status`: spec rev 11 adds it to both URLs.
- **Meta** (`apply.nationalbenefitalliance.com`) is another entity's ads and lander. Its leads
  reach us through the call platform, but we do nothing with them.

## Upload safety

- **Google:** an offer uploads for real only when **both** are true:
  1. `GOOGLE_POSTBACK_UPLOAD_MODE = live` (Supabase secret, the master switch; default `validate_only`)
  2. `offer_rules.uploads_held` is false for that offer
  An offer missing from `offer_rules` is not held, so a new Caliber offer goes live by itself.
  `GOOGLE_POSTBACK_LIVE_OFFERS` (optional) narrows live mode to a comma list; empty means every
  offer that is not held. The order id is `caliber_call_id`.
  **An offer the legacy pipeline still uploads must stay held** (internet today): the legacy
  order id is date + phone, so Google would count the call twice.
- **Bing:** dry run only. Sending needs Microsoft Ads API access (developer token, OAuth app,
  customer and account ids), and the manual Bing uploads must stop first.
- Cron `upload-platform-conversions-15min` runs the Google side every 15 minutes. While the
  master switch is `validate_only` it only checks rows; it starts uploading when the switch flips.
  To run it by hand:
  ```sql
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-platform-conversions?platform=google&limit=100',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name='uploader_invoke_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
  ```
  About 1 Google row per second; keep `limit` ≤ 135 per call.

## Look-ups

```sql
-- Anything about one call or person
select * from v_postbacks where caliber_call_id = '…';
select * from v_postbacks where phone = '3343142975';          -- 10 digits
select * from v_postbacks where email = 'name@example.com';
select * from v_postbacks where calltools_call_id = '…';
select * from v_postbacks where transaction_id = '…' or lead_transaction_id = '…';

-- One day, by platform and confidence
select platform, confidence, sum(events) events, sum(revenue) revenue,
       sum(uploaded_revenue) uploaded_revenue, sum(skipped_events) skipped
  from v_recon_daily
 where conversion_date_et = date '2026-09-17' and conversion_action = 'monetize'
 group by rollup(platform, confidence);

-- Why a row did not upload
select u.platform, u.status, u.skip_reason, u.last_result
  from platform_uploads u join v_postbacks v using (postback_id)
 where v.caliber_call_id = '…';

-- Call-through rate
select * from v_call_through_daily where lead_date_et = date '2026-09-17';
```

## Ask Caliber for (fill rate on 916 postbacks, 2026-09-16/17)

| Field | Filled | Why we need it |
|---|---:|---|
| `call_id` (CallTools call id) | **0%** | The dedupe key (`call_key`). Until it arrives, dedupe falls back to phone + day, which cannot tell a real call-back from one call counted twice. Caliber is adding it. |
| `ib_source` | 35% | Platform attribution when the call has no click id. Needed on every postback. |
| `transaction_id` (our lead id) | 63% | The strongest lead match. Needed whenever a lead exists. |
| `msclkid` | **0%** | The rev 9 URL had no msclkid parameter, so Bing calls came back with no click id: of 93 matched calls whose lead has an msclkid, Caliber returned 0. The leads are fine (98.5% of Bing leads carry it). **Spec rev 10 (2026-09-17) adds `msclkid`, `fbclid` and `oppref` to both URLs** — waiting for Caliber to apply it. We recover it from the matched lead meanwhile. |
| `utm_source` | **0%** | Second attribution signal after the click id. Today attribution falls back to the route name only. |
| `first_name`, `last_name`, `zip` | 0% | 34% of calls match no lead. With name + zip, Google can still match those calls on the hashed address block. |
| `status` (call status) | **0%** | We drop "no connect" events. Today we rely on Caliber never sending them. |

Also confirm with Caliber:
- **Can one call ever be monetized twice** (two buyers, or a second sale on the same call)? Our key
  is `(caliber_call_id, event_type)`, so a second monetize event for the same call would be treated
  as a re-fire and dropped. If it can happen, we need a per-conversion id from them.
- **Transfer postbacks for the non-Internet offers** (Internet counts transfers from the monetized
  postback).
- **Send the secret in the `x-webhook-secret` header**, not in the URL. In the URL it is written to
  the edge logs.

## Dedupe (business decision, 2026-09-17)

**At the upload only.** `postbacks` keeps every event Caliber sends, so a report can show
received vs uploaded vs dropped-as-duplicate, and revenue can be reconciled against Caliber.

- **Key** = `postbacks.call_key`: `calltools_call_id` when Caliber sends it (one inbound call),
  else the caller's phone + the Eastern-time day (what the legacy pipeline used).
- **Scope** = per offer and per conversion action. One caller with 3 Internet calls in a day
  uploads 1 monetize and 1 transfer conversion. The same caller monetizing Internet **and**
  Energy on the same day uploads **both**: dedupe only removes a repeat of the same offer.
  A transfer and a monetize event for the same call also both upload, because they go to
  different Google actions.
- The **earliest** event for a `call_key` keeps the upload; later ones are queued as
  `skipped / duplicate_call` and stay visible in `v_recon_daily`.
- The phone + day fallback cannot tell a real call-back from one call counted twice. Once
  `calltools_call_id` arrives on every postback, the key becomes exact with no code change.

Effect on 2026-09-17 (Internet, by 2pm ET): 774 monetized events received ($5,119) → 605
distinct calls; 114 dropped as duplicates ($753); 289 skipped as unknown-source ($1,946);
371 would upload ($2,420).

## Health alerts (on since 2026-09-17, in the hourly `pipeline-health-check` email)

- No monetize postbacks for 2 hours, weekdays 10am–8pm ET.
- No transfer postbacks for 2 hours, weekdays 10am–8pm ET, once transfers have arrived that week.
- Lead match rate in the last 24h is 15 points below the prior 7 days.
- Any failed upload check (validate_only / dry run) or failed upload in the last 24h.
- Uploads pending over 2 hours, only while uploads are live.

## Go live

**Non-Internet offers (2026-09-19):** Caliber sends these only to the new webhooks, and Ringba's
remaining campaigns share no callers with them (checked over 3 days: 0 overlap), so they upload as
soon as the master switch is set to `live`.

**Internet cutover: done 2026-09-19 5:00pm ET**, on a quiet weekend. Both pixels still fire;
only the uploads moved.
- Legacy: `legacy_caliber_hold` stores any Caliber row for a call at/after the cutover with
  status `ignored`, which the legacy uploader never selects. Ringba is untouched.
  Rollback: drop `trg_zz_legacy_caliber_hold`, or move `legacy_caliber_upload_cutover()` forward.
- New: 1,908 Internet uploads for pre-cutover calls were marked `uploaded_by_legacy`, then
  `uploads_held` was set to false.
- Parity checked on 2026-09-18, the last full day: legacy stored 731 Internet rows and uploaded
  660 ($4,289); the new pipeline under the **same** rules would have uploaded 732 ($4,753);
  under the new rules it uploads 486 ($3,163). The gap is the owner's rule that unknown-source
  calls never upload (246 calls, $1,590 that day).
- Watch `v_recon_daily` and the Google Ads daily totals for 48 hours after traffic resumes.

## Rollback

Both webhooks can be redeployed from git history (v3). `postbacks`, `platform_uploads`,
`ib_source_platforms` and the views are new and read by nothing legacy; they can be dropped.
The two `leads` indexes (`leads_caliber_lead_id_idx`, `leads_created_at_idx`) are harmless to keep.
