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
| `BING_LIVE_ACTIONS` | `monetize,transfer` (default) | Which rows send. `transfer` → goal `CallXfer`, value 0. All transfers send: none were uploaded by hand. |
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

Owner rule (2026-09-25): **a Bing monetize row is excluded when its msclkid is in the manual
uploads — msclkid only, any time.** Otherwise it uploads by the normal rules. Transfers were never
uploaded by hand, so every transfer sends.

`bing_manual_uploads` holds all 5 manual files dated 2026-09-16 … 2026-09-23 (1,201 unique rows,
$15,541.50, calls 2026-08-31 … 2026-09-22). `mark_bing_manual_uploads()` marks matching rows
`skipped` / `uploaded_manually`; the uploader runs it before every Bing batch, so a later call on
a manually uploaded click is excluded too. Bing rows once skipped as `uploaded_by_legacy` were
re-opened: the legacy uploader only ever sent to Google.

**If more manual uploads happen before go-live**, load the new file (the next cron run re-marks):
```
python3 scripts/load_bing_manual_uploads.py <file.xlsx> > load.sql   # run load.sql in the SQL editor
```

## Reconciliation vs. owner's Bing revenue file (Sep 17-23, done 2026-09-26)

Owner file `All bing Revenue Sep 17 - 23.xlsx` (Caliber sheet 503 rows $4,803, Ringba sheet
86 rows $2,296; kept out of git: it holds phone numbers). Matched on `caliber_call_id`.

**501 of 503 Caliber rows are in `postbacks` with identical revenue and date.**

| Date | File (Caliber) | Will upload | Uploaded by hand | Held: duplicate | Sent to Google (postback gclid) | No postback |
|---|---|---|---|---|---|---|
| 9/17 | $661 | $50 | $427 | $150 | $34 | — |
| 9/18 | $610 | $76 | $439 | $95 | — | — |
| 9/21 | $908 | $733 | $39 | $85 | — | $51 |
| 9/22 | $1,067 | $866 | $118 | $83 | — | — |
| 9/23 | $1,557 | $1,476 | — | $19 | $55 | $7 |
| Total | $4,803 | $3,201 | $1,023 | $432 | $89 | $58 |

- Pipeline Bing rows not in the file: $228 would upload (Bing phone route or Bing lead where
  Caliber's lead record is not Bing). Kept: the dialled number decides.
- Duplicates: same phone + ET day + offer + revenue. Owner (2026-09-26): these are re-fires,
  keep dropping, both platforms.
- Ringba (ended 2026-09-22): $2,112 of $2,296 already uploaded by hand; $142 never uploaded
  (no transaction id or no msclkid). Left as is.
- Invalid route names (`nba`, `nba-internet-calls`, `helping-hands`, `utility-benefits`,
  `EDU IB`, `UB_ThankYou`) were pixel-test values; none since 2026-09-18.
- The owner's earlier screenshot of daily Bing totals does not match this file or the pipeline
  (no constant ratio or day shift); the file is the reference.

## Go live

The hourly health email covers Bing: it alerts when Bing rows wait over 2 hours and nothing
was sent in the last hour.


1. Stop the manual Bing uploads.
2. Set `BING_UPLOAD_MODE=live`. The next cron run sends the backlog oldest first, 150 per run
   (on 2026-09-25: 399 monetize rows and 601 transfers; see the table below).
3. Check: `select status, skip_reason, count(*) from platform_uploads where platform='bing' group by 1,2;`
   and `last_result` on any `failed`. Conversions show in Microsoft Ads within ~6 hours.

Undo: set `BING_UPLOAD_MODE=dry_run`. Rows already sent stay in Microsoft Ads.
