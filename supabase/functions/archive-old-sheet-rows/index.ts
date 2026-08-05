// archive-old-sheet-rows
//
// Keeps the live offline-conversion Google Sheet within Google Ads' 90-day
// window and under Sheets' cell cap, automatically:
//
//   1. LIVE  -> ARCHIVE: rows on the live tab whose Conversion Time is older
//      than ARCHIVE_AFTER_DAYS (default 85) are appended to the archive tab
//      ("LiveImport - OLD") and then DELETED from the live tab. 85 (not 90)
//      leaves a buffer, since Google's window is measured from the CLICK, which
//      is slightly older than the call.
//   2. ARCHIVE purge: rows on the archive tab older than PURGE_ARCHIVE_AFTER_DAYS
//      (default 175 = 85 + ~90) are DELETED, so the archive stays bounded.
//   3. Whitespace: deletions use deleteDimension (rows are REMOVED, shrinking
//      the grid — not just cleared), and blank rows + trailing empty grid rows
//      are trimmed on both tabs, so empty cells don't count toward the cap.
//
// Order of operations is archive-BEFORE-delete, so a mid-run failure leaves
// rows on the live tab (safe) rather than losing them. The full history also
// lives permanently in offline_conversion_events regardless.
//
// Deletes the OLDEST rows (top of the sheet); sync-google-sheet APPENDS to the
// bottom — different regions, so they don't collide even if they overlap. The
// cron is also staggered off the :00/:15/:30/:45 sync slots.
//
// Auth (inbound): shared secret in `x-invoke-secret` header (UPLOADER_INVOKE_SECRET).
//
// Env: GOOGLE_SHEETS_SA_JSON, GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_TAB_NAME
//   (live), GOOGLE_SHEETS_ARCHIVE_TAB_NAME (defaults to "LiveImport - OLD").
//
// Query params: ?dry_run=true | ?archive_after_days=N | ?purge_archive_after_days=N

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

const ARCHIVE_AFTER_DAYS_DEFAULT = 85;
const PURGE_ARCHIVE_AFTER_DAYS_DEFAULT = 175;
const ARCHIVE_TAB_DEFAULT = "LiveImport - OLD";
const NUM_COLS = 15;        // Sheet is A:O (15 columns)
const CONV_TIME_IDX = 4;    // column E (0-based) = Conversion Time
const PHONE_IDX = 10;       // column K (0-based) = phone (E.164 text)

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// --- Service-account JWT auth (shared with sync-google-sheet / prune) ---

function pemToPkcs8ArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

function base64urlEncode(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") bytes = new TextEncoder().encode(input);
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else bytes = input;
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleAccessToken(sa: ServiceAccountJson, scope: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email, scope,
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const signingInput =
    `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8ArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64urlEncode(sigBuf)}`;
  const tokenResp = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt,
    }),
  });
  if (!tokenResp.ok) throw new Error(`Google token exchange failed: ${tokenResp.status} ${await tokenResp.text()}`);
  const tok = await tokenResp.json() as { access_token?: string };
  if (!tok.access_token) throw new Error("Google token exchange returned no access_token");
  return tok.access_token;
}

// --- Sheets helpers ---

type Cell = string | number | boolean | null;

async function getTabMeta(token: string, spreadsheetId: string, title: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`metadata fetch failed: ${resp.status} ${await resp.text()}`);
  const meta = await resp.json() as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } } }>;
  };
  const s = (meta.sheets || []).find((x) => x.properties?.title === title);
  if (!s || s.properties?.sheetId === undefined) throw new Error(`Tab '${title}' not found`);
  return { sheetId: s.properties.sheetId as number, rowCount: s.properties.gridProperties?.rowCount ?? 0 };
}

async function readTab(token: string, spreadsheetId: string, title: string): Promise<Cell[][]> {
  // UNFORMATTED so dates come back as serials (reliable) rather than a
  // locale-formatted, ambiguous string. Read from row 2 (skip header).
  const range = encodeURIComponent(`${title}!A2:O`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`read '${title}' failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json() as { values?: Cell[][] };
  return j.values || [];
}

// Parse a Conversion Time cell (Sheets serial number OR string) to a Date.
function parseConvCell(cell: Cell): Date | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number") {
    // Sheets/Excel serial: days since 1899-12-30; 25569 = 1970-01-01.
    const d = new Date(Math.round((cell - 25569) * 86400000));
    return isNaN(d.getTime()) ? null : d;
  }
  let s = String(cell).trim();
  if (!s) return null;
  // "YYYY-MM-DD HH:MM:SS+0000" -> ISO "YYYY-MM-DDTHH:MM:SS+00:00"
  const iso = s.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  let d = new Date(iso);
  if (!isNaN(d.getTime())) return d;
  d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isBlankRow(row: Cell[] | undefined): boolean {
  if (!row || row.length === 0) return true;
  return row.every((c) => c === null || c === undefined || String(c).trim() === "");
}

function fmtConvTime(d: Date): string {
  // Canonical "YYYY-MM-DD HH:MM:SS+0000" (UTC), matching the export view.
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+0000`;
}

// Merge a set of 1-based row numbers into contiguous deleteDimension requests,
// ordered DESCENDING so earlier deletes don't shift later ones.
function buildDeleteRequests(rowNumbers: number[], sheetId: number) {
  const sorted = [...new Set(rowNumbers)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && r === last[1] + 1) last[1] = r;
    else ranges.push([r, r]);
  }
  ranges.sort((a, b) => b[0] - a[0]);
  return ranges.map(([s, e]) => ({
    deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: s - 1, endIndex: e } },
  }));
}

async function batchUpdate(token: string, spreadsheetId: string, requests: object[]) {
  if (requests.length === 0) return;
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    },
  );
  if (!resp.ok) throw new Error(`batchUpdate failed: ${resp.status} ${await resp.text()}`);
}

async function appendRows(token: string, spreadsheetId: string, title: string, rows: Cell[][]) {
  if (rows.length === 0) return;
  // RAW so values (dates as strings, "+..." phones) are stored verbatim without
  // Sheets re-interpreting them.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `/values/${encodeURIComponent(title)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ range: title, majorDimension: "ROWS", values: rows }),
  });
  if (!resp.ok) throw new Error(`append to '${title}' failed: ${resp.status} ${await resp.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const archiveAfterDays = Number(url.searchParams.get("archive_after_days")) || ARCHIVE_AFTER_DAYS_DEFAULT;
  const purgeAfterDays = Number(url.searchParams.get("purge_archive_after_days")) || PURGE_ARCHIVE_AFTER_DAYS_DEFAULT;

  const spreadsheetId = Deno.env.get("GOOGLE_SHEETS_SPREADSHEET_ID") || "";
  const liveTab = Deno.env.get("GOOGLE_SHEETS_TAB_NAME") || "";
  const archiveTab = Deno.env.get("GOOGLE_SHEETS_ARCHIVE_TAB_NAME") || ARCHIVE_TAB_DEFAULT;
  const saRaw = Deno.env.get("GOOGLE_SHEETS_SA_JSON") || "";
  if (!spreadsheetId || !liveTab || !saRaw) {
    return new Response(JSON.stringify({ error: "Missing required env vars" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  let sa: ServiceAccountJson;
  try { sa = JSON.parse(saRaw); } catch (e) {
    return new Response(JSON.stringify({ error: `Invalid GOOGLE_SHEETS_SA_JSON: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const nowMs = Date.now();
  const archiveCutoff = nowMs - archiveAfterDays * 86400000;
  const purgeCutoff = nowMs - purgeAfterDays * 86400000;

  try {
    const token = await getGoogleAccessToken(sa, "https://www.googleapis.com/auth/spreadsheets");
    const liveMeta = await getTabMeta(token, spreadsheetId, liveTab);
    const archiveMeta = await getTabMeta(token, spreadsheetId, archiveTab);

    // ---- Stage 1: live -> archive ----
    const liveRows = await readTab(token, spreadsheetId, liveTab);
    const toArchive: Cell[][] = [];
    const liveDeleteRowNums: number[] = [];
    for (let i = 0; i < liveRows.length; i++) {
      const rowNum = i + 2; // A2:O => first data row is sheet row 2
      const row = liveRows[i];
      if (isBlankRow(row)) { liveDeleteRowNums.push(rowNum); continue; }
      const d = parseConvCell(row[CONV_TIME_IDX]);
      if (d === null) continue; // unparseable date -> leave it, never guess
      if (d.getTime() < archiveCutoff) {
        const padded: Cell[] = [];
        for (let c = 0; c < NUM_COLS; c++) padded[c] = row[c] ?? "";
        padded[CONV_TIME_IDX] = fmtConvTime(d);            // normalize for readability
        if (padded[PHONE_IDX] != null) padded[PHONE_IDX] = String(padded[PHONE_IDX]);
        toArchive.push(padded);
        liveDeleteRowNums.push(rowNum);
      }
    }
    // Trailing empty grid rows on the live tab (beyond the last data row).
    const liveLastDataRow = liveRows.length + 1; // header(1) + data
    for (let r = liveLastDataRow + 1; r <= liveMeta.rowCount; r++) liveDeleteRowNums.push(r);

    // ---- Stage 2: purge archive ----
    const archiveRows = await readTab(token, spreadsheetId, archiveTab);
    const archiveDeleteRowNums: number[] = [];
    for (let i = 0; i < archiveRows.length; i++) {
      const rowNum = i + 2;
      const row = archiveRows[i];
      if (isBlankRow(row)) { archiveDeleteRowNums.push(rowNum); continue; }
      const d = parseConvCell(row[CONV_TIME_IDX]);
      if (d === null) continue;
      if (d.getTime() < purgeCutoff) archiveDeleteRowNums.push(rowNum);
    }
    const archiveLastDataRow = archiveRows.length + 1;
    for (let r = archiveLastDataRow + 1; r <= archiveMeta.rowCount; r++) archiveDeleteRowNums.push(r);

    const summary = {
      dry_run: dryRun,
      archive_after_days: archiveAfterDays,
      purge_archive_after_days: purgeAfterDays,
      to_archive: toArchive.length,
      live_rows_to_delete: [...new Set(liveDeleteRowNums)].length,
      archive_rows_to_purge: [...new Set(archiveDeleteRowNums)].length,
    };

    if (dryRun) {
      return new Response(JSON.stringify({ ok: true, ...summary, sample_archive_row: toArchive[0] ?? null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Order matters:
    //   1. PURGE archive first — archiveDeleteRowNums (incl. trailing-empty
    //      rows) were computed on the PRE-append archive; doing this before the
    //      append means we never delete freshly-appended rows.
    //   2. APPEND the newly-aged rows to the (now purged) archive.
    //   3. DELETE from live last — append-to-archive happens BEFORE the live
    //      delete, so a failure leaves rows on the live tab (safe), never lost.
    await batchUpdate(token, spreadsheetId, buildDeleteRequests(archiveDeleteRowNums, archiveMeta.sheetId));
    await appendRows(token, spreadsheetId, archiveTab, toArchive);
    await batchUpdate(token, spreadsheetId, buildDeleteRequests(liveDeleteRowNums, liveMeta.sheetId));

    return new Response(JSON.stringify({ ok: true, ...summary }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("archive-old-sheet-rows error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
