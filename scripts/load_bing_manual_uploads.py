"""Turn the Microsoft Ads manual upload files into SQL for public.bing_manual_uploads.

Usage (needs openpyxl):
    python3 scripts/load_bing_manual_uploads.py EXCEL_Conversion_Enhanced_Import_Template_*.xlsx > load.sql
Then run load.sql in the Supabase SQL editor, followed by: select mark_bing_manual_uploads();

Reads the "Enhanced Import" template: data starts after the "Conversion Name" header row,
times are UTC (Parameters:TimeZone=+0000). Re-running is safe: duplicates are ignored.
"""
import os
import sys

import openpyxl


def rows(path):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
    started = False
    for r in ws.iter_rows(values_only=True):
        if not started:
            started = r and r[0] == "Conversion Name"
            continue
        if not r or not r[0] or not r[4]:
            continue
        yield r[0], r[1], float(r[2] or 0), r[4]


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


values = []
for path in sys.argv[1:]:
    name = os.path.basename(path)
    for conv_name, t, value, msclkid in rows(path):
        values.append(f"({q(msclkid)},{q(t.isoformat() + '+00')},{value},{q(conv_name)},{q(name)})")

if not values:
    sys.exit("no rows found")
print("insert into public.bing_manual_uploads (msclkid, conversion_time, conversion_value, conversion_name, source_file) values")
print(",\n".join(values))
print("on conflict (msclkid, conversion_time) do nothing;")
print(f"-- {len(values)} rows from {len(sys.argv) - 1} files", file=sys.stderr)
