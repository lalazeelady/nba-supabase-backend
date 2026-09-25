# Bing (Microsoft Ads) offline conversions

The postback pipeline uploads Bing calls to Microsoft Ads. It replaces the manual Excel uploads
(Microsoft "Enhanced Import" template, goal `CallMonetize`, keyed on msclkid).

```
postbacks ─► platform_uploads (platform = bing) ─► upload-platform-conversions ─► Microsoft Ads
                                                   ApplyOfflineConversions (REST v13)
```

## Switches (Supabase → Edge Functions → Secrets)

| Secret | Value | Meaning |
|---|---|---|
| `BING_UPLOAD_MODE` | `dry_run` (default) / `live` | Master switch. `dry_run` builds the conversion into `last_result` and sends nothing. |
| `BING_LIVE_ACTIONS` | `monetize` (default) / `monetize,transfer` | Which rows send. `transfer` → goal `CallXfer`, value 0. |
| `BING_ENHANCED` | unset / `true` | Adds hashed email + phone. Only after accepting Microsoft's enhanced-conversion terms in the Microsoft Ads UI. |
| `BING_CONVERSION_NAME_MONETIZE` | default `CallMonetize` | Goal name. Must match Microsoft Ads exactly. |
| `BING_CONVERSION_NAME_TRANSFER` | default `CallXfer` | Goal name. |

`offer_rules.uploads_held` holds an offer on Bing too.

## Login: Google OAuth, not Microsoft

Microsoft Ads accepts a Google access token when the request carries `IdentityProvider: Google`.
The Google account must be the one that signs in to Microsoft Ads.

| Secret | |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Shared with the Google Ads uploader (same OAuth Web client). |
| `BING_GOOGLE_REFRESH_TOKEN` | Its own refresh token, scopes `openid email profile`. **Separate from `GOOGLE_REFRESH_TOKEN`.** |
| `BING_DEVELOPER_TOKEN`, `BING_CUSTOMER_ID`, `BING_ACCOUNT_ID` | Microsoft Ads developer token, `cid`, `aid`. |

To re-create the refresh token: Google OAuth Playground, gear → own credentials (the client
above), Access type Offline, Force prompt Consent; scopes `openid email profile`; sign in as the
Microsoft Ads user; exchange; save as `BING_GOOGLE_REFRESH_TOKEN`. The Google Cloud consent
screen must be **In production**, or the token dies after 7 days.

## Connection check (sends nothing)

```sql
select net.http_post(
  url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-platform-conversions?action=bing_test',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name='uploader_invoke_secret')),
  body := '{}'::jsonb, timeout_milliseconds := 60000);
-- then: select content from net._http_response where id = <the id returned>;
```

2026-09-25 result: `ok`, goals `CallMonetize` (72555078) and `CallXfer` (72557471), both Active.

## Cron

`upload-platform-conversions-bing-15min` at :07/:22/:37/:52, `platform=bing&limit=150`. In
`dry_run` it only checks rows. It sends as soon as `BING_UPLOAD_MODE=live`, with no redeploy.

## Row outcomes

| Microsoft says | `platform_uploads` |
|---|---|
| 200, no `PartialErrors` | `sent` |
| 200 with `PartialErrors` (bad click id, too old, unknown goal) | `failed`, error in `last_result` |
| 401 / 403 / 429 / 5xx / network | stays `pending`, `attempts + 1`; `failed` after 6 |
| no msclkid and `BING_ENHANCED` off | `skipped`, `skip_reason = 'no_msclkid'` |

Microsoft treats (click id, goal, conversion time) as one conversion: a re-send of the same row
is ignored, a later call on the same click counts.

## Manual uploads already in Microsoft Ads

`bing_manual_uploads` holds the manual rows. `mark_bing_manual_uploads()` marks a pending
Bing monetize row `skipped` / `uploaded_manually` when the same msclkid was uploaded by hand
within 1 hour of it. Loaded 2026-09-25 from the 5 files dated 2026-09-16 … 2026-09-23: rows from
2026-09-16 20:00 UTC only (252 rows, $3,326). The pipeline's first postback is 2026-09-16 21:37
UTC, so older rows cannot collide. Result: 8 rows marked.

Most manually uploaded calls were already out of the queue: 142 as `uploaded_by_legacy` (internet
before the 2026-09-19 cutover) and 37 as `duplicate_call`.

**If more manual uploads happen before go-live**, load the new file and re-mark:
```
python3 scripts/load_bing_manual_uploads.py <file.xlsx> > load.sql   # run load.sql in the SQL editor
select mark_bing_manual_uploads();
```

## Accuracy check vs. owner's daily Bing revenue (2026-09-25)

Pipeline = Bing-attributed monetize revenue in `v_recon_daily`, by ET day.

| ET day | Owner | Pipeline | Gap |
|---|---|---|---|
| 09-17 | $779 | $609 | −$170 |
| 09-18 | $787 | $603 | −$184 |
| 09-21 | $1,188 | $830 | −$358 |
| 09-22 | $1,354 | $1,145 | −$209 |
| 09-23 | $2,082 | $1,538 | −$544 |

The pipeline is **lower**, and the gap is calls the pipeline never receives: 88 manual rows
($1,981, 09-16 … 09-22) are real Bing leads (`bg1` 79, `apply2` 9) with **no Caliber postback
at all**, not matched by msclkid, phone, or value+time. Their values ($16/$18/$51/$55) suggest a
buyer or offer that does not send postbacks. The pipeline cannot upload revenue it never
receives. Owner question: which report or buyer the manual files came from.

The manual files themselves do not sum to the owner's totals either (e.g. 09-16: files $2,233 vs
$1,459), so the owner totals may use a different day cut or source.

## Go live

1. Stop the manual Bing uploads.
2. Set `BING_UPLOAD_MODE=live`. The next cron run sends the backlog oldest first, 150 per run
   (398 monetize rows, $4,705.50 on 2026-09-25).
3. Check: `select status, skip_reason, count(*) from platform_uploads where platform='bing' group by 1,2;`
   and `last_result` on any `failed`. Conversions show in Microsoft Ads within ~6 hours.
4. Optional: `BING_LIVE_ACTIONS=monetize,transfer` to also send `CallXfer` (445 pending).

Undo: set `BING_UPLOAD_MODE=dry_run`. Rows already sent stay in Microsoft Ads.
