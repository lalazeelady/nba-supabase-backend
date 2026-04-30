// backfill-google-sheet-pii
//
// One-shot helper: walks the Google Sheet, finds rows whose PII columns
// (I:O) are blank, looks up each row's Order ID (ringba_call_id) in
// offline_conversion_events + leads JOIN, and batch-updates the missing
// PII back into the Sheet.
//
// Scope: rows already in the Sheet from before sync-google-sheet started
// emitting PII. Idempotent — re-running just no-ops on rows already
// populated. Does NOT change sheet_synced_at (those rows stay synced).
//
// Auth: shared secret in `x-invoke-secret` header (same as syncer).
//
// Required Edge Function secrets (same as sync-google-sheet):
//   GOOGLE_SHEETS_SA_JSON
//   GOOGLE_SHEETS_SPREADSHEET_ID
//   GOOGLE_SHEETS_TAB_NAME
//   UPLOADER_INVOKE_SECRET
//
// Query params:
//   ?dry_run=true  — show counts and a sample update, don't write to Sheet.
//   ?limit=N       — cap number of rows updated (default unlimited).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface PiiTuple {
  ip: string;
  email: string;
  phone: string;
  first: string;
  last: string;
}

// --- Service-account JWT auth (mirrors sync-google-sheet) ---

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
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleAccessToken(sa: ServiceAccountJson, scope: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8ArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64urlEncode(sigBuf)}`;

  const tokenResp = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    throw new Error(`Google token exchange failed: ${tokenResp.status} ${text}`);
  }
  const tok = await tokenResp.json() as { access_token?: string };
  if (!tok.access_token) {
    throw new Error(`Google token exchange returned no access_token: ${JSON.stringify(tok)}`);
  }
  return tok.access_token;
}

// --- PII normalization (mirrors view's coalesce + phone E.164 logic) ---

function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/^\+/.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return "";
}

function firstNonEmpty(...vals: (string | null | undefined)[]): string {
  for (const v of vals) {
    if (v !== null && v !== undefined && String(v).length > 0) return String(v);
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : null;

  const spreadsheetId = Deno.env.get("GOOGLE_SHEETS_SPREADSHEET_ID") || "";
  const tabName = Deno.env.get("GOOGLE_SHEETS_TAB_NAME") || "";
  const saRaw = Deno.env.get("GOOGLE_SHEETS_SA_JSON") || "";
  if (!spreadsheetId || !tabName || !saRaw) {
    return new Response(
      JSON.stringify({ error: "Missing required env vars" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let sa: ServiceAccountJson;
  try {
    sa = JSON.parse(saRaw) as ServiceAccountJson;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Invalid GOOGLE_SHEETS_SA_JSON: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 1. Build PII map keyed by ringba_call_id from oce + leads JOIN.
  // (PostgREST nested select via the foreign key on offline_conversion_events.lead_id.)
  const { data: oceRows, error: oceErr } = await supabase
    .from("offline_conversion_events")
    .select(
      "ringba_call_id, caller_email, caller_id, caller_first_name, caller_last_name, raw_payload, " +
      "lead:leads ( email, phone, first_name, last_name, ip_address )",
    )
    .eq("publisher", "NBA")
    .gt("conversion_value", 0)
    .not("ringba_call_id", "is", null);

  if (oceErr) {
    return new Response(
      JSON.stringify({ error: `oce query: ${oceErr.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const piiByOrderId = new Map<string, PiiTuple>();
  for (const r of (oceRows ?? []) as Array<Record<string, unknown>>) {
    const orderId = String(r.ringba_call_id || "").trim();
    if (!orderId) continue;
    const lead = (r.lead || {}) as Record<string, unknown>;
    const rawPayload = (r.raw_payload || {}) as Record<string, unknown>;

    const ip = firstNonEmpty(
      rawPayload.ip_address as string | undefined,
      lead.ip_address as string | undefined,
    );
    const email = firstNonEmpty(
      r.caller_email as string | undefined,
      lead.email as string | undefined,
    );
    const phone = normalizePhone(
      firstNonEmpty(r.caller_id as string | undefined, lead.phone as string | undefined),
    );
    const first = firstNonEmpty(
      r.caller_first_name as string | undefined,
      lead.first_name as string | undefined,
    );
    const last = firstNonEmpty(
      r.caller_last_name as string | undefined,
      lead.last_name as string | undefined,
    );

    if (!ip && !email && !phone && !first && !last) continue;
    piiByOrderId.set(orderId, { ip, email, phone, first, last });
  }

  // 2. Auth + read the Sheet (cols A:O from row 2 down).
  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(sa, "https://www.googleapis.com/auth/spreadsheets");
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Auth failed: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const readRange = encodeURIComponent(`${tabName}!A2:O`);
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${readRange}`;
  const readResp = await fetch(readUrl, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!readResp.ok) {
    const text = await readResp.text();
    return new Response(
      JSON.stringify({ error: `Sheet read failed: ${readResp.status} ${text}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const readJson = await readResp.json() as { values?: string[][] };
  const sheetRows = readJson.values || [];

  // 3. Walk rows and build batch updates.
  // Sheet row index (1-based) = arrayIndex + 2  (we read A2:O, so index 0 is row 2)
  const updates: Array<{ range: string; values: (string)[][] }> = [];
  let scanned = 0;
  let alreadyPopulated = 0;
  let noOrderId = 0;
  let noSupabaseMatch = 0;
  let toUpdate = 0;

  for (let i = 0; i < sheetRows.length; i++) {
    scanned++;
    const row = sheetRows[i];
    const orderId = String(row[7] || "").trim(); // column H = Order ID
    if (!orderId) {
      noOrderId++;
      continue;
    }

    const pii = piiByOrderId.get(orderId);
    if (!pii) {
      noSupabaseMatch++;
      continue;
    }

    // Per-cell merge: keep whatever the sheet has, only fill empty cells
    // from Supabase. Preserves manual edits + lets partial-PII rows get
    // their missing cells topped up.
    const sheetIp = String(row[8] || "");
    const sheetEmail = String(row[9] || "");
    const sheetPhone = String(row[10] || "");
    const sheetFirst = String(row[11] || "");
    const sheetLast = String(row[12] || "");
    const sheetSession = String(row[13] || "");
    const sheetAgent = String(row[14] || "");

    const mergedIp = sheetIp || pii.ip;
    const mergedEmail = sheetEmail || pii.email;
    const mergedPhone = sheetPhone || pii.phone;
    const mergedFirst = sheetFirst || pii.first;
    const mergedLast = sheetLast || pii.last;

    // Skip if nothing actually changes (idempotent re-runs).
    if (
      mergedIp === sheetIp &&
      mergedEmail === sheetEmail &&
      mergedPhone === sheetPhone &&
      mergedFirst === sheetFirst &&
      mergedLast === sheetLast
    ) {
      alreadyPopulated++;
      continue;
    }

    const sheetRowNumber = i + 2; // A2 is row 2 → row 2 + i
    updates.push({
      range: `${tabName}!I${sheetRowNumber}:O${sheetRowNumber}`,
      values: [[
        mergedIp,
        mergedEmail,
        mergedPhone,
        mergedFirst,
        mergedLast,
        sheetSession,
        sheetAgent,
      ]],
    });
    toUpdate++;
    if (limit !== null && toUpdate >= limit) break;
  }

  if (dryRun) {
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: true,
        sheet_rows_scanned: scanned,
        already_populated: alreadyPopulated,
        no_order_id: noOrderId,
        no_supabase_match: noSupabaseMatch,
        would_update: toUpdate,
        sample_update: updates[0] || null,
        oce_rows_indexed: piiByOrderId.size,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (updates.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        sheet_rows_scanned: scanned,
        already_populated: alreadyPopulated,
        no_order_id: noOrderId,
        no_supabase_match: noSupabaseMatch,
        updated: 0,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 4. batchUpdate the Sheet. Sheets API caps body size; 300 rows of 7 cells
  // is well under any limit. If we ever need bigger, chunk by 1000 ranges.
  const writeUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const writeResp = await fetch(writeUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: updates,
    }),
  });
  if (!writeResp.ok) {
    const text = await writeResp.text();
    return new Response(
      JSON.stringify({ error: `Sheet batchUpdate failed: ${writeResp.status} ${text}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const writeJson = await writeResp.json() as {
    totalUpdatedCells?: number;
    totalUpdatedRows?: number;
  };

  return new Response(
    JSON.stringify({
      ok: true,
      sheet_rows_scanned: scanned,
      already_populated: alreadyPopulated,
      no_order_id: noOrderId,
      no_supabase_match: noSupabaseMatch,
      updated: updates.length,
      cells_written: writeJson.totalUpdatedCells,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
