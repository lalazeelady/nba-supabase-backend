#!/usr/bin/env python3
"""
Diff the business's Caliber internet-transfer report download against what our pixel
ingest landed in offline_conversion_events.

Usage:
    python3 diff_internet_xfers.py business.csv supabase.csv [--phone-col PHONE]

business.csv : the Caliber report export the business downloads (any column layout;
               the phone column is auto-detected, or pass --phone-col).
supabase.csv : CSV export of queries/internet_xfer_detail.sql (has a phone10 column).

Match key = last 10 digits of the phone number, within the day. This mirrors the
pipeline's internet dedupe key (source:call_transferred:<phone10>:<ET-date>), so a
clean diff means ingest is faithful and any remaining variance is downstream.

Read-only. Writes nothing but a report to stdout (and optional --out CSV).
"""
import argparse
import csv
import re
import sys
from collections import Counter

PHONE_HINTS = ("phone", "caller", "ani", "number", "from", "callerid", "caller_id")


def digits10(v):
    d = re.sub(r"\D", "", v or "")
    return d[-10:] if len(d) >= 10 else ""


def detect_phone_col(header, rows):
    # 1) name hint
    for h in header:
        if any(k in h.lower().replace(" ", "_") for k in PHONE_HINTS):
            if sum(1 for r in rows[:200] if digits10(r.get(h, ""))) > len(rows[:200]) * 0.5:
                return h
    # 2) content sniff: column where most values yield a 10-digit phone
    best, best_hits = None, 0
    for h in header:
        hits = sum(1 for r in rows[:200] if digits10(r.get(h, "")))
        if hits > best_hits:
            best, best_hits = h, hits
    if best_hits > len(rows[:200]) * 0.5:
        return best
    return None


def load(path, phone_col=None):
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit(f"{path}: no rows")
    header = list(rows[0].keys())
    col = phone_col or detect_phone_col(header, rows)
    if not col:
        sys.exit(f"{path}: could not detect a phone column. Columns: {header}\n"
                 f"Re-run with --phone-col <name>.")
    keys = Counter()
    for r in rows:
        k = digits10(r.get(col, ""))
        if k:
            keys[k] += 1
    blanks = len(rows) - sum(keys.values())
    return rows, col, keys, blanks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("business_csv")
    ap.add_argument("supabase_csv")
    ap.add_argument("--phone-col", help="phone column name in business_csv")
    ap.add_argument("--out", help="write the exception rows to this CSV")
    a = ap.parse_args()

    brows, bcol, bkeys, bblank = load(a.business_csv, a.phone_col)
    srows, scol, skeys, sblank = load(a.supabase_csv, "phone10")

    only_b = {k: n for k, n in bkeys.items() if k not in skeys}
    only_s = {k: n for k, n in skeys.items() if k not in bkeys}
    both = set(bkeys) & set(skeys)
    dupe_b = {k: n for k, n in bkeys.items() if n > 1}
    dupe_s = {k: n for k, n in skeys.items() if n > 1}

    print("INTERNET TRANSFER INGEST DIFF")
    print("=" * 60)
    print(f"business file       : {a.business_csv}  (phone col: {bcol})")
    print(f"supabase file       : {a.supabase_csv}  (phone col: {scol})")
    print()
    print(f"business rows       : {len(brows):>6}   unique phones: {len(bkeys):>6}   blank phone: {bblank}")
    print(f"supabase rows       : {len(srows):>6}   unique phones: {len(skeys):>6}   blank phone: {sblank}")
    print()
    print(f"matched phones      : {len(both):>6}")
    print(f"business only       : {len(only_b):>6}   (transferred but never reached our pipeline)")
    print(f"supabase only       : {len(only_s):>6}   (we ingested, business report did not list)")
    denom = len(bkeys) or 1
    print(f"ingest coverage     : {len(both) / denom:>6.1%} of business unique phones")
    print()
    print(f"business dupe phones: {len(dupe_b):>6}  (collapse to 1 under phone/day dedupe)")
    print(f"supabase dupe phones: {len(dupe_s):>6}  (should be 0 - dedupe key is phone+ET-day)")
    print()
    if len(only_b) / denom > 0.02:
        print("VERDICT: material ingest gap. The business report sees transfers our pixel")
        print("         never fired for. Fix is upstream (ingest), not in the counting.")
    else:
        print("VERDICT: ingest is faithful (<2% gap). Any remaining variance is DOWNSTREAM -")
        print("         counting basis, dedupe rule, day boundary, or the Google upload filter.")

    if a.out:
        with open(a.out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["side", "phone10", "count"])
            for k, n in sorted(only_b.items()):
                w.writerow(["business_only", k, n])
            for k, n in sorted(only_s.items()):
                w.writerow(["supabase_only", k, n])
        print(f"\nexceptions written to {a.out}")


if __name__ == "__main__":
    main()
