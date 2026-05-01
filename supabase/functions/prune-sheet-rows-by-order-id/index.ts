// prune-sheet-rows-by-order-id
//
// Surgical cleanup tool: takes a list of Order IDs (ringba_call_id values)
// and deletes the matching rows from the Google Sheet. Useful when bad data
// slips into the Sheet and needs to be removed before Google Ads ingests it
// (e.g. CallTools sending a UUID into Ringba's User:gclid tag, or any other
// upstream regression).
//
// What this does NOT do:
//   - Touch the underlying offline_conversion_events row in Supabase. Those
//     should be fixed separately (e.g. clear bogus gclid, reset
//     sheet_synced_at) before/alongside calling this.
//   - Affect rows that aren't in the input id list.
//
// Idempotent: re-running with the same id list after rows are gone returns
// `{ deleted: 0, not_found: [...all input ids...] }`.
//
// Auth: shared secret in `x-invoke-secret` header.
//
// Request body (JSON, POST):
//   { "order_ids": ["RGB...", "RGB...", ...], "dry_run"?: true }
//
// Response:
//   {
//     ok: true,
//     dry_run: false,
//     deleted: <count>,
//     not_found: [<order ids that weren't in the Sheet>],
//     deleted_rows: [{ order_id, sheet_row }, ...]
//   }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

// --- Service-account JWT auth (shared with sync-google-sheet) ---

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
    throw new Error(`Google token exchange returned no access_token`);
  }
  return tok.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST only" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: { order_ids?: string[]; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const inputIds = (body.order_ids || []).map((s) => String(s).trim()).filter(Boolean);
  if (inputIds.length === 0) {
    return new Response(
      JSON.stringify({ error: "Body must include non-empty 'order_ids' array" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const dryRun = body.dry_run === true;

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

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(sa, "https://www.googleapis.com/auth/spreadsheets");
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Auth failed: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 1. Look up the numeric sheetId for the tab name. deleteDimension uses
  //    the numeric id, not the human-readable tab name.
  const metaUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `?fields=sheets(properties(sheetId,title))`;
  const metaResp = await fetch(metaUrl, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!metaResp.ok) {
    const text = await metaResp.text();
    return new Response(
      JSON.stringify({ error: `Sheets metadata fetch failed: ${metaResp.status} ${text}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const meta = await metaResp.json() as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  if (!sheet || sheet.properties?.sheetId === undefined) {
    return new Response(
      JSON.stringify({ error: `Tab '${tabName}' not found in spreadsheet` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const numericSheetId = sheet.properties.sheetId;

  // 2. Read tab values (col A:H is enough — Order ID is column H, index 7).
  //    Reading from A2 so the array index lines up with row number = idx+2.
  const readRange = encodeURIComponent(`${tabName}!A2:H`);
  const readUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${readRange}`;
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

  // 3. Walk rows and find matches. Build a list of {orderId, rowNumber}.
  //    rowNumber is 1-based to keep the human-readable mental model.
  const inputSet = new Set(inputIds);
  const matches: Array<{ order_id: string; sheet_row: number }> = [];
  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    const orderId = String(row?.[7] || "").trim();
    if (orderId && inputSet.has(orderId)) {
      matches.push({ order_id: orderId, sheet_row: i + 2 });
    }
  }
  const matchedIds = new Set(matches.map((m) => m.order_id));
  const notFound = inputIds.filter((x) => !matchedIds.has(x));

  if (dryRun) {
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: true,
        would_delete: matches.length,
        not_found: notFound,
        rows_to_delete: matches,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (matches.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, deleted: 0, not_found: notFound, deleted_rows: [] }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 4. Build deleteDimension requests. CRITICAL: send in DESCENDING row
  //    order so each delete doesn't shift the indices of later requests.
  //    deleteDimension uses 0-based startIndex, exclusive endIndex.
  const sorted = [...matches].sort((a, b) => b.sheet_row - a.sheet_row);
  const requests = sorted.map((m) => ({
    deleteDimension: {
      range: {
        sheetId: numericSheetId,
        dimension: "ROWS",
        startIndex: m.sheet_row - 1,
        endIndex: m.sheet_row,
      },
    },
  }));

  const writeUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
  const writeResp = await fetch(writeUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!writeResp.ok) {
    const text = await writeResp.text();
    return new Response(
      JSON.stringify({ error: `Sheet batchUpdate failed: ${writeResp.status} ${text}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      deleted: matches.length,
      not_found: notFound,
      deleted_rows: matches,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
