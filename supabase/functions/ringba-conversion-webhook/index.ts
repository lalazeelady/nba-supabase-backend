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
import { corsHeaders } from "../_shared/cors.ts";

const SOURCE = "ringba";
const EVENT_TYPE = "call_converted_revenue";

// Field-name variants we accept from Ringba. First non-empty value wins.
const FIELD_VARIANTS = {
  ringba_call_id: [
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
  // Pure-numeric → epoch seconds or ms
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const ms = s.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
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

function buildDedupeKey(args: {
  ringba_call_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_time: Date;
  conversion_value: number;
}): string {
  if (args.ringba_call_id) {
    return `${SOURCE}:${EVENT_TYPE}:${args.ringba_call_id}`;
  }
  const click = args.gclid || args.gbraid || args.wbraid || "no_click";
  const ts = args.conversion_time.toISOString();
  const val = args.conversion_value.toFixed(4);
  return `${SOURCE}:${EVENT_TYPE}:${click}:${ts}:${val}`;
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
    const e164 = normalizePhone(fields.caller_id);
    if (e164) {
      const tenDigits = e164.replace(/^\+1/, "");
      const { data } = await supabase
        .from("leads")
        .select("id, phone")
        .ilike("phone", `%${tenDigits}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.id) return { lead_id: data.id as string, matched_by: "caller_id" };
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

  const ringba_call_id = pick(merged, FIELD_VARIANTS.ringba_call_id);
  const calltools_call_id = pick(merged, FIELD_VARIANTS.calltools_call_id);
  const caller_id = pick(merged, FIELD_VARIANTS.caller_id);
  const gclid = pick(merged, FIELD_VARIANTS.gclid);
  const gbraid = pick(merged, FIELD_VARIANTS.gbraid);
  const wbraid = pick(merged, FIELD_VARIANTS.wbraid);
  const transaction_id = pick(merged, FIELD_VARIANTS.transaction_id);
  const claimed_lead_id = pick(merged, FIELD_VARIANTS.lead_id);
  const conversion_value = parseNumber(pick(merged, FIELD_VARIANTS.conversion_value)) ?? 0;
  const conversion_time =
    parseTimestamp(pick(merged, FIELD_VARIANTS.conversion_time)) ?? new Date();
  const currency_code = (pick(merged, FIELD_VARIANTS.currency_code) || "USD").toUpperCase();

  const dedupe_key = buildDedupeKey({
    ringba_call_id,
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

  const hasClickId = Boolean(gclid || gbraid || wbraid);
  let status: string;
  if (hasClickId && conversion_value > 0) {
    status = "ready_to_upload";
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
        source: SOURCE,
        event_type: EVENT_TYPE,
        status,
        lead_id: match.lead_id,
        transaction_id,
        ringba_call_id,
        calltools_call_id,
        caller_id,
        gclid,
        gbraid,
        wbraid,
        conversion_time: conversion_time.toISOString(),
        conversion_value,
        currency_code,
        google_ads_customer_id: Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || null,
        google_ads_conversion_action_id:
          Deno.env.get("GOOGLE_ADS_CONVERSION_ACTION_ID_CALL_CONVERTED_REVENUE") || null,
        google_ads_conversion_action_name: "Call Converted - Revenue",
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
        transaction_id: transaction_id || ringba_call_id || "ringba-unknown",
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
    lead_id: match.lead_id,
    transaction_id: transaction_id || ringba_call_id || "ringba-unknown",
    caller_id: caller_id || "",
    request_payload: {
      source: "ringba-webhook",
      raw: rawPayload,
      parsed: {
        ringba_call_id, gclid, gbraid, wbraid,
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
