# Field Parity — end-to-end audit (5 Sep 2026)

Traces every field from the funnel form to Google Ads, and from the Caliber/Ringba
pixels to Google Ads, and says at which layer each one dies. **Code-verified and
data-verified**: every "fill" figure below is a live count from Supabase, not an
inference from source.

Windows used: `leads` = the 2,435 rows since the parity deploy (2026-09-03 20:12 UTC)
unless noted; `offline_conversion_events` = 30 days; CallTools echoes = 1,419 responses
in the last 36h.

---

## The eight layers

| # | Layer | What it is |
|---|---|---|
| L0 | Funnel HTML | 5 in-repo funnels + 1 undocumented external funnel |
| L1 | `submit-lead` | `LeadPayload` interface + validation + bot gate |
| L2a | `leads` table | 52 columns |
| L2b | CallTools | `POST /api/contacts/` — what the account actually stores |
| L2c | Caliber Leads | `POST /functions/v1/ingest/nba` |
| L3 | Pixels | Caliber + Ringba postbacks (the CALL side) |
| L4 | Webhooks | `ringba-conversion-webhook`, `ringba-transfer-webhook` |
| L5 | `offline_conversion_events` | 60 columns |
| L6 | `v_offline_conversion_export` | the upload gate |
| L7 | Google Data Manager API | click id + hashed PII only |

Reporting (`lead_report_*` RPCs → Apps Script → Sheet) hangs off L2a.

---

## Headline result

**The lead half (L0→L2) is in parity.** All five in-repo funnels post an identical
34-key payload; `leads` has a column for every one of them; both CRMs receive them.

**The call half (L3→L7) is not.** The Caliber conversion pixel sends 25 params, of
which **6 are empty on 100% of fires** and **11 more are never sent at all** —
including the three the September cutover work was built around.

---

## P0 — Caliber pixel gaps (revenue-affecting)

Measured over 9,336 Caliber events in 30 days.

| Param | Sent? | Non-empty | Consequence |
|---|---|---:|---|
| `transaction_id` | key present | **0 / 9,336** | Deterministic conversion↔lead matching is dead. Every match falls back to phone. **3,336 events (36%) matched no lead at all** and inherit nothing — no click id, no PII, no landing page. |
| `conversion_time` | key present | **0 / 9,336** | Webhook falls back to pixel-receipt time. Flagged as a risk in `PIXEL-FIELDS.md`; now confirmed live. |
| `event` | **not sent** | — | The `event=transfer\|monetize` router added in the cutover. Without it the endpoint URL is still the only routing signal — the exact single-point failure `CALIBER-CUTOVER.md` §1 exists to prevent. |
| `offer` | **not sent** | 0 / 9,336 | The `offer` column, its index, and the `api_type` format from migration `20260904210000` have never received a value. **When Energy migrates it will be filed as Internet in every log and report.** |
| `zip` | **not sent** | 0 / 9,336 | Google Enhanced Conversions builds its address identifier from first+last+**zip**. The export view backfills from the matched lead, so the 36% unmatched events upload with no address identifier. |

`msclkid`, `oppref_id`, `agent_name`, `queue` also arrive as always-empty keys.

**Upstream fix: all five are Caliber POC changes to the postback URL.** No code change
on our side — the webhooks already parse every one of them, and the columns already exist.

---

## P1 — CallTools drops 9 fields we post

`submit-lead` sends 15 fields CallTools previously never got. The API response echoes the
whole stored contact, so we can prove which landed. Of 1,419 echoes:

| Field we send | Key in echo | Verdict |
|---|---|---|
| `pubid`, `consent_url`, `trusted_form`, `oppref_id`, `gclid`, `gbraid`, `wbraid`, `msclkid`, `age`, `employment` | 1,419 / 1,419 | **lands** |
| `landing_page` | 0 / 1,419 | **dropped — no custom field** |
| `needs` | 0 / 1,419 | **dropped — no custom field** |
| `referrer` | 0 / 1,419 | **dropped — no custom field** |
| `ip_address` | 0 / 1,419 | **dropped — no custom field** |
| `user_agent` | 0 / 1,419 | **dropped — no custom field** |
| `ttclid`, `li_fat_id`, `twclid`, `epik` | 0 / 1,419 | dropped (no traffic yet, so harmless today) |

This is a **CallTools account configuration task, not a code change** — exactly the
"safe to send before the field exists" design in `DECISIONS.md`. But it matters more than
it looks: the Ringba enrich URL reads `{{%locals[contact][<field>]}}` off the CallTools
contact, so **anything CallTools drops can never reach a Ringba postback.** These five are
the prerequisite for closing the L3 gaps on the Ringba side.

`consent_url` is populated on 100% of echoes — that one worked.

---

## P1 — ValueTrack has no path at all

`offline_conversion_events.campaign_id / adgroup_id / creative_id / target_id / network`
were added on 4 Sep. **All five are 0-filled across all 51,386 events in 30 days**, from
both sources.

They cannot fill, because there is no upstream path. The chain needs four links and
currently has zero:

1. **Funnel** — `captureUTM()` captures 5 UTMs + 9 click ids. It does **not** capture
   `{campaignid}` / `{adgroupid}` / `{creative}` / `{targetid}` / `{network}`, and the Google
   Ads final URLs would need those ValueTrack params appended.
2. **`leads`** — has **no columns** for them. (This is the missing middle: the call table got
   the columns, the lead table did not.)
3. **CallTools** — no custom fields, so the Ringba enrich URL has nothing to read.
4. **Pixel** — neither Caliber nor Ringba sends them.

Note the warning already recorded on the column comment: CallTools' *dialer* campaign id is
also called `campaignid` in the enrich URL. These must stay on distinct tag names.

---

## P1 — Funnel-side fields with backend plumbing and no sender

Backend, both CRMs, and the DB are all ready. No funnel sends them.

| Field | `leads` fill | Wired at | Missing at |
|---|---:|---|---|
| `publisher` | **0 / 41,829** (30d) | column, CallTools `pubid`, Caliber `attribution.publisher` | every funnel |
| `click_timestamp` | **0 / 41,829** | column, Caliber `attribution.click_timestamp` | every funnel |
| `consent_ad_storage` / `_ad_user_data` / `_ad_personalization` | no column | Caliber consent block | every funnel — **and intentionally so** (EU/UK only, NBA is US traffic) |
| `lead_source` | 2,357 / 2,435 | derived from `utm_source` server-side | funnel never sends an explicit one |

`publisher` is the one worth doing: it is what gates webhook ingest (`pub=NBA`) and what
`pipeline-health-check` alerts on.

---

## P2 — A sixth funnel that isn't in the repo

**153 leads in the 2-day window (6.3% of volume)** post to `submit-lead` from
`https://apply.nationalbenefitalliance.com/` — a host that does not exist in the `nba3`
repo or `vercel.json`.

- `utm_source = meta` on all of them
- `landing_page` → **null** (this, not `apply/0`, is the current null-landing_page population)
- `street_address`, `city`, `annual_income`, `employment_status` → all blank
- `needs` → never sent
- `citizenship`, `dob`, `state`, `zip` → present

It behaves like a lean variant nobody documented. It is not covered by `_field_parity.py`,
so every future funnel-side parity migration will silently skip it. **Decide whether to
adopt it (give it `landing_page: 'meta1'` and bring it to parity) or retire it.**

---

## P2 — `needs` is deployed but only two funnels are proven

Deployed 2026-09-05 00:17 UTC. In the 37 leads since:

| Funnel | leads | with `needs` |
|---|---:|---:|
| `apply2` | 26 | 23 (3 chose no tile) |
| `oa1` | 6 | 3 |
| `bg1` / `info01` / `apply0` | **0** | — |
| external Meta funnel | 5 | 0 (doesn't send it) |

Not broken — those three simply haven't converted a lead since the deploy. **Re-run this
count in a few days** before calling `needs` done. Note CallTools drops it regardless (above),
so today `needs` reaches `leads` and Caliber only.

---

## P2 — Reporting exposes 14 of 52 lead columns

`lead_report_leads()` returns: `submitted_at_et, phone, email, transaction_id, crm_status,
ct_new_or_merge, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_content,
utm_term`.

None of `needs`, `landing_page`, `lead_source`, `publisher`, `age`, `state`, `zip`,
`citizenship`, `caliber_status`, `caliber_lead_id`, `consent_timestamp` are reportable.
Every field added in the last two weeks is invisible to the Sheet. Widening the RETURNS TABLE
is additive and safe, but the Apps Script column mapping must be updated in the same change.

---

## What actually reaches Google (L6 → L7)

`upload-google-offline-conversions` sends only:

- one click id — `gclid` → `gbraid` → `wbraid`
- hashed `email`, hashed `phone`, and (`first_name` + `last_name` + `zip`) as an address identifier
- `conversion_time`, `conversion_value`, `currency_code`, `order_id`, conversion action id

Everything else in the 60-column table is **reporting-only by design**. The export view even
hardcodes `session_attributes` and `user_agent` to `NULL::text` while both webhooks work to
collect `user_agent`.

This is not a defect — it is worth stating plainly so nobody adds a column expecting it in
Google.

---

## Verified-clean: the funnel payload

All five in-repo funnels post the identical 34 keys (`apply/0` sends a 35th, `age`):

```
transaction_id state dob citizenship street_address city zip annual_income
employment_status first_name last_name email phone tcpa_consent
trusted_form_cert_url gclid msclkid oppref fbclid ttclid li_fat_id twclid epik
landing_page wbraid gbraid utm_source utm_medium utm_campaign utm_content
utm_term needs hp_website form_duration_ms
```

`_field_parity.py` is idempotent and has been applied. No drift between funnels.

---

## Fix order

| # | Action | Owner | Layer | Code change? |
|---|---|---|---|---|
| 1 | Caliber POC adds `transaction_id`, `conversion_time`, `event`, `offer`, `zip` to both postback URLs | Caliber | L3 | **no** |
| 2 | Create 5 CallTools custom fields: `landing_page`, `needs`, `referrer`, `ip_address`, `user_agent` | CallTools account | L2b | **no** |
| 3 | Decide: adopt or retire the `apply.` Meta funnel | owner | L0 | depends |
| 4 | Funnel sends `publisher` + `click_timestamp` | site repo | L0 | yes, small |
| 5 | ValueTrack chain — Ads final URLs, `captureUTM()`, 5 new `leads` columns, 5 CallTools fields | all four | L0–L3 | yes, 4 places |
| 6 | Widen `lead_report_leads()` + Apps Script columns | backend | reporting | yes, additive |

Nothing above changes existing behaviour: every item is additive, and items 1–3 are
configuration outside this repo.

---

## Method

- Funnel payloads read directly from the five `step-4` / `step-3-phone` files.
- `submit-lead` v62, `ringba-conversion-webhook` v46, `ringba-transfer-webhook` v16 (live versions).
- Fill rates: `count(col)` over the stated window.
- CallTools storage proven from the API response echo in `api_logs`, which returns the whole
  contact record — the technique `DECISIONS.md` records as having corrected a wrong conclusion once before.
- Pixel params proven from `offline_conversion_events.raw_payload`, counting keys present vs
  keys non-empty separately (the distinction is the whole finding).
