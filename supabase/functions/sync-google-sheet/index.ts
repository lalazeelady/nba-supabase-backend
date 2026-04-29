// sync-google-sheet
//
// Pushes NBA-publisher revenue conversion events into a Google Sheet that
// Google Ads picks up via scheduled offline-conversion + ECL upload.
//
// Reads the same v_google_sheet_export_unsynced view as export-google-sheet-csv
// (column order matches the user's template), authenticates to the Google
// Sheets API as a service account, appends new rows below the existing
// header, then stamps sheet_synced_at on the emitted rows so they don't
// re-emit.
//
// Auth (inbound): shared secret in `x-invoke-secret` header.
//
// Required Supabase Edge Function secrets:
//   GOOGLE_SHEETS_SA_JSON        — full service-account JSON key file contents
//   GOOGLE_SHEETS_SPREADSHEET_ID — the long ID between /d/ and /edit in the URL
//   GOOGLE_SHEETS_TAB_NAME       — the worksheet/tab name (e.g. "LiveImport")
//   UPLOADER_INVOKE_SECRET       — same secret used by export-google-sheet-csv
//
// Query params:
//   ?dry_run=true — fetch rows + auth but skip the Sheets append and the
//                   sheet_synced_at stamp. Useful for first run.
//   ?limit=N      — cap emitted rows (default unlimited, max 5000).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

interface ExportRow {
  event_id: string;
  google_click_id: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_name: string | null;
  conversion_time: string | null;
  conversion_value: number | string | null;
  conversion_currency: string | null;
  order_id: string | null;
}

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function rowToValues(r: ExportRow): (string | number)[] {
  // 8 columns matching v_google_sheet_export_unsynced + the LiveImport tab
  // header. Click-conversion-only — no PII columns. ECL pipeline is separate.
  return [
    r.google_click_id ?? "",
    r.gbraid ?? "",
    r.wbraid ?? "",
    r.conversion_name ?? "",
    r.conversion_time ?? "",
    r.conversion_value ?? "",
    r.conversion_currency ?? "",
    r.order_id ?? "",
  ];
}

// --- Service-account JWT auth (RS256, no external libs) ---

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

async function appendToSheet(args: {
  accessToken: string;
  spreadsheetId: string;
  tabName: string;
  values: (string | number)[][];
}): Promise<{ updates: { updatedRows?: number; updatedRange?: string } }> {
  // Range = just the tab name → Sheets finds the next empty row.
  // valueInputOption=USER_ENTERED so '+19...' phones aren't reformatted to numbers.
  // insertDataOption=INSERT_ROWS so existing rows below aren't overwritten.
  const range = encodeURIComponent(args.tabName);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}` +
    `/values/${range}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range: args.tabName,
      majorDimension: "ROWS",
      values: args.values,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sheets append failed: ${resp.status} ${text}`);
  }
  return await resp.json();
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
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 5000)
    : null;

  const spreadsheetId = Deno.env.get("GOOGLE_SHEETS_SPREADSHEET_ID") || "";
  const tabName = Deno.env.get("GOOGLE_SHEETS_TAB_NAME") || "";
  const saRaw = Deno.env.get("GOOGLE_SHEETS_SA_JSON") || "";
  if (!spreadsheetId || !tabName || !saRaw) {
    return new Response(
      JSON.stringify({
        error: "Missing required env vars",
        missing: {
          GOOGLE_SHEETS_SPREADSHEET_ID: !spreadsheetId,
          GOOGLE_SHEETS_TAB_NAME: !tabName,
          GOOGLE_SHEETS_SA_JSON: !saRaw,
        },
      }),
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

  let query = supabase
    .from("v_google_sheet_export_unsynced")
    .select(
      "event_id, google_click_id, gbraid, wbraid, " +
      "conversion_name, conversion_time, conversion_value, conversion_currency, order_id",
    );
  if (limit !== null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("sync-google-sheet view read error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const rows = (data ?? []) as ExportRow[];
  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, appended: 0, marked_synced: 0, dry_run: dryRun, message: "no unsynced rows" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const values = rows.map(rowToValues);

  if (dryRun) {
    // Verify auth still works (so a "live" follow-up can't fail on creds).
    let authOk = false;
    let authError: string | null = null;
    try {
      await getGoogleAccessToken(sa, "https://www.googleapis.com/auth/spreadsheets");
      authOk = true;
    } catch (e) {
      authError = (e as Error).message;
    }
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: true,
        would_append: rows.length,
        sample_first_row: values[0],
        spreadsheet_id: spreadsheetId,
        tab: tabName,
        auth_ok: authOk,
        auth_error: authError,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(sa, "https://www.googleapis.com/auth/spreadsheets");
  } catch (e) {
    console.error("sync-google-sheet auth error:", e);
    return new Response(
      JSON.stringify({ error: `Auth failed: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let appendResult: { updates: { updatedRows?: number; updatedRange?: string } };
  try {
    appendResult = await appendToSheet({
      accessToken,
      spreadsheetId,
      tabName,
      values,
    });
  } catch (e) {
    console.error("sync-google-sheet append error:", e);
    return new Response(
      JSON.stringify({ error: `Sheets append failed: ${(e as Error).message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Append succeeded — stamp sheet_synced_at so we don't re-emit these rows.
  // Done in chunks to stay under PostgREST's IN-list size cap.
  let markedCount = 0;
  const ids = rows.map((r) => r.event_id);
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error: updErr, count } = await supabase
      .from("offline_conversion_events")
      .update({ sheet_synced_at: new Date().toISOString() }, { count: "exact" })
      .in("id", slice);
    if (updErr) {
      // The Sheet append already happened — return partial success so the
      // caller knows there are now duplicates risk on the next run.
      console.error("sync-google-sheet stamp error:", updErr);
      return new Response(
        JSON.stringify({
          ok: false,
          appended: rows.length,
          marked_synced: markedCount,
          updated_range: appendResult.updates?.updatedRange,
          error: `Appended to Sheet but failed to mark synced: ${updErr.message}. Re-running this function will duplicate rows in the Sheet — investigate before retrying.`,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    markedCount += count ?? slice.length;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      appended: rows.length,
      marked_synced: markedCount,
      updated_range: appendResult.updates?.updatedRange,
      updated_rows: appendResult.updates?.updatedRows,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
