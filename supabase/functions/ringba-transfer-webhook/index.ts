// ringba-transfer-webhook
//
// Receives "call transferred" postbacks from Ringba — fired on the Ringba
// "Incoming" event, i.e. the moment a CallTools agent transfers a qualified
// call into Ringba (before/regardless of a buyer answering). Stores each as a
// $0, count-only offline-conversion event in public.offline_conversion_events
// with event_type='call_transferred', for upload to the Google Ads "CallXfer"
// conversion action.
//
// This is a DEDICATED sibling of ringba-conversion-webhook (the revenue
// webhook). It deliberately does NOT touch that function so the revenue path
// carries zero risk. The two share nothing at runtime; the parser here is a
// trimmed copy on purpose (functions deploy as single self-contained files).
//
// Key differences vs. the revenue webhook:
//   - event_type       = 'call_transferred'  (revenue: 'call_converted_revenue')
//   - conversion_value = 0, always forced     (transfers are a count signal)
//   - conversion_name  = 'CallXfer'
//   - status           = 'transfer_ready' | 'transfer_unmatched'
//
// De-dup: GROSS — ONE CallXfer per Ringba CALL. dedupe_key is
// 'ringba:call_transferred:<conversion_call_id>', so uploads to Google equal Ringba's gross
// transfer count; only re-fires of the SAME call collapse. Phone+ET-day is a fallback used
// only when a transfer arrives with no call id. Namespaced by event_type, so this is fully
// independent of the REVENUE event.
//
// Auth: shared secret in the `x-webhook-secret` header or `?secret=` query,
// compared against RINGBA_WEBHOOK_SECRET (reused from the revenue webhook).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

const SOURCE = "ringba";
const EVENT_TYPE = "call_transferred";
const CONVERSION_NAME = "CallXfer";

// Field-name variants we accept from Ringba. First non-empty value wins.
// `conversion_call_id` = the id of the transferred call (Ringba 'RGB…').
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
  gclid: ["gclid", "gclID", "gcl_id", "google_click_id", "googleClickId"],
  gbraid: ["gbraid", "gbraID", "gbraid_id"],
  wbraid: ["wbraid", "wbraID", "wbraid_id"],
  transaction_id: [
    "transaction_id", "transactionId", "lead_transaction_id", "txn_id", "txnId",
  ],
  lead_id: [
    "lead_id", "leadId", "leadid", "supabase_lead_id", "nba_lead_id",
  ],
  conversion_time: [
    "conversion_time", "conversionTime", "converted_at", "convertedAt",
    "call_end_time", "callEndTime", "end_time", "endTime",
    "connect_time", "connectTime", "answer_time", "answerTime",
    "timestamp", "ts",
  ],
  currency_code: ["currency_code", "currencyCode", "currency"],
  caller_email: [
    "email", "callerEmail", "caller_email", "user_email", "userEmail",
  ],
  caller_first_name: ["first_name", "firstName", "fname", "first"],
  caller_last_name: ["last_name", "lastName", "lname", "last"],
  caller_zip: ["zip", "zip_code", "zipCode", "postal_code", "postalCode"],
  caller_state: ["state", "region", "regionCode", "region_code"],
  publisher: [
    "pub", "Pub",
    "publisher", "Publisher", "publisher_name", "publisherName",
    "tag:Publisher:Name", "tag:Publisher:name",
  ],
  utm_source: ["utm_source", "utmSource", "utm_src"],
  utm_medium: ["utm_medium", "utmMedium", "utm_med"],
  utm_campaign: ["utm_campaign", "utmCampaign", "utm_camp"],
  utm_content: ["utm_content", "utmContent"],
  utm_term: ["utm_term", "utmTerm"],
  // Attribution/reporting extras (stored where present).
  ib_source: ["ib_source", "inbound_route", "inbound_route][name]", "inboundRoute", "ibSource"],
  oppref: ["oppref_id", "oppref", "opprefId"],
  msclkid: ["msclkid", "msclkId"],
  fbclid: ["fbclid", "fbclId"],
  agent_name: ["agent_name", "agentName", "agent"],
  queue: ["queue", "queue_name", "queueName", "queue_id", "queueId", "queueid"],
  call_type: ["call_type", "callType"],
} as const;

function pick(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return null;
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

  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// Last 10 digits of a phone, or null if fewer than 10 digits are present.
function phoneLast10(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Eastern-Time calendar date (YYYY-MM-DD) — the business day the call center
// (and the Ringba report) thinks in.
function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// dedupe_key: GROSS — ONE CallXfer per Ringba CALL (keyed on the per-call 'RGB…' id), so
// every qualified transfer is counted, matching Ringba's gross transfer count. Only re-fires
// of the SAME call (same id) collapse. Phone+ET-day is a fallback used only when a transfer
// arrives with no call id, so an anonymous transfer is never merged with a different call id.
function buildDedupeKey(args: {
  conversion_call_id: string | null;
  caller_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_time: Date;
}): string {
  if (args.conversion_call_id) {
    return `${SOURCE}:${EVENT_TYPE}:${args.conversion_call_id}`;
  }
  const p = phoneLast10(args.caller_id);
  if (p) {
    return `${SOURCE}:${EVENT_TYPE}:${p}:${etDate(args.conversion_time)}`;
  }
  const click = args.gclid || args.gbraid || args.wbraid || "no_click";
  return `${SOURCE}:${EVENT_TYPE}:${click}:${args.conversion_time.toISOString()}`;
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
  if (fields.lead_id) {
    const { data } = await supabase
      .from("leads").select("id").eq("id", fields.lead_id).maybeSingle();
    if (data?.id) return { lead_id: data.id as string, matched_by: "lead_id" };
  }

  if (fields.transaction_id) {
    const { data } = await supabase
      .from("leads").select("id").eq("transaction_id", fields.transaction_id).maybeSingle();
    if (data?.id) return { lead_id: data.id as string, matched_by: "transaction_id" };
  }

  for (const [col, val] of [
    ["gclid", fields.gclid],
    ["gbraid", fields.gbraid],
    ["wbraid", fields.wbraid],
  ] as const) {
    if (!val) continue;
    const { data } = await supabase
      .from("leads").select("id").eq(col, val)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.id) return { lead_id: data.id as string, matched_by: col };
  }

  if (fields.caller_id) {
    const e164 = normalizePhone(fields.caller_id);
    if (e164) {
      const tenDigits = e164.replace(/^\+1/, "");
      const { data } = await supabase
        .from("leads").select("id, phone").ilike("phone", `%${tenDigits}%`)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (data?.id) return { lead_id: data.id as string, matched_by: "caller_id" };
    }
  }

  return { lead_id: null, matched_by: null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const expectedSecret = Deno.env.get("RINGBA_WEBHOOK_SECRET") || "";
  const url = new URL(req.url);
  const providedSecret =
    req.headers.get("x-webhook-secret") || url.searchParams.get("secret") || "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const queryPayload = Object.fromEntries(url.searchParams.entries());
  let bodyPayload: Record<string, unknown> = {};
  if (req.method === "POST") {
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    try {
      if (contentType.includes("application/json")) {
        bodyPayload = await req.json();
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        bodyPayload = Object.fromEntries(new URLSearchParams(await req.text()));
      } else {
        const text = await req.text();
        try { bodyPayload = JSON.parse(text); }
        catch { bodyPayload = Object.fromEntries(new URLSearchParams(text)); }
      }
    } catch { bodyPayload = {}; }
  }
  const rawPayload = { ...queryPayload, ...bodyPayload };
  const flat = rawPayload as Record<string, unknown>;

  const merged: Record<string, unknown> = { ...flat };
  for (const k of ["tag", "tags", "data", "call", "event"]) {
    const v = flat[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(merged, v as Record<string, unknown>);
    }
  }

  const conversion_call_id = pick(merged, FIELD_VARIANTS.conversion_call_id);
  const calltools_call_id = pick(merged, FIELD_VARIANTS.calltools_call_id);
  const caller_id = pick(merged, FIELD_VARIANTS.caller_id);
  const gclid = pick(merged, FIELD_VARIANTS.gclid);
  const gbraid = pick(merged, FIELD_VARIANTS.gbraid);
  const wbraid = pick(merged, FIELD_VARIANTS.wbraid);
  const transaction_id = pick(merged, FIELD_VARIANTS.transaction_id);
  const claimed_lead_id = pick(merged, FIELD_VARIANTS.lead_id);
  const parsedConvTime = parseTimestamp(pick(merged, FIELD_VARIANTS.conversion_time));
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

  // Transfers are a count signal: value is ALWAYS $0, regardless of any
  // conversion_value the pixel might carry.
  const conversion_value = 0;

  // Ingress filter: only NBA-publisher transfers become rows (parity with the
  // revenue webhook). Log-and-drop others; return 200 so Ringba won't retry.
  if ((publisher || "").trim().toUpperCase() !== "NBA") {
    await supabase.from("api_logs").insert({
      lead_id: null,
      transaction_id: transaction_id || conversion_call_id || "ringba-transfer-unknown",
      caller_id: caller_id || "",
      request_payload: { source: "ringba-transfer-webhook", raw: rawPayload } as object,
      response_payload: {
        skipped: true, reason: "non-nba-publisher", publisher: publisher || null,
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

  const dedupe_key = buildDedupeKey({
    conversion_call_id, caller_id, gclid, gbraid, wbraid, conversion_time,
  });

  const match = await matchLead(supabase, {
    lead_id: claimed_lead_id, transaction_id, gclid, gbraid, wbraid, caller_id,
  });

  // Backfill attribution from a matched lead (transfers often can't forward
  // the transaction_id/UTMs). Prefer the postback value, fall back to lead's.
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
  // ECL-eligible: matched lead OR the postback forwarded enough PII. Value is
  // NOT required for transfers (they are always $0).
  const hasEclData = Boolean(
    match.lead_id || caller_email || caller_id || (caller_first_name && caller_last_name && caller_zip),
  );
  const status = (hasClickId || hasEclData) ? "transfer_ready" : "transfer_unmatched";

  // Upsert by dedupe_key: a re-fired transfer postback is a no-op.
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
        source: SOURCE,
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
        ib_source,
        oppref,
        msclkid,
        fbclid,
        agent_name,
        queue,
        call_type,
        utm_source: eff_utm_source,
        utm_medium: eff_utm_medium,
        utm_campaign: eff_utm_campaign,
        utm_content: eff_utm_content,
        utm_term: eff_utm_term,
        google_ads_customer_id: Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || null,
        google_ads_conversion_action_id:
          Deno.env.get("GOOGLE_ADS_CONVERSION_ACTION_ID_CALL_TRANSFERRED") || null,
        google_ads_conversion_action_name: CONVERSION_NAME,
        raw_payload: rawPayload,
        dedupe_key,
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("offline_conversion_events (transfer) insert error:", insertErr);
      await supabase.from("api_logs").insert({
        lead_id: match.lead_id,
        transaction_id: transaction_id || conversion_call_id || "ringba-transfer-unknown",
        caller_id: caller_id || "",
        request_payload: rawPayload as object,
        response_payload: { error: insertErr.message } as object,
        http_status: 500,
        success: false,
        error_message: `ringba-transfer-webhook insert failed: ${insertErr.message}`,
      });
      return new Response(
        JSON.stringify({ ok: true, stored: false }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    eventId = newRow!.id as string;
    inserted = true;
  }

  await supabase.from("api_logs").insert({
    lead_id: match.lead_id,
    transaction_id: transaction_id || conversion_call_id || "ringba-transfer-unknown",
    caller_id: caller_id || "",
    request_payload: {
      source: "ringba-transfer-webhook",
      raw: rawPayload,
      parsed: {
        conversion_call_id, gclid, gbraid, wbraid,
        conversion_time: conversion_time.toISOString(),
        currency_code, transaction_id, caller_id, event_type: EVENT_TYPE,
      },
    } as object,
    response_payload: {
      event_id: eventId, inserted, status,
      matched_by: match.matched_by, dedupe_key,
    } as object,
    http_status: 200,
    success: true,
    error_message: null,
  });

  return new Response(
    JSON.stringify({
      ok: true, event_id: eventId, inserted, status,
      event_type: EVENT_TYPE, matched_by: match.matched_by,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
