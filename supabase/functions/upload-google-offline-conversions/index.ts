// upload-google-offline-conversions
//
// Uploads offline conversions to Google via the Data Manager API, reading the
// SAME canonical record the Google Sheet path uses (v_offline_conversion_export)
// so the two paths upload IDENTICAL data — same Order ID, same click id, same
// coalesced email/phone/name, same value/time. This is the API half of a
// parallel-run migration off the Sheet.
//
// Routing by conversion type (each to its own Data Manager destination):
//   CallConvertOffline (monetized calls) -> GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE
//                                           (falls back to legacy GOOGLE_DATA_MANAGER_DESTINATION_ID)
//   CallXfer           (transfers)       -> GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER
//
// Selection:
//   status IN ('monetize_ready','ready_to_upload','transfer_ready')  -- CCO + CallXfer;
//     'ready_to_upload' is the pre-rename alias, still accepted during the deploy window.
//   AND conversion_time within ~85 days  -- ages out stale events so we never hit the
//     Data Manager "older than 90 days" error (the API analogue of the Sheet's archiver).
//   AND upload_attempts < MAX_ATTEMPTS.
//
// Order ID: uses the view's order_id (conversion_call_id -> calltools_call_id -> ...),
//   identical to the Sheet, so if both paths ever feed the same action Google
//   de-dupes them (transactionId is the Google order id).
//
// Auth: shared secret in x-invoke-secret.
// Params: ?validate_only=true (validateOnly to Google, no DB writes) | ?ids=... | ?limit=N

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

let DM_VALIDATE_ONLY = false;

// Row shape of v_offline_conversion_export (not in the generated DB types, so we
// type it explicitly rather than let supabase-js infer an error union).
interface ExportRow {
  event_id: string;
  order_id: string;
  event_type: string;
  status: string;
  upload_attempts: number | null;
  conversion_name: string | null;
  google_click_id: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_time_ts: string;
  conversion_value: number | string;
  conversion_currency: string;
  google_ads_customer_id: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  zip: string | null;
}

interface ConversionEvent {
  event_id: string;
  order_id: string;                 // == Sheet Order ID; sent as Google transactionId
  conversion_time: string;          // ISO / RFC3339
  conversion_value: number;
  currency_code: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  productDestinationId: string;     // routed per conversion type
  google_ads_customer_id: string | null;
  conversion_name: string | null;
  pii?: {
    email?: string | null;
    phone?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    zip?: string | null;
    country?: string | null;
  };
}

type UploadOutcome =
  | { kind: "success"; response: unknown }
  | { kind: "retryable"; error: unknown }
  | { kind: "permanent"; error: unknown };

interface UploadProvider {
  name: string;
  upload(event: ConversionEvent): Promise<UploadOutcome>;
}

function pickClickIdentifier(
  event: ConversionEvent,
): { kind: "gclid" | "gbraid" | "wbraid"; value: string } | null {
  if (event.gclid) return { kind: "gclid", value: event.gclid };
  if (event.gbraid) return { kind: "gbraid", value: event.gbraid };
  if (event.wbraid) return { kind: "wbraid", value: event.wbraid };
  return null;
}

// ---- OAuth ----------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google OAuth not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return cachedToken.token;
}

// ---- Hashing / identifiers ------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  return t.includes("@") ? t : null;
}
function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}
function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase();
  return t || null;
}
// Same userIdentifiers the Sheet's PII columns feed (email/phone hashed; name via
// hashed address block, which needs postalCode). IP is intentionally NOT sent —
// Data Manager offline events have no IP identifier and the Sheet's ip column is a
// no-op for offline matching, so omitting it keeps the two paths equivalent.
async function buildUserIdentifiers(pii: ConversionEvent["pii"]): Promise<Array<Record<string, unknown>>> {
  const ids: Array<Record<string, unknown>> = [];
  if (!pii) return ids;
  const email = normalizeEmail(pii.email);
  if (email) ids.push({ emailAddress: await sha256Hex(email) });
  const phone = normalizePhoneE164(pii.phone);
  if (phone) ids.push({ phoneNumber: await sha256Hex(phone) });
  const first = normalizeName(pii.first_name);
  const last = normalizeName(pii.last_name);
  const zip = pii.zip ? String(pii.zip).trim() : null;
  const country = (pii.country ? String(pii.country).trim() : "US").toUpperCase();
  if (first && last && zip) {
    ids.push({
      address: {
        givenName: await sha256Hex(first),
        familyName: await sha256Hex(last),
        postalCode: zip,
        regionCode: country,
      },
    });
  }
  return ids;
}

// ---- Providers ------------------------------------------------------------

const dryRunProvider: UploadProvider = {
  name: "dry_run",
  async upload(event: ConversionEvent): Promise<UploadOutcome> {
    const click = pickClickIdentifier(event);
    const intended = {
      provider: "dry_run", event_id: event.event_id,
      destination: event.productDestinationId,
      conversion_name: event.conversion_name,
      click_identifier: click, order_id: event.order_id,
      conversion_time: event.conversion_time, conversion_value: event.conversion_value,
      has_pii: Boolean(event.pii && (event.pii.email || event.pii.phone)),
    };
    console.log("[dry_run] would upload:", JSON.stringify(intended));
    return { kind: "success", response: { dry_run: true, intended } };
  },
};

const DATA_MANAGER_ENDPOINT =
  Deno.env.get("GOOGLE_DATA_MANAGER_ENDPOINT") ||
  "https://datamanager.googleapis.com/v1/events:ingest";

const dataManagerProvider: UploadProvider = {
  name: "data_manager",
  async upload(event: ConversionEvent): Promise<UploadOutcome> {
    const click = pickClickIdentifier(event);
    const userIdentifiers = await buildUserIdentifiers(event.pii);
    if (!click && userIdentifiers.length === 0) {
      return { kind: "permanent", error: { message: "No matchable identifiers (no click id, no hashed PII)" } };
    }
    const operatingAccountId = event.google_ads_customer_id || Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "";
    const loginAccountId = Deno.env.get("GOOGLE_LOGIN_CUSTOMER_ID") || "";
    const productDestinationId = event.productDestinationId || "";
    if (!operatingAccountId || !productDestinationId) {
      return { kind: "retryable", error: { message: "Data Manager not configured: customer id / destination id missing" } };
    }
    let accessToken: string;
    try { accessToken = await getGoogleAccessToken(); }
    catch (e) { return { kind: "retryable", error: { message: String(e) } }; }

    const destination: Record<string, unknown> = {
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: operatingAccountId },
      productDestinationId,
    };
    if (loginAccountId) destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: loginAccountId };

    const eventBody: Record<string, unknown> = {
      transactionId: event.order_id,            // aligned with the Sheet's Order ID
      eventTimestamp: event.conversion_time,
      eventSource: "WEB",
      currency: event.currency_code,
      conversionValue: event.conversion_value,
    };
    if (click) { const ad: Record<string, string> = {}; ad[click.kind] = click.value; eventBody.adIdentifiers = ad; }
    if (userIdentifiers.length > 0) eventBody.userData = { userIdentifiers };

    const body = { destinations: [destination], encoding: "HEX", events: [eventBody], validateOnly: DM_VALIDATE_ONLY };

    let res: Response;
    try {
      res = await fetch(DATA_MANAGER_ENDPOINT, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) { return { kind: "retryable", error: { message: `network: ${String(e)}` } }; }

    const respText = await res.text();
    let respJson: unknown; try { respJson = JSON.parse(respText); } catch { respJson = respText; }
    if (res.ok) return { kind: "success", response: respJson };
    if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retryable", error: { status: res.status, body: respJson } };
    return { kind: "permanent", error: { status: res.status, body: respJson } };
  },
};

function selectProvider(): UploadProvider {
  const enabled = (Deno.env.get("GOOGLE_UPLOAD_ENABLED") || "false").toLowerCase() === "true";
  if (!enabled) return dryRunProvider;
  const name = (Deno.env.get("GOOGLE_UPLOAD_PROVIDER") || "dry_run").toLowerCase();
  if (name === "data_manager") return dataManagerProvider;
  console.warn(`GOOGLE_UPLOAD_PROVIDER="${name}" not supported here; using dry_run`);
  return dryRunProvider;
}

// Destination id for a given conversion action name.
function destinationFor(conversionName: string | null): string {
  if ((conversionName || "").trim() === "CallXfer") {
    return Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER") || "";
  }
  // CallConvertOffline (monetized): new name, falling back to the legacy env.
  return Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE") ||
    Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID") || "";
}

const MAX_ATTEMPTS = 6;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const AGE_DAYS = 85;   // never attempt conversions older than this (Google 90-day window)
// Upload-eligible statuses: monetize_ready (CCO) + its pre-rename alias + transfer_ready (CallXfer).
const ELIGIBLE_STATUSES = ["monetize_ready", "ready_to_upload", "transfer_ready"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(MAX_LIMIT, Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT);
  const validateOnly = url.searchParams.get("validate_only") === "true";
  DM_VALIDATE_ONLY = validateOnly;

  // Read the canonical upload record from the shared view (same data as the Sheet).
  const SELECT =
    "event_id, order_id, event_type, status, upload_attempts, conversion_name, " +
    "google_click_id, gbraid, wbraid, conversion_time_ts, conversion_value, conversion_currency, " +
    "google_ads_customer_id, email, phone, first_name, last_name, zip";

  const cutoffIso = new Date(Date.now() - AGE_DAYS * 86400000).toISOString();
  let query = supabase.from("v_offline_conversion_export").select(SELECT)
    .in("status", ELIGIBLE_STATUSES)
    .gte("conversion_time_ts", cutoffIso)
    .lt("upload_attempts", MAX_ATTEMPTS)
    .order("conversion_time_ts", { ascending: true })
    .limit(limit);
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return new Response(JSON.stringify({ error: "ids param empty" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    query = supabase.from("v_offline_conversion_export").select(SELECT).in("event_id", ids);
  }

  const { data, error: selectErr } = await query;
  if (selectErr) {
    console.error("Select error:", selectErr);
    return new Response(JSON.stringify({ error: selectErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const rows = (data ?? []) as unknown as ExportRow[];

  const provider = selectProvider();
  const counters = { considered: rows.length, uploaded: 0, retryable: 0, permanent: 0, dry_run: 0, skipped_no_identifier: 0, skipped_no_destination: 0 };
  const validateResults: Array<{ event_id: string; conversion_name: string | null; destination: string; outcome: UploadOutcome }> = [];

  for (const row of rows) {
    const hasClick = Boolean(row.google_click_id || row.gbraid || row.wbraid);
    const pii = {
      email: row.email ?? null, phone: row.phone ?? null,
      first_name: row.first_name ?? null, last_name: row.last_name ?? null,
      zip: row.zip ?? null, country: "US",
    };
    const hasPii = Boolean(pii.email || pii.phone || (pii.first_name && pii.last_name && pii.zip));
    if (!hasClick && !hasPii) { counters.skipped_no_identifier++; continue; }

    const productDestinationId = destinationFor(row.conversion_name as string | null);
    if (!productDestinationId) { counters.skipped_no_destination++; continue; }

    const event: ConversionEvent = {
      event_id: row.event_id,
      order_id: row.order_id,
      conversion_time: row.conversion_time_ts,
      conversion_value: Number(row.conversion_value),
      currency_code: row.conversion_currency,
      gclid: row.google_click_id,
      gbraid: row.gbraid,
      wbraid: row.wbraid,
      productDestinationId,
      google_ads_customer_id: row.google_ads_customer_id,
      conversion_name: row.conversion_name,
      pii,
    };

    const nowIso = new Date().toISOString();
    const outcome = await provider.upload(event);

    if (validateOnly) {
      validateResults.push({ event_id: row.event_id, conversion_name: row.conversion_name, destination: productDestinationId, outcome });
      continue;
    }
    if (provider.name === "dry_run") {
      counters.dry_run++;
      await supabase.from("offline_conversion_events").update({
        upload_attempts: (row.upload_attempts ?? 0) + 1, last_upload_attempt_at: nowIso,
        google_upload_response: { dry_run: true, outcome },
      }).eq("id", row.event_id);
      await logAttempt(supabase, row.event_id, provider.name, outcome, true);
      continue;
    }
    if (outcome.kind === "success") {
      counters.uploaded++;
      await supabase.from("offline_conversion_events").update({
        status: "uploaded", uploaded_at: nowIso, last_upload_attempt_at: nowIso,
        upload_attempts: (row.upload_attempts ?? 0) + 1,
        google_upload_response: outcome.response as object, google_upload_error: null,
      }).eq("id", row.event_id);
      await logAttempt(supabase, row.event_id, provider.name, outcome, true);
    } else if (outcome.kind === "permanent") {
      counters.permanent++;
      await supabase.from("offline_conversion_events").update({
        status: "failed", last_upload_attempt_at: nowIso,
        upload_attempts: (row.upload_attempts ?? 0) + 1, google_upload_error: outcome.error as object,
      }).eq("id", row.event_id);
      await logAttempt(supabase, row.event_id, provider.name, outcome, false);
    } else {
      counters.retryable++;
      const nextAttempts = (row.upload_attempts ?? 0) + 1;
      // Leave status unchanged so it's retried next run; only fail at the cap.
      const update: Record<string, unknown> = {
        last_upload_attempt_at: nowIso, upload_attempts: nextAttempts, google_upload_error: outcome.error as object,
      };
      if (nextAttempts >= MAX_ATTEMPTS) update.status = "failed";
      await supabase.from("offline_conversion_events").update(update).eq("id", row.event_id);
      await logAttempt(supabase, row.event_id, provider.name, outcome, false);
    }
  }

  if (validateOnly) {
    return new Response(JSON.stringify({ ok: true, validate_only: true, provider: provider.name, considered: counters.considered, results: validateResults }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, provider: provider.name, ...counters }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});

async function logAttempt(
  supabase: ReturnType<typeof createClient>, eventId: string, providerName: string, outcome: unknown, success: boolean,
) {
  await supabase.from("api_logs").insert({
    api_type: "cv-upload",
    lead_id: null,
    transaction_id: `offline-conversion:${eventId}`,
    caller_id: "",
    request_payload: { source: "upload-google-offline-conversions", provider: providerName, event_id: eventId } as object,
    response_payload: outcome as object,
    http_status: success ? 200 : 0,
    success,
    error_message: success ? null : `provider=${providerName} outcome=${(outcome as { kind?: string })?.kind ?? "unknown"}`,
  });
}
