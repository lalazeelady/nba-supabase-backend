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
| `platform_uploads` | One row per postback per platform. `status`: pending, sent, failed, skipped (`skip_reason`). A validate_only / dry_run check sets `validated_at` and `last_result` and leaves status `pending`. |
| `v_postbacks` | **The one place to look.** Postback + lead + `platform`, `attribution`, `confidence`. |
| `v_platform_uploads_pending` | What the uploader reads. |
| `v_recon_daily` | Count and revenue by ET day / offer / event / platform / confidence, next to uploaded, pending, failed, skipped and validated counts. |
| `v_call_through_daily` | Leads vs transferred / monetized leads by lead day and platform. Always filter on `lead_date_et`. |
| `postback_health()` | JSON numbers for the (not yet enabled) alerts. |
| cron `rematch-postbacks-hourly` | Retries the lead match for unmatched rows from the last 7 days. |

### Lead match (on insert, then hourly)
1. `transaction_id` = `leads.transaction_id` (our id — what Caliber should send)
2. `transaction_id` = `leads.caliber_lead_id` (Caliber's own lead id — what it sent until 2026-09-17)
3. `gclid` → 4. `email` → 5. `phone` (newest lead created before the call, 1h slack)

### Platform attribution (first match wins)
| Signal | `attribution` | `confidence` |
|---|---|---|
| gclid / gbraid / wbraid → google, msclkid → bing, fbclid → meta, oppref → openai | `click_id` | `absolute` |
| `utm_source` (postback, else lead) | `utm_source` | `confident` |
| `ib_source` via `ib_source_platforms` | `ib_source` | `confident` |
| nothing | `none` | `unknown` |

Postback values win; the lead fills gaps. Lead detail (names, zip, UTMs 2–5, landing page,
IP, user agent) is read from `leads` through `lead_id`, never copied.

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
 where conversion_date_et = date '2026-09-17' and event_type = 'monetize'
 group by rollup(platform, confidence);

-- Why a row did not upload
select u.platform, u.status, u.skip_reason, u.last_result
  from platform_uploads u join v_postbacks v using (postback_id)
 where v.caliber_call_id = '…';

-- Call-through rate
select * from v_call_through_daily where lead_date_et = date '2026-09-17';
```

## Open decisions (owner)

1. **Google rule for unknown-source calls.** `queue_platform_uploads()` constant
   `c_google_include_unknown` (false today: queued as `skipped / unknown_platform`).
2. **Repeat calls from one caller on one day.** `postbacks` keeps every call (per Caliber call id).
   The legacy pipeline keeps one per phone per day. On 2026-09-17 by noon: 319 monetized calls from
   230 callers ($2,118) vs legacy 230 rows ($1,517). Confirm against Caliber's revenue report.
3. **Health-check alerts** from `postback_health()` (not enabled).
4. **Go-live per offer:** turn off the legacy upload for that offer, then add it to
   `GOOGLE_POSTBACK_LIVE_OFFERS` and set `GOOGLE_POSTBACK_UPLOAD_MODE=live`, then schedule the uploader.

## Rollback

Both webhooks can be redeployed from git history (v3). `postbacks`, `platform_uploads`,
`ib_source_platforms` and the views are new and read by nothing legacy; they can be dropped.
The two `leads` indexes (`leads_caliber_lead_id_idx`, `leads_created_at_idx`) are harmless to keep.
