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

## Upload safety

- **Google:** `GOOGLE_POSTBACK_UPLOAD_MODE` = `validate_only` (default) | `live`, and
  `GOOGLE_POSTBACK_LIVE_OFFERS` = comma list of offers allowed live (empty by default). Both must
  allow a row before anything is stored in Google Ads. The order id is `caliber_call_id`.
  **Never list an offer the legacy pipeline still uploads** (internet today): the legacy order id
  is date + phone, so Google would count the call twice.
- **Bing:** dry run only. Sending needs Microsoft Ads API access (developer token, OAuth app,
  customer and account ids), and the manual Bing uploads must stop first.
- No cron job runs the uploader yet. Run it by hand:
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
| `call_id` (CallTools call id) | **0%** | The only way to tell a real call-back from one call counted twice, and the key a proper dedupe would use. Caliber is adding it. |
| `ib_source` | 35% | Platform attribution when the call has no click id. Needed on every postback. |
| `transaction_id` (our lead id) | 63% | The strongest lead match. Needed whenever a lead exists. |
| `msclkid` | **0%** | Bing uploads need the Microsoft click id; without it a Bing call can only match on hashed email/phone. Same for `fbclid` (Meta) and `oppref` (OpenAI). |
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

## Parked: repeat calls and dedupe (owner, 2026-09-17)

`postbacks` keeps every call Caliber sends. 102 callers produced 124 repeat conversions on
2026-09-17 (15 of them under 2 minutes apart). Whether a repeat is a real call-back or one call
counted twice **cannot be decided without the CallTools call id**, which is 0% filled today.
Uploads stay in validate_only, so nothing reaches Google meanwhile. When the CallTools call id
arrives and the owner decides, dedupe becomes one isolated change: a rule keyed on
`calltools_call_id`. Nothing else in the pipeline needs to change.

## Health alerts (on since 2026-09-17, in the hourly `pipeline-health-check` email)

- No monetize postbacks for 2 hours, weekdays 10am–8pm ET.
- No transfer postbacks for 2 hours, weekdays 10am–8pm ET, once transfers have arrived that week.
- Lead match rate in the last 24h is 15 points below the prior 7 days.
- Any failed upload check (validate_only / dry run) or failed upload in the last 24h.
- Uploads pending over 2 hours, only while uploads are live.

## Go live (owner decision)

Not before every Caliber program sends its postbacks. Then, per offer: stop the legacy upload for
that offer, add it to `GOOGLE_POSTBACK_LIVE_OFFERS`, set `GOOGLE_POSTBACK_UPLOAD_MODE=live`, and
schedule the uploader.

## Rollback

Both webhooks can be redeployed from git history (v3). `postbacks`, `platform_uploads`,
`ib_source_platforms` and the views are new and read by nothing legacy; they can be dropped.
The two `leads` indexes (`leads_caliber_lead_id_idx`, `leads_created_at_idx`) are harmless to keep.
