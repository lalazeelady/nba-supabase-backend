// upload-google-offline-conversions
//
// Pulls offline_conversion_events rows with status=ready_to_upload and
// hands each one to the configured upload provider. Triggered every 15
// minutes by pg_cron and also callable on demand for testing/reprocessing.
//
// Auth: shared invoke secret in `x-invoke-secret` header. The cron job in
// migrations/20260426000001 sends this header from a database setting.
//
// Behavior:
//   - dry_run provider (Phase 1A default): rows stay at ready_to_upload
//     and the dry-run payload is logged. Re-running is a no-op.
//   - real providers: rows move to status=uploaded on success or status=
//     failed on permanent error. Retryable errors leave status untouched
//     and increment upload_attempts; the row gets retried next run, with
//     a hard cap of MAX_ATTEMPTS to keep us out of an infinite retry loop.
//
// Query params (manual invoke):
//   ?ids=<uuid,uuid,...>  — only upload these specific events
//   ?limit=<n>            — cap rows considered (default 50, max 500)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  ConversionEvent,
  selectProvider,
} from "../_shared/upload-providers/index.ts";

const MAX_ATTEMPTS = 6;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface SummaryCounters {
  considered: number;
  uploaded: number;
  retryable: number;
  permanent: number;
  dry_run: number;
  skipped_no_click: number;
  skipped_max_attempts: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Auth — shared secret. The cron job sends this header.
  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT,
  );

  // We pull a lot of fields per row because the Data Manager provider
  // builds Enhanced-Conversion-for-Leads userIdentifiers from caller PII
  // (email, phone, name, zip, state). Matched events also get enriched
  // from the leads table below.
  const SELECT =
    "id, conversion_time, conversion_value, currency_code, gclid, gbraid, wbraid, dedupe_key, " +
    "google_ads_customer_id, google_ads_conversion_action_id, google_ads_conversion_action_name, " +
    "upload_attempts, status, lead_id, caller_id, " +
    "caller_email, caller_first_name, caller_last_name, caller_zip, caller_state";

  let query = supabase
    .from("offline_conversion_events")
    .select(SELECT)
    .eq("status", "ready_to_upload")
    .lt("upload_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "ids param empty" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Manual reprocess: also allow rows in failed/uploaded if explicitly named.
    query = supabase
      .from("offline_conversion_events")
      .select(SELECT)
      .in("id", ids);
  }

  const { data: rows, error: selectErr } = await query;
  if (selectErr) {
    console.error("Select error:", selectErr);
    return new Response(
      JSON.stringify({ error: selectErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const provider = selectProvider();
  const counters: SummaryCounters = {
    considered: rows?.length ?? 0,
    uploaded: 0,
    retryable: 0,
    permanent: 0,
    dry_run: 0,
    skipped_no_click: 0,
    skipped_max_attempts: 0,
  };

  // Pre-fetch lead PII for any matched rows in one query, then merge per row.
  // We use leads PII over caller_* fields when both exist, since leads is the
  // canonical source (the caller_* fields are only what Ringba forwarded).
  const leadIds = Array.from(
    new Set((rows ?? []).map((r) => r.lead_id).filter((x): x is string => !!x)),
  );
  type LeadPii = { email: string | null; phone: string | null; first_name: string | null; last_name: string | null; zip: string | null; state: string | null };
  const leadsById = new Map<string, LeadPii>();
  if (leadIds.length > 0) {
    const { data: leadRows } = await supabase
      .from("leads")
      .select("id, email, phone, first_name, last_name, zip, state")
      .in("id", leadIds);
    for (const lr of leadRows ?? []) {
      leadsById.set(lr.id as string, {
        email: (lr.email as string) ?? null,
        phone: (lr.phone as string) ?? null,
        first_name: (lr.first_name as string) ?? null,
        last_name: (lr.last_name as string) ?? null,
        zip: (lr.zip as string) ?? null,
        state: (lr.state as string) ?? null,
      });
    }
  }

  for (const row of rows ?? []) {
    const hasClick = Boolean(row.gclid || row.gbraid || row.wbraid);
    const lead = row.lead_id ? leadsById.get(row.lead_id as string) : undefined;
    const pii = {
      email: lead?.email ?? row.caller_email ?? null,
      phone: lead?.phone ?? row.caller_id ?? null,
      first_name: lead?.first_name ?? row.caller_first_name ?? null,
      last_name: lead?.last_name ?? row.caller_last_name ?? null,
      zip: lead?.zip ?? row.caller_zip ?? null,
      state: lead?.state ?? row.caller_state ?? null,
      country: "US",
    };
    const hasPii = Boolean(pii.email || pii.phone || (pii.first_name && pii.last_name && pii.zip));

    if (!hasClick && !hasPii) {
      counters.skipped_no_click++;
      continue;
    }
    if ((row.upload_attempts ?? 0) >= MAX_ATTEMPTS) {
      counters.skipped_max_attempts++;
      continue;
    }

    const event: ConversionEvent = {
      id: row.id,
      conversion_time: row.conversion_time,
      conversion_value: Number(row.conversion_value),
      currency_code: row.currency_code,
      gclid: row.gclid,
      gbraid: row.gbraid,
      wbraid: row.wbraid,
      dedupe_key: row.dedupe_key,
      google_ads_customer_id: row.google_ads_customer_id,
      google_ads_conversion_action_id: row.google_ads_conversion_action_id,
      google_ads_conversion_action_name: row.google_ads_conversion_action_name,
      pii,
    };

    const nowIso = new Date().toISOString();
    const outcome = await provider.upload(event);

    if (provider.name === "dry_run") {
      // Dry-run does not advance state. Record attempt count for visibility
      // but keep status=ready_to_upload so a real provider can retry later.
      counters.dry_run++;
      await supabase
        .from("offline_conversion_events")
        .update({
          upload_attempts: (row.upload_attempts ?? 0) + 1,
          last_upload_attempt_at: nowIso,
          google_upload_response: { dry_run: true, outcome },
        })
        .eq("id", row.id);
      await logAttempt(supabase, row.id, provider.name, outcome, true);
      continue;
    }

    if (outcome.kind === "success") {
      counters.uploaded++;
      await supabase
        .from("offline_conversion_events")
        .update({
          status: "uploaded",
          uploaded_at: nowIso,
          last_upload_attempt_at: nowIso,
          upload_attempts: (row.upload_attempts ?? 0) + 1,
          google_upload_response: outcome.response as object,
          google_upload_error: null,
        })
        .eq("id", row.id);
      await logAttempt(supabase, row.id, provider.name, outcome, true);
    } else if (outcome.kind === "permanent") {
      counters.permanent++;
      await supabase
        .from("offline_conversion_events")
        .update({
          status: "failed",
          last_upload_attempt_at: nowIso,
          upload_attempts: (row.upload_attempts ?? 0) + 1,
          google_upload_error: outcome.error as object,
        })
        .eq("id", row.id);
      await logAttempt(supabase, row.id, provider.name, outcome, false);
    } else {
      counters.retryable++;
      const nextAttempts = (row.upload_attempts ?? 0) + 1;
      const hitCap = nextAttempts >= MAX_ATTEMPTS;
      await supabase
        .from("offline_conversion_events")
        .update({
          status: hitCap ? "failed" : "ready_to_upload",
          last_upload_attempt_at: nowIso,
          upload_attempts: nextAttempts,
          google_upload_error: outcome.error as object,
        })
        .eq("id", row.id);
      await logAttempt(supabase, row.id, provider.name, outcome, false);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, provider: provider.name, ...counters }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

async function logAttempt(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
  providerName: string,
  outcome: unknown,
  success: boolean,
) {
  // Use the existing api_logs table so all outbound integration calls
  // share an audit trail. lead_id stays null here — the link is
  // event_id stored in request_payload.
  await supabase.from("api_logs").insert({
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
