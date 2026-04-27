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

  let query = supabase
    .from("offline_conversion_events")
    .select(
      "id, conversion_time, conversion_value, currency_code, gclid, gbraid, wbraid, dedupe_key, " +
      "google_ads_customer_id, google_ads_conversion_action_id, google_ads_conversion_action_name, " +
      "upload_attempts, status",
    )
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
      .select(
        "id, conversion_time, conversion_value, currency_code, gclid, gbraid, wbraid, dedupe_key, " +
        "google_ads_customer_id, google_ads_conversion_action_id, google_ads_conversion_action_name, " +
        "upload_attempts, status",
      )
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

  for (const row of rows ?? []) {
    if (!row.gclid && !row.gbraid && !row.wbraid) {
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
