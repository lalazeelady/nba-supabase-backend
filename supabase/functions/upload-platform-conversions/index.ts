// upload-platform-conversions (v2, 2026-09-25: Bing send)
//
// Sends queued postbacks (public.platform_uploads, status 'pending') to the ad platforms.
// Each run first calls queue_platform_uploads() so new postbacks join the queue.
//
// SAFE BY DEFAULT — nothing is stored in Google Ads or Microsoft Ads unless turned on.
// An offer uploads for real only when BOTH are true:
//   1. GOOGLE_POSTBACK_UPLOAD_MODE = live            (the master switch; default validate_only)
//   2. offer_rules.uploads_held is false for it      (a held offer never sends, even in live mode)
// Internet is held while the legacy pipeline still uploads the same calls: the legacy order id
// is date+phone and this one is caliber_call_id, so Google would count those calls twice.
// GOOGLE_POSTBACK_LIVE_OFFERS (optional) narrows live mode further to a comma list of offers;
// empty means "every offer that is not held".
//
// Bing (Microsoft Ads ApplyOfflineConversions, REST). Same shape of switches:
//   BING_UPLOAD_MODE = dry_run (default) | live      master switch
//   BING_LIVE_ACTIONS = monetize,transfer (default)  comma list of conversion_actions that send
//   bing_manual_uploads                              a monetize row whose msclkid was uploaded by
//                                                    hand is skipped (mark_bing_manual_uploads(),
//                                                    run before every Bing batch); transfers were
//                                                    never uploaded by hand and all send
//   offer_rules.uploads_held                         also holds Bing
// Auth is Google OAuth (Microsoft accepts it with the IdentityProvider: Google header):
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (shared with Google Ads) + BING_GOOGLE_REFRESH_TOKEN
// (its own token, scopes openid email profile), plus BING_DEVELOPER_TOKEN, BING_CUSTOMER_ID,
// BING_ACCOUNT_ID. ?action=bing_test checks the connection and lists the offline goals
// without sending anything. See docs/bing-offline-conversions/README.md.
//
// A validate_only or dry_run check sets validated_at + last_result and leaves status
// 'pending'. Only a live send changes status (sent / failed / skipped).
//
// Each row has a conversion_action: transfer -> CallXfer (value 0), monetize ->
// CallConvertOffline on Google / CallMonetize on Bing (postback revenue). For internet
// (offer_rules.transfers_from_monetize) one monetized postback produces both rows.
//
// Google event: transactionId = the upload key from v_platform_uploads_pending.order_id --
// calltools_call_id when Caliber sends it, else phone:offer:ET-date[:revenue]. It MUST match
// queue_platform_uploads() dedupe or Google rejects rows we meant to keep. Google dedupes per
// conversion action, so the transfer and the monetize upload of one call stay separate.
// eventTimestamp, currency USD, value, one click id (gclid > gbraid > wbraid), hashed
// email / phone, and the hashed name + zip address block when all three exist.
//
// Bing conversion: MicrosoftClickId, ConversionName, ConversionTime (UTC), value, USD.
// Hashed email / phone (enhanced conversions) only when BING_ENHANCED=true: the account must
// have accepted Microsoft's enhanced-conversion terms first. Without them a row with no
// msclkid cannot be sent and is skipped as 'no_msclkid' in live mode.
//
// Auth: x-invoke-secret (UPLOADER_INVOKE_SECRET).
// Params: ?platform=google|bing|all (default all) &limit=N (default 100, max 300)
//         &queue=false (skip the queue step)  &action=bing_test (connection check only)

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
const BING_CAMPAIGN_API = "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13";

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
  order_id: string;
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
  | { kind: "failed"; result: unknown }
  | { kind: "skipped"; reason: string; result: unknown };

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

// One access-token cache per refresh-token secret: GOOGLE_REFRESH_TOKEN (Google Ads) and
// BING_GOOGLE_REFRESH_TOKEN (Microsoft Ads). Both use the same Google OAuth client.
const cachedTokens: Record<string, { token: string; expiresAt: number }> = {};

async function googleAccessToken(refreshSecret = "GOOGLE_REFRESH_TOKEN"): Promise<string> {
  const now = Date.now();
  const cached = cachedTokens[refreshSecret];
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get(refreshSecret);
  if (!clientId || !clientSecret || !refreshToken) throw new Error(`Google OAuth secrets missing (${refreshSecret})`);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Google OAuth refresh failed (${refreshSecret}): ${res.status} ${await res.text()}`);
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedTokens[refreshSecret] = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
  return body.access_token;
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
    transactionId: row.order_id,
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
    sent: { transactionId: row.order_id, destination: row.conversion_action, click_id: click ? Object.keys(click)[0] : null, identifiers: userIdentifiers.map((u) => Object.keys(u)[0]) },
  };
  if (!live) return { kind: "checked", result: { ...result, ok: res.ok } };
  if (res.ok) return { kind: "sent", result };
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", result };
  return { kind: "failed", result };
}

// ---- Bing (Microsoft Ads offline conversions) ------------------------------------------

async function bingHeaders(): Promise<Record<string, string>> {
  const developerToken = Deno.env.get("BING_DEVELOPER_TOKEN") || "";
  const customerId = Deno.env.get("BING_CUSTOMER_ID") || "";
  const accountId = Deno.env.get("BING_ACCOUNT_ID") || "";
  if (!developerToken || !customerId || !accountId) throw new Error("BING_DEVELOPER_TOKEN, BING_CUSTOMER_ID or BING_ACCOUNT_ID not configured");
  const token = await googleAccessToken("BING_GOOGLE_REFRESH_TOKEN");
  return {
    "Authorization": `Bearer ${token}`,
    "IdentityProvider": "Google",
    "DeveloperToken": developerToken,
    "CustomerId": customerId,
    "CustomerAccountId": accountId,
    "Content-Type": "application/json",
  };
}

async function sendBing(row: PendingRow, live: boolean): Promise<Outcome> {
  const enhanced = (Deno.env.get("BING_ENHANCED") || "").toLowerCase() === "true";
  const email = enhanced ? cleanEmail(row.email) : null;
  const phone = enhanced ? phoneE164(row.phone) : null;
  const conversion: Record<string, unknown> = {
    ConversionName: row.conversion_action === "transfer"
      ? Deno.env.get("BING_CONVERSION_NAME_TRANSFER") || "CallXfer"
      : Deno.env.get("BING_CONVERSION_NAME_MONETIZE") || "CallMonetize",
    // Whole seconds, UTC. Microsoft treats (click id, goal, time) as one conversion.
    ConversionTime: new Date(row.conversion_time).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ConversionValue: row.conversion_action === "transfer" ? 0 : Number(row.conversion_value),
    ConversionCurrencyCode: CURRENCY,
  };
  if (row.msclkid) conversion.MicrosoftClickId = row.msclkid;
  if (email) conversion.HashedEmailAddress = await sha256Hex(email);
  if (phone) conversion.HashedPhoneNumber = await sha256Hex(phone);
  const ok = Boolean(row.msclkid || email || phone);

  const mode = live ? "live" : "dry_run";
  if (!live) return { kind: "checked", result: { mode, ok, conversion } };
  if (!ok) return { kind: "skipped", reason: "no_msclkid", result: { mode, conversion } };

  let headers: Record<string, string>;
  try { headers = await bingHeaders(); } catch (e) { return { kind: "retry", result: { mode, error: String(e) } }; }
  let res: Response;
  try {
    res = await fetch(`${BING_CAMPAIGN_API}/OfflineConversions/Apply`, {
      method: "POST", headers, body: JSON.stringify({ OfflineConversions: [conversion] }),
    });
  } catch (e) {
    return { kind: "retry", result: { mode, error: `network: ${String(e)}` } };
  }
  const text = await res.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
  const result = { mode, http_status: res.status, tracking_id: res.headers.get("TrackingId"), response: body, sent: conversion };
  // 200 with PartialErrors empty = applied. A partial error is about this one conversion
  // (bad click id, unknown goal, too old): retrying will not help.
  const partialErrors = (body as { PartialErrors?: unknown[] } | null)?.PartialErrors ?? [];
  if (res.ok && partialErrors.length === 0) return { kind: "sent", result };
  if (res.ok) return { kind: "failed", result };
  // Auth / config / throttling / server: the row is fine, try again next run.
  if (res.status === 401 || res.status === 403 || res.status === 408 || res.status === 429 || res.status >= 500) return { kind: "retry", result };
  return { kind: "failed", result };
}

// Connection check: token refresh + list the account's offline conversion goals. Sends nothing.
async function bingTest(): Promise<Record<string, unknown>> {
  let headers: Record<string, string>;
  try { headers = await bingHeaders(); } catch (e) { return { ok: false, step: "auth", error: String(e) }; }
  const res = await fetch(`${BING_CAMPAIGN_API}/ConversionGoals/QueryByIds`, {
    method: "POST", headers,
    body: JSON.stringify({ ConversionGoalIds: null, ConversionGoalTypes: "OfflineConversion", ReturnAdditionalFields: null }),
  });
  const text = await res.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
  const goals = ((body as { ConversionGoals?: { Id: number; Name: string; Status: string }[] } | null)?.ConversionGoals ?? [])
    .filter(Boolean).map((g) => ({ id: g.Id, name: g.Name, status: g.Status }));
  const wanted = [
    Deno.env.get("BING_CONVERSION_NAME_MONETIZE") || "CallMonetize",
    Deno.env.get("BING_CONVERSION_NAME_TRANSFER") || "CallXfer",
  ];
  return {
    ok: res.ok, step: "query_goals", http_status: res.status, tracking_id: res.headers.get("TrackingId"),
    offline_goals: goals,
    goal_found: Object.fromEntries(wanted.map((n) => [n, goals.some((g) => g.name === n)])),
    ...(res.ok ? {} : { response: body }),
  };
}

// ---- Handler ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  if (!expected || req.headers.get("x-invoke-secret") !== expected) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  if (url.searchParams.get("action") === "bing_test") return json(await bingTest(), 200);
  const platformParam = (url.searchParams.get("platform") || "all").toLowerCase();
  const platforms = platformParam === "all" ? ["google", "bing"] : [platformParam];
  if (!platforms.every((p) => p === "google" || p === "bing")) return json({ error: "platform must be google, bing or all" }, 400);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 300);
  const doQueue = url.searchParams.get("queue") !== "false";

  const googleMode = (Deno.env.get("GOOGLE_POSTBACK_UPLOAD_MODE") || "validate_only").toLowerCase();
  const liveOffers = new Set((Deno.env.get("GOOGLE_POSTBACK_LIVE_OFFERS") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const bingMode = (Deno.env.get("BING_UPLOAD_MODE") || "dry_run").toLowerCase();
  const bingLiveActions = (Deno.env.get("BING_LIVE_ACTIONS") || "monetize,transfer")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // Offers held back from real uploads (a cutover in progress). Read every run, so releasing
  // an offer is one row in offer_rules with no redeploy.
  const heldOffers = new Set<string>();
  {
    const { data, error } = await supabase.from("offer_rules").select("offer").eq("uploads_held", true);
    if (error) return json({ ok: false, error: `read offer_rules failed: ${error.message}` }, 500);
    for (const row of (data ?? []) as { offer: string }[]) heldOffers.add(row.offer.toLowerCase());
  }

  let queued: number | null = null;
  if (doQueue) {
    const { data, error } = await supabase.rpc("queue_platform_uploads");
    if (error) return json({ ok: false, error: `queue_platform_uploads failed: ${error.message}` }, 500);
    queued = Number(data ?? 0);
  }

  // Bing monetize rows whose msclkid was uploaded by hand never send (owner rule, 2026-09-25).
  let bingManualSkipped: number | null = null;
  if (platforms.includes("bing")) {
    const { data, error } = await supabase.rpc("mark_bing_manual_uploads");
    if (error) return json({ ok: false, error: `mark_bing_manual_uploads failed: ${error.message}`, queued }, 500);
    bingManualSkipped = Number(data ?? 0);
  }

  const summary: Record<string, Record<string, number>> = {};
  for (const platform of platforms) {
    summary[platform] = { rows: 0, checked_ok: 0, checked_error: 0, sent: 0, retry: 0, failed: 0, skipped: 0 };
    // Oldest first. In check mode a row checked in the last hour is skipped, so repeated runs
    // move through the queue instead of re-checking the same rows. In live mode there is no
    // such wait: a pending row must be sent on the next run, not up to an hour later.
    // Bing live reads only the actions that send, so rows that stay dry_run (transfers) do
    // not fill the batch ahead of rows that should go out.
    const liveMode = platform === "google" ? googleMode === "live" : bingMode === "live";
    const recheckAfter = new Date(Date.now() - 3600_000).toISOString();
    let query = supabase
      .from("v_platform_uploads_pending")
      .select("*")
      .eq("platform", platform);
    if (!liveMode) query = query.or(`validated_at.is.null,validated_at.lt."${recheckAfter}"`);
    if (liveMode && platform === "bing") query = query.in("conversion_action", bingLiveActions);
    const { data, error } = await query
      .order("conversion_time", { ascending: true })
      .limit(limit);
    if (error) return json({ ok: false, error: `read queue failed: ${error.message}`, queued }, 500);

    for (const row of (data ?? []) as PendingRow[]) {
      summary[platform].rows++;
      const offerKey = (row.offer || "").toLowerCase();
      const live = platform === "google"
        ? googleMode === "live" && !heldOffers.has(offerKey) && (liveOffers.size === 0 || liveOffers.has(offerKey))
        : bingMode === "live" && !heldOffers.has(offerKey) && bingLiveActions.includes(row.conversion_action);
      const first = platform === "google" ? await sendGoogle(row, live) : await sendBing(row, live);
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
      } else if (outcome.kind === "skipped") {
        summary[platform].skipped++;
        update = { status: "skipped", skip_reason: outcome.reason, last_attempt_at: now, last_result: outcome.result };
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

  const report = {
    ok: true, queued, google_mode: googleMode,
    google_live_offers: liveOffers.size === 0 ? "every offer that is not held" : [...liveOffers],
    bing_mode: bingMode, bing_live_actions: bingLiveActions, bing_manual_skipped: bingManualSkipped,
    held_offers: [...heldOffers], summary,
  };
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
