# Offline-Conversion Reconciliation — business report ↔ Supabase ↔ Google Ads

Branch: `offline-cv-reconciliation` (backend repo). **Nothing deployed, nothing applied.**
Purpose: prove that the offline conversion events we upload to Google Ads match what the
business counts, and quantify every place they don't.

---

## 1. The counting basis (solved)

The business table's two column groups decode exactly to:

| Business column | Definition in `offline_conversion_events` |
|---|---|
| "based on UTM_Source" | `publisher='NBA'` AND `utm_source ILIKE 'google'` |
| "based on gclid" (no dedupe) | the above **AND** `gclid <> ''` |
| "based on gclid" (deduped) | `COUNT(DISTINCT gclid)` within the above |

Day = **America/New_York** calendar day of `conversion_time` (matches the pipeline's own
dedupe keys). The business report labelled **"2-Sep" is ET day 2026-09-01** — a prior-day pull.

Proof, ET 2026-09-01, Ringba transfers:

| | Business | Supabase | Δ |
|---|---|---|---|
| gclid, raw | 541 | **541** | 0 |
| gclid, deduped | 454 | **454** | 0 |
| UTM_Source | 547 | 546 | −1 |

The −1 on UTM_Source is a single row that landed after their pull (the table is live; late
pixel fires still post to prior ET days). **Ringba transfers reconcile.**

## 2. Full Sep 1 reconciliation

| Line | Business UTM | Ours | Δ | Business gclid raw / dedup | Ours | Δ |
|---|---|---|---|---|---|---|
| Ringba Xfer | 547 | 546 | −1 | 541 / 454 | **541 / 454** | 0 / 0 |
| Ringba Monetized | 288 | 293 | +5 | 284 / 284 | 289 / 273 | +5 / −11 |
| Internet Xfer | 579 | 567 | −12 | 543 | 552 | +9 |
| Internet Monetized | 554 | 567 | +13 | 519 | 552 | +33 |

Three open variances, in priority order:

**(a) Internet — two different source systems.** The business derives internet transfers from a
**Caliber report download**; our pipeline derives them from the **Caliber revenue pixel**
(trigger `derive_internet_transfer_event` writes one `call_transferred` per monetization,
deduped `caliber:call_transferred:<phone10>:<ET-date>`). Consequence: our internet Xfer count
is **identical to** our internet Monetized count by construction (971 = 971 gross on Sep 1),
so we structurally cannot reproduce the business's 579 ≠ 554 split. Any call that transferred
but never fired a revenue pixel never enters Supabase and is **never uploaded to Google Ads**.

→ **Next step (agreed):** diff the two sets at record level before changing anything.
Run `queries/internet_xfer_detail.sql`, export CSV, and run:

```bash
python3 tools/diff_internet_xfers.py business_caliber_export.csv supabase_detail.csv --out exceptions.csv
```

If ingest coverage is ≥98%, the problem is downstream (basis/dedupe/day/filter) and no pipeline
change is warranted. If it's materially below, we are under-uploading internet transfers and the
fix is a second Caliber feed (dispo/report-based ingest), scoped but not built.

**(b) Ringba Monetized, +5 rows / dedupe mismatch.** Ours: 289 gclid rows collapsing to 273
distinct. Business: 284 both ways — i.e. their monetized set has *no* repeat gclids, ours has 16.
Drill-down needed on the 16 repeats (same click id monetizing twice in a day) to decide whether
they're legitimate second monetizations or double-fires.

**(c) Day-boundary drift.** Prior-day totals move for hours after midnight ET. Always reconcile a
**settled** day (≥24h old), and pull both sides at the same moment.

## 3. The number the business table is missing

The business table counts `utm_source='google'`. The pipeline uploads on a **wider** rule
(`v_offline_conversion_export`): utm google **OR** `ib_source ~ google|youtube` **OR** legacy
`NBA_ThankYou`/`NBA_Funnel`/`NBA_InactivityPopup` **OR** *both source fields blank*
("unknown → still upload").

ET 2026-09-01, Ringba:

| Bucket | Xfer rows | with gclid | uploaded to Google |
|---|---|---|---|
| `utm=google` | 546 | 541 | 546 |
| both source fields blank (unknown) | 266 | 1 | 266 |
| `utm=bing` | 34 | 1 | 0 |
| `utm=meta` | 10 | 0 | 0 |
| **Total uploaded** | | | **812** |

Same pattern on monetized: 293 utm-google + 135 unknown = **428 uploaded**.

So for Sep 1 Google Ads received **812 CallXfer** and **428 CallConvertOffline** rows against a
business count of 547 / 288. The extra ~48% are the unknown-source rows, which carry **almost no
gclid** (1 of 266) — they can only match through enhanced-conversion PII (hashed email/phone), so
they inflate uploads far more than they will inflate *attributed* conversions. This is the single
biggest driver of "Google Ads doesn't match my table" and must be modelled before comparing to the
Ads UI.

## 4. Google Ads-side estimate (the third reconciliation)

Google Ads will report **fewer** than we upload. Expected shrinkage, in order:

1. **No click id and no matchable PII** → dropped silently. Mostly the unknown-source bucket.
2. **Click outside the conversion window** (default 90 days) → dropped.
3. **Conversion action counting setting.** `CallXfer` was specced **Count: Every**. If it is
   still Every, the business's gclid-*deduped* column (454) understates what Google books;
   the right comparison is the raw column (541). **This must be confirmed in the Ads UI** —
   the current process assumes "one xfer per click" for transfers and "every per click" for
   CCO, which can only be true if the two actions are configured differently.
4. **Attribution model / conversion-time reporting.** Google credits the conversion to the
   **click date**, not the call date. A day-over-day comparison against an ET call-day table
   will never tie; compare 7-day totals, or pull the Ads report by conversion date.

Estimate formula to validate once (3) is confirmed:

```
expected_ads_count(day) ≈ uploaded_to_google(day)
                          × match_rate(click id present, or ECL PII matched)
                          × in_window_rate
   ... reported by CLICK date, not call date
```

## 5. Files

| File | What |
|---|---|
| `queries/recon_daily.sql` | Ad-hoc daily recon in the business's layout. Read-only, no DDL. Edit the two dates. |
| `queries/internet_xfer_detail.sql` | Record-level internet transfers for one ET day, for the Caliber diff. |
| `tools/diff_internet_xfers.py` | Diffs the Caliber report download vs our ingest by phone+day. Read-only. |
| `../../supabase/migrations/20260902130000_offline_cv_recon_daily_view.sql` | Same recon as a permanent view `v_offline_cv_recon_daily`. **NOT APPLIED.** |

## 6. Open items (owner)

1. Provide the **Caliber internet-transfer report download for 2026-09-01** so the record-level
   diff in §2(a) can run. This is the blocker on the internet variance.
2. Confirm in the Google Ads UI the **Count** setting on `CallXfer` and on `CallConvertOffline`
   (Every vs One). Everything in §4 depends on it.
3. Decide whether the **unknown-source upload rule** (§3) stays. It roughly doubles Ringba
   uploads with rows that carry no click id.

## 7. Caveats

- The recon reads live data; a day keeps moving for hours after ET midnight.
- Internet/Caliber rows only exist from **2026-08-31** (Caliber cutover). Earlier days have no
  internet channel in this table.
- Ringba gclid raw-vs-dedup only diverges from **~2026-08-30** onward, when ingest went
  per-call gross. Before that, one row per click id, so raw == dedup.
