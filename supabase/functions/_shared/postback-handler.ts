// Shared handler for postback-transfer-webhook and postback-monetize-webhook (v4, 2026-09-17).
//
// Caliber postbacks -> public.postbacks (one row per call event). The endpoint sets the
// event type. The database matches the row to a lead on insert. Nothing here uploads to
// any platform: public.platform_uploads and upload-platform-conversions do that.
//
// Contract (Caliber Postback Spec rev 9, unchanged for the sender):
//   - Secret in `x-webhook-secret` header or `?secret=`. Missing or wrong: HTTP 401.
//   - publisher must be NBA, caller_id at least 10 digits, caliber_call_id present.
//     Otherwise HTTP 422 naming every problem (logged with reason 'non-nba-publisher'
//     when the publisher is wrong, so the health-check publisher alert keeps working).
//   - call status containing "no connect": HTTP 200, not stored.
//   - A re-fire of the same caliber_call_id for the same event: HTTP 200, inserted:false.
//   - Save failure: HTTP 503 (error_message contains "insert failed" for the health check).
//
// raw_payload is stored on the postbacks row with the secret removed. api_logs keeps a
// slim row (no payload) for a stored postback, and the payload only for a rejected one.

import { createClient } from "npm:@supabase/supabase-js@2";

export type PostbackEvent = "transfer" | "monetize";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret",
};

// Parameter names we accept. First non-empty value wins.
const FIELDS = {
  caliber_call_id: ["caliber_call_id", "caliberCallId"],
  calltools_call_id: ["call_id", "calltools_call_id", "ct_call_id"],
  caller_id: ["caller_id", "callerId", "ani"],
  transaction_id: ["transaction_id", "transactionId"],
  email: ["email", "caller_email"],
  state: ["state"],
  gclid: ["gclid"],
  gbraid: ["gbraid"],
  wbraid: ["wbraid"],
  msclkid: ["msclkid"],
  fbclid: ["fbclid"],
  oppref: ["oppref", "oppref_id"],
  utm_source: ["utm_source"],
  ib_source: ["ib_source", "inbound_route"],
  offer: ["offer", "program"],
  publisher: ["publisher", "pub"],
  conversion_time: ["conversion_time", "converted_at", "call_end_time", "timestamp"],
  conversion_value: ["conversion_value", "revenue", "payout", "value"],
  call_status: ["status", "call_status"],
} as const;

type FieldName = keyof typeof FIELDS;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// "[tag:User:gclid]", "{{contact.email}}", "%FIELD%": a token the sender did not resolve.
// Stored it would look like data, so treat it as absent.
function isUnresolvedToken(v: string): boolean {
  const t = v.trim();
  return /^\[[^\]]*\]$/.test(t) || /^\{\{.*\}\}$/.test(t) || /^%[A-Za-z_]+%$/.test(t);
}

function pick(obj: Record<string, unknown>, name: FieldName): string | null {
  for (const k of FIELDS[name]) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s.length === 0 || isUnresolvedToken(s)) continue;
    return s;
  }
  return null;
}

function parseTimestamp(s: string | null): Date | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const d = new Date(s.length <= 10 ? Number(s) * 1000 : Number(s));
    return isNaN(d.getTime()) ? null : d;
  }
  // Timezone-less strings are UTC (senders report UTC).
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
    let iso = s.replace(" ", "T")
      .replace(/T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(\d{2}):?(\d{2})$/, "T$1+$2:$3")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(iso)) iso += "Z";
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseMoney(s: string | null): number {
  if (!s) return 0;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

function normalizeOffer(s: string | null): string | null {
  if (!s) return null;
  const v = s.toLowerCase().replace(/^cpn_/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return v ? v.slice(0, 40) : null;
}

async function readPayload(req: Request, url: URL): Promise<Record<string, unknown>> {
  const query: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    const text = await req.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
  }
  const merged: Record<string, unknown> = { ...query, ...body };
  // Some senders nest fields one level down.
  for (const k of ["tag", "tags", "data", "call"]) {
    const v = merged[k];
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(merged, v as Record<string, unknown>);
  }
  delete merged.secret;
  return merged;
}

export async function handlePostback(req: Request, event: PostbackEvent, endpoint: string): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const expected = Deno.env.get("RINGBA_WEBHOOK_SECRET") || "";
  const provided = req.headers.get("x-webhook-secret") || url.searchParams.get("secret") || "";
  if (!expected || provided !== expected) return json({ error: "Unauthorized" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const raw = await readPayload(req, url);
  const logTag = event === "transfer" ? "xfr" : "cco";

  const caliberCallId = pick(raw, "caliber_call_id");
  const callerId = pick(raw, "caller_id");
  const phoneDigits = (callerId || "").replace(/\D/g, "");
  const phone = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : null;
  const publisher = pick(raw, "publisher");
  const offer = normalizeOffer(pick(raw, "offer"));
  const transactionId = pick(raw, "transaction_id");

  // ---- Must-have fields ---------------------------------------------------------------
  const errors: { field: string; problem: string; received?: string | null }[] = [];
  const publisherOk = (publisher || "").toUpperCase() === "NBA";
  if (!publisherOk) errors.push({ field: "publisher", problem: "must be exactly NBA", received: publisher });
  if (!phone) errors.push({ field: "caller_id", problem: "missing or fewer than 10 digits", received: callerId });
  if (!caliberCallId) errors.push({ field: "caliber_call_id", problem: "missing: send the Caliber call id" });
  if (errors.length > 0) {
    await supabase.from("api_logs").insert({
      api_type: `cv-${logTag}-caliber-rejected`,
      transaction_id: transactionId || caliberCallId || "postback-rejected",
      caller_id: callerId || "",
      request_payload: { source: endpoint, raw } as object,
      response_payload: {
        rejected: true,
        reason: publisherOk ? "missing-required-fields" : "non-nba-publisher",
        errors, publisher, cv_source: "caliber", offer, event,
      } as object,
      http_status: 422,
      success: false,
      error_message: `rejected: ${errors.map((e) => e.field).join(", ")}`,
    });
    return json({
      ok: false, stored: false, error: "missing_or_invalid_required_fields", errors,
      hint: "fix these fields and fire again; if your publisher value is not exactly 'NBA', tell the NBA team what you send",
    }, 422);
  }

  // ---- No-connect calls are not events ------------------------------------------------
  const callStatus = pick(raw, "call_status");
  if (callStatus && /no[\s_-]*connect/i.test(callStatus)) {
    await supabase.from("api_logs").insert({
      api_type: `cv-${logTag}-caliber${offer ? `-${offer}` : ""}`,
      transaction_id: transactionId || caliberCallId!,
      caller_id: callerId || "",
      request_payload: { source: endpoint, raw } as object,
      response_payload: { skipped: true, reason: "no-connect", call_status: callStatus } as object,
      http_status: 200,
      success: true,
      error_message: null,
    });
    return json({ ok: true, stored: false, skipped: "no-connect" }, 200);
  }

  // ---- Store ----------------------------------------------------------------------------
  const parsedTime = parseTimestamp(pick(raw, "conversion_time"));
  const conversionTime = parsedTime && parsedTime.getUTCFullYear() >= 2024 ? parsedTime : new Date();
  const email = pick(raw, "email");
  const state = pick(raw, "state");

  const row = {
    cv_source: "caliber",
    event_type: event,
    offer,
    conversion_time: conversionTime.toISOString(),
    conversion_value: event === "transfer" ? 0 : parseMoney(pick(raw, "conversion_value")),
    caliber_call_id: caliberCallId,
    calltools_call_id: pick(raw, "calltools_call_id"),
    transaction_id: transactionId,
    phone,
    email: email ? email.toLowerCase() : null,
    state: state ? state.toUpperCase() : null,
    gclid: pick(raw, "gclid"),
    gbraid: pick(raw, "gbraid"),
    wbraid: pick(raw, "wbraid"),
    msclkid: pick(raw, "msclkid"),
    fbclid: pick(raw, "fbclid"),
    oppref: pick(raw, "oppref"),
    utm_source: pick(raw, "utm_source"),
    ib_source: pick(raw, "ib_source"),
    raw_payload: raw,
  };

  let postbackId: string | null = null;
  let matchMethod: string | null = null;
  let inserted = false;

  const { data: created, error: insertErr } = await supabase
    .from("postbacks").insert(row).select("id, match_method").single();

  if (!insertErr && created) {
    postbackId = (created as { id: string }).id;
    matchMethod = (created as { match_method: string | null }).match_method;
    inserted = true;
  } else if (insertErr && insertErr.code === "23505") {
    // Same caliber_call_id + event already stored: a re-fire.
    const { data: existing } = await supabase
      .from("postbacks").select("id, match_method")
      .eq("caliber_call_id", caliberCallId!).eq("event_type", event).maybeSingle();
    postbackId = (existing as { id: string } | null)?.id ?? null;
    matchMethod = (existing as { match_method: string | null } | null)?.match_method ?? null;
  } else {
    const message = insertErr?.message || "no row returned";
    console.error(`${endpoint}: postbacks insert failed:`, insertErr);
    await supabase.from("api_logs").insert({
      api_type: `cv-${logTag}-caliber-save-failed`,
      transaction_id: transactionId || caliberCallId!,
      caller_id: callerId || "",
      request_payload: { source: endpoint, raw } as object,
      response_payload: { error: message, code: insertErr?.code ?? null } as object,
      http_status: 503,
      success: false,
      error_message: `${endpoint} insert failed: ${message}`,
    });
    return json({ ok: false, stored: false, error: "save_failed", retry: true }, 503);
  }

  await supabase.from("api_logs").insert({
    api_type: `cv-${logTag}-caliber${offer ? `-${offer}` : ""}`,
    transaction_id: transactionId || caliberCallId!,
    caller_id: callerId || "",
    request_payload: {
      source: endpoint,
      parsed: { endpoint, event_type: event, caliber_call_id: caliberCallId, offer, conversion_value: row.conversion_value },
    } as object,
    response_payload: { postback_id: postbackId, inserted, match_method: matchMethod } as object,
    http_status: 200,
    success: true,
    error_message: null,
  });

  return json({
    ok: true,
    event_id: postbackId,
    inserted,
    event_type: event === "transfer" ? "call_transferred" : "call_converted_revenue",
    cv_source: "caliber",
    offer,
    matched_by: matchMethod,
  }, 200);
}
