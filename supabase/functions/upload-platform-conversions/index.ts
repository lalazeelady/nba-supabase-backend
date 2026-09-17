// upload-platform-conversions (v1, 2026-09-17)
//
// Sends queued postbacks (public.platform_uploads, status 'pending') to the ad platforms.
// Each run first calls queue_platform_uploads() so new postbacks join the queue.
//
// SAFE BY DEFAULT — nothing is stored in Google Ads or Microsoft Ads unless turned on:
//   Google  GOOGLE_POSTBACK_UPLOAD_MODE = validate_only (default) | live
//           GOOGLE_POSTBACK_LIVE_OFFERS = comma list of offers allowed to send live,
//           e.g. "ene,aca". Empty by default. An offer that the legacy pipeline still
//           uploads (internet today) must NOT be listed, or Google counts it twice: the
//           legacy order id is date+phone, this one is caliber_call_id.
//   Bing    dry_run only: builds the Microsoft Ads offline conversion and stores it in
//           last_result. Sending is not built yet (needs Microsoft Ads API access).
//
// A validate_only or dry_run check sets validated_at + last_result and leaves status
// 'pending'. Only a live send changes status (sent / failed).
//
// Each row has a conversion_action: transfer -> CallXfer (value 0), monetize ->
// CallConvertOffline (postback revenue). For internet (offer_rules.transfers_from_monetize)
// one monetized postback produces both rows.
//
// Google event: transactionId = caliber_call_id (Google dedupes per conversion action, so
// the transfer and the monetize upload of one call are separate conversions),
// eventTimestamp, currency USD, value, one click id (gclid > gbraid > wbraid), hashed
// email / phone, and the hashed name + zip address block when all three exist.
//
// Auth: x-invoke-secret (UPLOADER_INVOKE_SECRET).
// Params: ?platform=google|bing|all (default all) &limit=N (default 100, max 300)
//         &queue=false (skip the queue step)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, x-invoke-secret",
};

const CURRENCY = "USD";
const MAX_ATTEMPTS = 6;
const DATA_MANAGER_ENDPOINT = "https://datamanager.googleapis.com/v1/events:ingest";

interface PendingRow {
  upload_id: number;
  platform: "google" | "bing";
  conversion_action: "transfer" | "monetize";
  attempts: number;
  validated_at: string | null;
  postback_id: string;
  event_type: "transfer" | "monetize";
  offer: string | null;
  caliber_call_id: string;
  conversion_time: string;
  conversion_value: number | string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  msclkid: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  zip: string | null;
}

type Outcome =
  | { kind: "checked"; result: unknown }            // validate_only / dry_run: status unchanged
  | { kind: "sent"; result: unknown }
  | { kind: "retry"; result: unknown }
  | { kind: "failed"; result: unknown };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function sha256Hex(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanEmail(s: string | null): string | null {
  const t = (s || "").trim().toLowerCase();
  return t.includes("@") ? t : null;
}

function phoneE164(s: string | null): string | null {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

// ---- Google (Data Manager API) ---------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function googleAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google OAuth secrets missing");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Google OAuth refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
  return cachedToken.token;
}

async function sendGoogle(row: PendingRow, live: boolean): Promise<Outcome> {
  const destinationId = row.conversion_action === "transfer"
    ? Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER") || ""
    : Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE") || Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID") || "";
  const accountId = Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "";
  const loginAccountId = Deno.env.get("GOOGLE_LOGIN_CUSTOMER_ID") || "";
  if (!destinationId || !accountId) return { kind: "retry", result: { error: "Google destination or customer id not configured" } };

  const userIdentifiers: Record<string, unknown>[] = [];
  const email = cleanEmail(row.email);
  if (email) userIdentifiers.push({ emailAddress: await sha256Hex(email) });
  const phone = phoneE164(row.phone);
  if (phone) userIdentifiers.push({ phoneNumber: await sha256Hex(phone) });
  const first = (row.first_name || "").trim().toLowerCase();
  const last = (row.last_name || "").trim().toLowerCase();
  const zip = (row.zip || "").trim();
  if (first && last && zip) {
    userIdentifiers.push({ address: { givenName: await sha256Hex(first), familyName: await sha256Hex(last), postalCode: zip, regionCode: "US" } });
  }
  const click = row.gclid ? { gclid: row.gclid } : row.gbraid ? { gbraid: row.gbraid } : row.wbraid ? { wbraid: row.wbraid } : null;
  if (!click && userIdentifiers.length === 0) return { kind: "failed", result: { error: "no click id and no hashed identifiers" } };

  const destination: Record<string, unknown> = {
    operatingAccount: { accountType: "GOOGLE_ADS", accountId },
    productDestinationId: destinationId,
  };
  if (loginAccountId) destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: loginAccountId };

  const eventBody: Record<string, unknown> = {
    transactionId: row.caliber_call_id,
    eventTimestamp: new Date(row.conversion_time).toISOString(),
    eventSource: "WEB",
    currency: CURRENCY,
    conversionValue: row.conversion_action === "transfer" ? 0 : Number(row.conversion_value),
  };
  if (click) eventBody.adIdentifiers = click;
  if (userIdentifiers.length > 0) eventBody.userData = { userIdentifiers };

  let token: string;
  try { token = await googleAccessToken(); } catch (e) { return { kind: "retry", result: { error: String(e) } }; }

  const mode = live ? "live" : "validate_only";
  let res: Response;
  try {
    res = await fetch(DATA_MANAGER_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ destinations: [destination], encoding: "HEX", events: [eventBody], validateOnly: !live }),
    });
  } catch (e) {
    return { kind: "retry", result: { mode, error: `network: ${String(e)}` } };
  }
  const text = await res.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
  const result = {
    mode, http_status: res.status, response: body,
    sent: { transactionId: row.caliber_call_id, destination: row.conversion_action, click_id: click ? Object.keys(click)[0] : null, identifiers: userIdentifiers.map((u) => Object.keys(u)[0]) },
  };
  if (!live) return { kind: "checked", result: { ...result, ok: res.ok } };
  if (res.ok) return { kind: "sent", result };
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", result };
  return { kind: "failed", result };
}

// ---- Bing (Microsoft Ads offline conversions) — dry run only --------------------------

async function dryRunBing(row: PendingRow): Promise<Outcome> {
  const email = cleanEmail(row.email);
  const phone = phoneE164(row.phone);
  const conversion = {
    MicrosoftClickId: row.msclkid || null,
    ConversionName: row.conversion_action === "transfer"
      ? Deno.env.get("BING_CONVERSION_NAME_TRANSFER") || "CallXfer"
      : Deno.env.get("BING_CONVERSION_NAME_MONETIZE") || "CallConvertOffline",
    ConversionTime: new Date(row.conversion_time).toISOString(),
    ConversionValue: row.conversion_action === "transfer" ? 0 : Number(row.conversion_value),
    ConversionCurrencyCode: CURRENCY,
    HashedEmailAddress: email ? await sha256Hex(email) : null,
    HashedPhoneNumber: phone ? await sha256Hex(phone) : null,
  };
  const ok = Boolean(conversion.MicrosoftClickId || conversion.HashedEmailAddress || conversion.HashedPhoneNumber);
  return { kind: "checked", result: { mode: "dry_run", ok, conversion } };
}

// ---- Handler ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  if (!expected || req.headers.get("x-invoke-secret") !== expected) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const platformParam = (url.searchParams.get("platform") || "all").toLowerCase();
  const platforms = platformParam === "all" ? ["google", "bing"] : [platformParam];
  if (!platforms.every((p) => p === "google" || p === "bing")) return json({ error: "platform must be google, bing or all" }, 400);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 300);
  const doQueue = url.searchParams.get("queue") !== "false";

  const googleMode = (Deno.env.get("GOOGLE_POSTBACK_UPLOAD_MODE") || "validate_only").toLowerCase();
  const liveOffers = new Set((Deno.env.get("GOOGLE_POSTBACK_LIVE_OFFERS") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  let queued: number | null = null;
  if (doQueue) {
    const { data, error } = await supabase.rpc("queue_platform_uploads");
    if (error) return json({ ok: false, error: `queue_platform_uploads failed: ${error.message}` }, 500);
    queued = Number(data ?? 0);
  }

  const summary: Record<string, Record<string, number>> = {};
  for (const platform of platforms) {
    summary[platform] = { rows: 0, checked_ok: 0, checked_error: 0, sent: 0, retry: 0, failed: 0 };
    // Oldest first. A row checked (validate_only / dry_run) in the last hour is skipped, so
    // repeated runs move through the queue instead of re-checking the same rows.
    const recheckAfter = new Date(Date.now() - 3600_000).toISOString();
    const { data, error } = await supabase
      .from("v_platform_uploads_pending")
      .select("*")
      .eq("platform", platform)
      .or(`validated_at.is.null,validated_at.lt."${recheckAfter}"`)
      .order("conversion_time", { ascending: true })
      .limit(limit);
    if (error) return json({ ok: false, error: `read queue failed: ${error.message}`, queued }, 500);

    for (const row of (data ?? []) as PendingRow[]) {
      summary[platform].rows++;
      const live = platform === "google" && googleMode === "live" && liveOffers.has((row.offer || "").toLowerCase());
      const first = platform === "google" ? await sendGoogle(row, live) : await dryRunBing(row);
      // Not live: nothing was sent, so an error is a failed check, never an attempt or a failure.
      const outcome: Outcome = !live && first.kind !== "checked"
        ? { kind: "checked", result: { ...(first.result as Record<string, unknown>), mode: platform === "google" ? "validate_only" : "dry_run", ok: false } }
        : first;
      const now = new Date().toISOString();

      let update: Record<string, unknown>;
      if (outcome.kind === "checked") {
        const ok = Boolean((outcome.result as { ok?: boolean }).ok);
        summary[platform][ok ? "checked_ok" : "checked_error"]++;
        update = { validated_at: now, last_result: outcome.result };
      } else if (outcome.kind === "sent") {
        summary[platform].sent++;
        update = { status: "sent", sent_at: now, attempts: row.attempts + 1, last_attempt_at: now, last_result: outcome.result };
      } else if (outcome.kind === "retry") {
        summary[platform].retry++;
        const attempts = row.attempts + 1;
        update = { attempts, last_attempt_at: now, last_result: outcome.result, ...(attempts >= MAX_ATTEMPTS ? { status: "failed" } : {}) };
      } else {
        summary[platform].failed++;
        update = { status: "failed", attempts: row.attempts + 1, last_attempt_at: now, last_result: outcome.result };
      }
      const { error: updErr } = await supabase.from("platform_uploads").update(update).eq("id", row.upload_id);
      if (updErr) console.error(`platform_uploads update failed for ${row.upload_id}:`, updErr.message);
    }
  }

  const report = { ok: true, queued, google_mode: googleMode, google_live_offers: [...liveOffers], summary };
  await supabase.from("api_logs").insert({
    api_type: "platform-upload-run",
    transaction_id: `platform-upload-run:${new Date().toISOString()}`,
    caller_id: "",
    request_payload: { platforms, limit, queue: doQueue } as object,
    response_payload: report as object,
    http_status: 200,
    success: Object.values(summary).every((s) => s.failed === 0 && s.checked_error === 0),
    error_message: null,
  });
  return json(report, 200);
});
