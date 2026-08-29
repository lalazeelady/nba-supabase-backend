// ringba-conversion-webhook
//
// Receives offline-conversion postbacks from Ringba (a monetized/converted
// call event), normalizes the payload, and stores it in
// public.offline_conversion_events for later upload to Google Ads.
//
// This function deliberately does NOT call Google synchronously. The
// uploader (upload-google-offline-conversions) handles that on a schedule
// so a slow/flaky Google API call cannot block Ringba's postback retry
// behavior.
//
// Auth: shared secret in either the `x-webhook-secret` header or `?secret=`
// query string, compared against the RINGBA_WEBHOOK_SECRET edge function
// secret. Always returns 200 once the secret has been accepted, so Ringba
// will not retry events we already stored.
//
// Payload shape: Ringba's URL-token templating is configured per-buyer in
// their UI, so the exact field names that arrive here vary. The parser
// below is intentionally defensive — it accepts JSON, form-encoded, or
// query-string payloads, and tries multiple key variants for each
// logical field. Once we confirm the production shape, the variant lists
// can be trimmed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Inline corsHeaders (matches the deployed function; not imported from
// ../_shared so the function deploys as a single self-contained file).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

// Default source; overridden to 'caliber' per-request when the Caliber-only `status`
// field is present (see the is_caliber check in the handler).
const DEFAULT_SOURCE = "ringba";
const EVENT_TYPE = "call_converted_revenue";

// Field-name variants we accept. First non-empty value wins. `conversion_call_id` holds the
// call id of the CONVERTED call: Ringba (RGB…), Caliber (`call_id`), or CallTools interim id.
const FIELD_VARIANTS = {
  conversion_call_id: [
    "conversion_call_id",
    "ringba_call_id", "call_id", "callId", "callid",
    "inboundCallId", "inbound_call_id", "uuid",
  ],
  calltools_call_id: [
    "calltools_call_id", "ct_call_id", "source_call_id",
  ],
  caller_id: [
    "caller_id", "callerId", "callerid", "caller",
    "from_number", "fromNumber", "ani",
  ],
  gclid: [
    "gclid", "gclID", "gcl_id", "google_click_id", "googleClickId",
  ],
  gbraid: [
    "gbraid", "gbraID", "gbraid_id",
  ],
  wbraid: [
    "wbraid", "wbraID", "wbraid_id",
  ],
  transaction_id: [
    "transaction_id", "transactionId", "lead_transaction_id",
    "txn_id", "txnId",
  ],
  lead_id: [
    "lead_id", "leadId", "leadid", "supabase_lead_id", "nba_lead_id",
  ],
  conversion_value: [
    "conversion_value", "conversionValue", "revenue", "payout",
    "value", "amount", "buyer_payout", "buyerPayout",
  ],
  conversion_time: [
    "conversion_time", "conversionTime", "converted_at", "convertedAt",
    "call_end_time", "callEndTime", "end_time", "endTime",
    "timestamp", "ts",
  ],
  currency_code: [
    "currency_code", "currencyCode", "currency",
  ],
  // Enhanced Conversions for Leads PII: forwarded by Ringba from CallTools
  // tags when available (e.g. lead originated from a completed form). For
  // direct callers Ringba may only have caller_id; we still upload with
  // hashed phone as the lone userIdentifier.
  caller_email: [
    "email", "callerEmail", "caller_email", "user_email", "userEmail",
  ],
  caller_first_name: [
    "first_name", "firstName", "fname", "first",
  ],
  caller_last_name: [
    "last_name", "lastName", "lname", "last",
  ],
  caller_zip: [
    "zip", "zip_code", "zipCode", "postal_code", "postalCode",
  ],
  caller_state: [
    "state", "region", "regionCode", "region_code",
  ],
  publisher: [
    "pub", "Pub",
    "publisher", "Publisher", "publisher_name", "publisherName",
    "tag:Publisher:Name", "tag:Publisher:name",
  ],
  // UTM parameters, if CallTools/Ringba forwards them on the transfer. Stored
  // for attribution/reporting completeness; not used for the Google upload
  // (that attributes on click IDs). Missing values are backfilled from the
  // matched lead below.
  utm_source: ["utm_source", "utmSource", "utm_src"],
  utm_medium: ["utm_medium", "utmMedium", "utm_med"],
  utm_campaign: ["utm_campaign", "utmCampaign", "utm_camp"],
  utm_content: ["utm_content", "utmContent"],
  utm_term: ["utm_term", "utmTerm"],
  // Caliber (and where present, other pixels) — stored for attribution/reporting.
  ib_source: ["ib_source", "inbound_route", "inbound_route][name]", "inboundRoute", "ibSource"],
  oppref: ["oppref_id", "oppref", "opprefId"],
  msclkid: ["msclkid", "msclkId"],
  fbclid: ["fbclid", "fbclId"],
  agent_name: ["agent_name", "agentName", "agent"],
  queue: ["queue", "queue_name", "queueName", "queue_id", "queueId", "queueid"],
  call_type: ["call_type", "callType"],
  // Caliber call status (connected / no connect / ...). Its PRESENCE marks a Caliber fire.
  call_status: ["status", "Status", "call_status", "callStatus"],
} as const;

function pick(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return null;
}

function parseNumber(s: string | null): number | null {
  if (s === null) return null;
  // Strip currency symbols, commas, whitespace.
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(s: string | null): Date | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;

  // Pure-numeric → epoch seconds or ms.
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    const d = new Date(t.length <= 10 ? n * 1000 : n);
    return isNaN(d.getTime()) ? null : d;
  }

  // Interpret explicitly as UTC (runtime-independent). Our senders (Ringba,
  // CallTools) report call times in UTC but often as timezone-less strings, so
  // we must not depend on the runtime's local zone.
  //
  // ISO-ish: normalize a space date/time separator, a space-delimited offset
  // (CallTools sends "... 00:00"), and a colon-less "+0000"; assume UTC if no
  // offset is present.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(t)) {
    let iso = t.replace(" ", "T")
      .replace(/T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d{2}):?(\d{2})$/, "T$1+$2:$3")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(iso)) iso += "Z";
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d;
  }

  // US "M/D/YYYY H:MM:SS [AM/PM]" (Ringba CallDateTime) → build in UTC.
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AaPp][Mm]))?$/);
  if (us) {
    let hour = Number(us[4]);
    if (us[7]) {
      const pm = /[Pp]/.test(us[7]);
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    const d = new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), hour, Number(us[5]), Number(us[6])));
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback (best effort).
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

async function parseRequestBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try { return await req.json(); } catch { return {}; }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  // Last-ditch: try JSON, then treat as form.
  const text = await req.text();
  try { return JSON.parse(text); } catch {
    try { return Object.fromEntries(new URLSearchParams(text)); } catch { return {}; }
  }
}

// Last 10 digits of a phone, or null if fewer than 10 are present.
function phoneLast10(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Eastern-Time calendar date (YYYY-MM-DD) — the business day used for internet phone/day dedup.
function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// Dedupe grain by source (matches the order_id trigger so dedupe_key and order_id agree):
//   * Caliber (internet)          -> phone + ET-day  (owner's rule: unexplained multi-fires)
//   * Ringba / CallTools interim  -> conversion_call_id (RGB per-call | CT contact id) [UNCHANGED]
// Falls back to click:time (+value for non-caliber) when the primary key is absent.
function buildDedupeKey(args: {
  source: string;
  is_caliber: boolean;
  conversion_call_id: string | null;
  caller_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_time: Date;
  conversion_value: number;
}): string {
  const p = `${args.source}:${EVENT_TYPE}`;
  if (args.is_caliber) {
    const phone10 = phoneLast10(args.caller_id);
    if (phone10) return `${p}:${phone10}:${etDate(args.conversion_time)}`;
    if (args.conversion_call_id) return `${p}:${args.conversion_call_id}`;
    const click = args.gclid || args.gbraid || args.wbraid || "no_click";
    return `${p}:${click}:${args.conversion_time.toISOString()}`;
  }
  if (args.conversion_call_id) return `${p}:${args.conversion_call_id}`;
  const click = args.gclid || args.gbraid || args.wbraid || "no_click";
  return `${p}:${click}:${args.conversion_time.toISOString()}:${args.conversion_value.toFixed(4)}`;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return null;
}

interface MatchResult {
  lead_id: string | null;
  matched_by: string | null;
}

// Attribution columns pulled from a matched lead to backfill a Ringba event.
type LeadAttr = {
  transaction_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};

async function matchLead(
  supabase: ReturnType<typeof createClient>,
  fields: {
    lead_id: string | null;
    transaction_id: string | null;
    gclid: string | null;
    gbraid: string | null;
    wbraid: string | null;
    caller_id: string | null;
  },
): Promise<MatchResult> {
  // 1. Direct lead_id (if Ringba was configured to pass it through).
  if (fields.lead_id) {
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq("id", fields.lead_id)
      .maybeSingle();
    if (data?.id) return { lead_id: data.id as string, matched_by: "lead_id" };
  }

  // 2. transaction_id (the per-submission UUID forwarded into CallTools/Ringba).
  if (fields.transaction_id) {
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq("transaction_id", fields.transaction_id)
      .maybeSingle();
    if (data?.id) return { lead_id: data.id as string, matched_by: "transaction_id" };
  }

  // 3. Click identifiers, in priority order.
  for (const [col, val] of [
    ["gclid", fields.gclid],
    ["gbraid", fields.gbraid],
    ["wbraid", fields.wbraid],
  ] as const) {
    if (!val) continue;
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq(col, val)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id) return { lead_id: data.id as string, matched_by: col };
  }

  // 4. Phone number — only when a normalized E.164 caller_id matches a lead
  // phone whose digits resolve to the same E.164. This is best-effort and
  // deliberately last because callers often dial from an unrelated number.
  if (fields.caller_id) {
    const digits = fields.caller_id.replace(/\D/g, "");
    if (digits.length >= 10) {
      // Exact normalized last-10 match via idx_leads_phone_last10 (not a substring ILIKE).
      const { data } = await supabase.rpc("match_lead_id_by_phone10", { p10: digits.slice(-10) });
      if (data) return { lead_id: data as string, matched_by: "caller_id" };
    }
  }

  return { lead_id: null, matched_by: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Ringba pixels default to GET with all fields in the query string;
  // other integrations may POST JSON or form-encoded. Accept both.
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const expectedSecret = Deno.env.get("RINGBA_WEBHOOK_SECRET") || "";
  const url = new URL(req.url);
  const providedSecret =
    req.headers.get("x-webhook-secret") ||
    url.searchParams.get("secret") ||
    "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    // Do not leak which side was wrong. Return 401 fast; do not log.
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Always merge query-string fields with the body. Ringba GET pixels send
  // everything in the URL; some POST setups also pass a few fields there.
  // Body fields win over query-string fields when both exist.
  const queryPayload = Object.fromEntries(url.searchParams.entries());
  const bodyPayload = req.method === "POST"
    ? await parseRequestBody(req).catch(() => ({}))
    : {};
  const rawPayload = { ...queryPayload, ...(bodyPayload as Record<string, unknown>) };
  const flat = rawPayload as Record<string, unknown>;

  // Some Ringba setups nest data under "tag", "data", or "call". Merge the
  // top level with one level of nesting so pick() finds either.
  const merged: Record<string, unknown> = { ...flat };
  for (const k of ["tag", "tags", "data", "call", "event"]) {
    const v = flat[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(merged, v as Record<string, unknown>);
    }
  }

  // Caliber is detected by the PRESENCE of its `status` field, which Ringba/CallTools never
  // send. Caliber rows are ingested (visible) but held OUT of Google upload by the export view
  // until cutover (source <> 'caliber'); 'no connect' fires are dropped below before any dedup.
  const CALL_STATUS_KEYS = ["status", "Status", "call_status", "callStatus"];
  const is_caliber = CALL_STATUS_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(merged, k)
  );
  const source = is_caliber ? "caliber" : DEFAULT_SOURCE;

  const conversion_call_id = pick(merged, FIELD_VARIANTS.conversion_call_id);
  const calltools_call_id = pick(merged, FIELD_VARIANTS.calltools_call_id);
  const caller_id = pick(merged, FIELD_VARIANTS.caller_id);
  const gclid = pick(merged, FIELD_VARIANTS.gclid);
  const gbraid = pick(merged, FIELD_VARIANTS.gbraid);
  const wbraid = pick(merged, FIELD_VARIANTS.wbraid);
  const transaction_id = pick(merged, FIELD_VARIANTS.transaction_id);
  const claimed_lead_id = pick(merged, FIELD_VARIANTS.lead_id);
  const conversion_value = parseNumber(pick(merged, FIELD_VARIANTS.conversion_value)) ?? 0;
  const parsedConvTime = parseTimestamp(pick(merged, FIELD_VARIANTS.conversion_time));
  // Defend against Ringba sending "1/1/0001 12:00:00 AM" for missing
  // ConvertedTime tags (V8 mangles year 0001 into 2001). If the parsed
  // year is implausible, fall back to postback receipt time so we don't
  // poison Google with a conversion that pre-dates the click.
  const conversion_time =
    parsedConvTime && parsedConvTime.getUTCFullYear() >= 2024
      ? parsedConvTime
      : new Date();
  const currency_code = (pick(merged, FIELD_VARIANTS.currency_code) || "USD").toUpperCase();
  const caller_email = pick(merged, FIELD_VARIANTS.caller_email);
  const caller_first_name = pick(merged, FIELD_VARIANTS.caller_first_name);
  const caller_last_name = pick(merged, FIELD_VARIANTS.caller_last_name);
  const caller_zip = pick(merged, FIELD_VARIANTS.caller_zip);
  const caller_state = pick(merged, FIELD_VARIANTS.caller_state);
  const publisher = pick(merged, FIELD_VARIANTS.publisher);
  const utm_source = pick(merged, FIELD_VARIANTS.utm_source);
  const utm_medium = pick(merged, FIELD_VARIANTS.utm_medium);
  const utm_campaign = pick(merged, FIELD_VARIANTS.utm_campaign);
  const utm_content = pick(merged, FIELD_VARIANTS.utm_content);
  const utm_term = pick(merged, FIELD_VARIANTS.utm_term);
  const ib_source = pick(merged, FIELD_VARIANTS.ib_source);
  const oppref = pick(merged, FIELD_VARIANTS.oppref);
  const msclkid = pick(merged, FIELD_VARIANTS.msclkid);
  const fbclid = pick(merged, FIELD_VARIANTS.fbclid);
  const agent_name = pick(merged, FIELD_VARIANTS.agent_name);
  const queue = pick(merged, FIELD_VARIANTS.queue);
  const call_type = pick(merged, FIELD_VARIANTS.call_type);
  const call_status = pick(merged, FIELD_VARIANTS.call_status);

  // Ingress filter: only NBA-publisher postbacks become rows.
  // Other publishers' postbacks are logged for audit then dropped — we don't
  // own their attribution and uploading them to NBA's Google Ads would be
  // incorrect. Return 200 so Ringba does not retry.
  if ((publisher || "").trim().toUpperCase() !== "NBA") {
    await supabase.from("api_logs").insert({
      lead_id: null,
      transaction_id: transaction_id || conversion_call_id || "ringba-unknown",
      caller_id: caller_id || "",
      request_payload: { source: "ringba-webhook", raw: rawPayload } as object,
      response_payload: {
        skipped: true,
        reason: "non-nba-publisher",
        publisher: publisher || null,
      } as object,
      http_status: 200,
      success: true,
      error_message: null,
    });
    return new Response(
      JSON.stringify({ ok: true, stored: false, skipped: "non-nba-publisher" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Caliber "no connect" fires are not real transfers/monetizations — drop them BEFORE dedup
  // (owner's rule). Logged for visibility; no event row, so no derived transfer either.
  if (is_caliber && call_status && /no[\s_-]*connect/i.test(call_status)) {
    await supabase.from("api_logs").insert({
      lead_id: null,
      transaction_id: transaction_id || conversion_call_id || "caliber-unknown",
      caller_id: caller_id || "",
      request_payload: { source: "ringba-webhook", raw: rawPayload } as object,
      response_payload: { skipped: true, reason: "caliber-no-connect", call_status } as object,
      http_status: 200,
      success: true,
      error_message: null,
    });
    return new Response(
      JSON.stringify({ ok: true, stored: false, skipped: "caliber-no-connect" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const dedupe_key = buildDedupeKey({
    source, is_caliber,
    conversion_call_id, caller_id,
    gclid, gbraid, wbraid,
    conversion_time,
    conversion_value,
  });

  const match = await matchLead(supabase, {
    lead_id: claimed_lead_id,
    transaction_id,
    gclid, gbraid, wbraid,
    caller_id,
  });

  // Backfill attribution from the matched lead at ingestion time. Ringba often
  // can't forward the transaction_id/UTMs (e.g. direct-dial callers whose lead
  // was created by the form, or transfers that drop the tags). When we've
  // matched a lead, prefer the postback value but fall back to the lead's, so
  // the stored event carries full attribution instead of a bare caller_id.
  let leadAttr: LeadAttr | null = null;
  if (match.lead_id) {
    const { data } = await supabase
      .from("leads")
      .select("transaction_id, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_content, utm_term")
      .eq("id", match.lead_id)
      .maybeSingle();
    leadAttr = (data as unknown as LeadAttr) ?? null;
  }
  const nz = (v: string | null | undefined): string | null =>
    (v !== undefined && v !== null && String(v).trim() !== "") ? String(v) : null;
  const eff_transaction_id = nz(transaction_id) ?? nz(leadAttr?.transaction_id) ?? null;
  const eff_gclid = nz(gclid) ?? nz(leadAttr?.gclid) ?? null;
  const eff_gbraid = nz(gbraid) ?? nz(leadAttr?.gbraid) ?? null;
  const eff_wbraid = nz(wbraid) ?? nz(leadAttr?.wbraid) ?? null;
  const eff_utm_source = nz(utm_source) ?? nz(leadAttr?.utm_source) ?? null;
  const eff_utm_medium = nz(utm_medium) ?? nz(leadAttr?.utm_medium) ?? null;
  const eff_utm_campaign = nz(utm_campaign) ?? nz(leadAttr?.utm_campaign) ?? null;
  const eff_utm_content = nz(utm_content) ?? nz(leadAttr?.utm_content) ?? null;
  const eff_utm_term = nz(utm_term) ?? nz(leadAttr?.utm_term) ?? null;

  const hasClickId = Boolean(eff_gclid || eff_gbraid || eff_wbraid);
  // ECL-eligible: we have either matched a lead (so the uploader will pull
  // full PII via JOIN) or Ringba forwarded enough postback PII to send
  // hashed userIdentifiers. Phone alone (caller_id) is enough — Google's
  // ECL match works on hashed phone for Android-account-linked users.
  const hasEclData = Boolean(
    match.lead_id || caller_email || caller_id || (caller_first_name && caller_last_name && caller_zip),
  );
  let status: string;
  if ((hasClickId || hasEclData) && conversion_value > 0) {
    // 'monetize_ready' = a monetized (CCO) event ready to upload; parallels the
    // transfer path's 'transfer_ready'. (Renamed from 'ready_to_upload' 2026-08-07.)
    status = "monetize_ready";
  } else if (match.lead_id) {
    status = "matched";
  } else {
    status = "unmatched";
  }

  // Upsert by dedupe_key. ignoreDuplicates so a re-fired Ringba postback is
  // a no-op rather than a status reset (which would re-upload to Google).
  const { data: existing } = await supabase
    .from("offline_conversion_events")
    .select("id, status")
    .eq("dedupe_key", dedupe_key)
    .maybeSingle();

  let eventId: string | null = null;
  let inserted = false;

  if (existing?.id) {
    eventId = existing.id as string;
    inserted = false;
  } else {
    const { data: newRow, error: insertErr } = await supabase
      .from("offline_conversion_events")
      .insert({
        source,
        event_type: EVENT_TYPE,
        status,
        lead_id: match.lead_id,
        transaction_id: eff_transaction_id,
        conversion_call_id,
        calltools_call_id,
        caller_id,
        gclid: eff_gclid,
        gbraid: eff_gbraid,
        wbraid: eff_wbraid,
        conversion_time: conversion_time.toISOString(),
        conversion_value,
        currency_code,
        caller_email,
        caller_first_name,
        caller_last_name,
        caller_zip,
        caller_state,
        publisher,
        utm_source: eff_utm_source,
        utm_medium: eff_utm_medium,
        utm_campaign: eff_utm_campaign,
        utm_content: eff_utm_content,
        utm_term: eff_utm_term,
        ib_source,
        oppref,
        msclkid,
        fbclid,
        agent_name,
        queue,
        call_type,
        call_status,
        google_ads_customer_id: Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || null,
        google_ads_conversion_action_id:
          Deno.env.get("GOOGLE_ADS_CONVERSION_ACTION_ID_CALL_CONVERTED_REVENUE") || null,
        google_ads_conversion_action_name: "CallConvertOffline",
        raw_payload: rawPayload,
        dedupe_key,
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("offline_conversion_events insert error:", insertErr);
      // Log inbound failure to api_logs and still 200 so Ringba does not
      // retry against a bug it cannot fix.
      await supabase.from("api_logs").insert({
        lead_id: match.lead_id,
        transaction_id: transaction_id || conversion_call_id || "ringba-unknown",
        caller_id: caller_id || "",
        request_payload: rawPayload as object,
        response_payload: { error: insertErr.message } as object,
        http_status: 500,
        success: false,
        error_message: `ringba-webhook insert failed: ${insertErr.message}`,
      });
      return new Response(
        JSON.stringify({ ok: true, stored: false }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    eventId = newRow!.id as string;
    inserted = true;
  }

  // Cross-cutting log to api_logs so Ringba inbound calls show up in the
  // same audit trail as CallTools outbound calls.
  await supabase.from("api_logs").insert({
    api_type: is_caliber ? "cv-internet-caliber" : "cv-cco-ringba",
    lead_id: match.lead_id,
    transaction_id: transaction_id || conversion_call_id || "ringba-unknown",
    caller_id: caller_id || "",
    request_payload: {
      source: "ringba-webhook",
      raw: rawPayload,
      parsed: {
        conversion_call_id, gclid, gbraid, wbraid,
        conversion_value, conversion_time: conversion_time.toISOString(),
        currency_code, transaction_id, caller_id,
      },
    } as object,
    response_payload: {
      event_id: eventId,
      inserted,
      status,
      matched_by: match.matched_by,
      dedupe_key,
    } as object,
    http_status: 200,
    success: true,
    error_message: null,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      event_id: eventId,
      inserted,
      status,
      matched_by: match.matched_by,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
