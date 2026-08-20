// pipeline-health-check
//
// Guards against the Aug-2026 silent outage: both offline-conversion delivery
// paths (sync-google-sheet, upload-google-offline-conversions) 500'd internally
// for days while the pg_cron jobs kept reporting "succeeded" (net.http_post only
// dispatches — it can't see the function's 500). Nothing alerted because the
// failing SELECT never reached the code that flips rows to `failed` / emails.
//
// This check reads the BASE TABLE directly (never the export view, so it can't be
// taken down by the same view-timeout that caused the outage) and emails on a
// stall: eligible rows that should have been delivered a while ago but weren't,
// AND no successful delivery on that path in the last hour.
//
// Signals (per path):
//   Sheet: rows with sheet_synced_at IS NULL, status in the ready set, publisher
//          NBA, created > STALL_GRACE ago  ->  should already be on the Sheet.
//   API:   rows in the ready set, uploaded_at IS NULL, conversion_time <= 85d,
//          upload_attempts < 6, created > STALL_GRACE ago  ->  should be uploaded.
// A path is "stalled" when its backlog exceeds BACKLOG_THRESHOLD *and* its most
// recent success (max sheet_synced_at / max uploaded_at) is older than SUCCESS_SLA.
//
// Auth (inbound): shared secret in `x-invoke-secret` (UPLOADER_INVOKE_SECRET).
// Query params: ?dry_run=true (compute + return, never email) | ?force=true (email
//   even if healthy, to test the wiring).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

const READY_STATUSES = ["monetize_ready", "ready_to_upload", "transfer_ready"];
const STALL_GRACE_MIN = 90;      // a row older than this should already be delivered (crons run /15min)
const SUCCESS_SLA_MIN = 60;      // no success on a path in this long (with backlog) => stalled
const BACKLOG_THRESHOLD = 50;    // ignore tiny transient backlogs (~1-2 cycles of volume)
const ALERT_TO = "larazielin1@gmail.com";

async function countBacklog(
  supabase: ReturnType<typeof createClient>,
  which: "sheet" | "api",
  graceIso: string,
  ageCutoffIso: string,
): Promise<number> {
  let q = supabase.from("offline_conversion_events")
    .select("id", { count: "exact", head: true })
    .eq("publisher", "NBA")
    .in("status", READY_STATUSES)
    .lt("created_at", graceIso);
  if (which === "sheet") {
    q = q.is("sheet_synced_at", null);
  } else {
    q = q.is("uploaded_at", null)
      .gte("conversion_time", ageCutoffIso)
      .lt("upload_attempts", 6);
  }
  const { count, error } = await q;
  if (error) throw new Error(`backlog(${which}): ${error.message}`);
  return count ?? 0;
}

async function lastSuccess(
  supabase: ReturnType<typeof createClient>,
  col: "sheet_synced_at" | "uploaded_at",
): Promise<string | null> {
  const { data, error } = await supabase.from("offline_conversion_events")
    .select(col).not(col, "is", null).order(col, { ascending: false }).limit(1);
  if (error) throw new Error(`lastSuccess(${col}): ${error.message}`);
  return (data && data[0] ? (data[0] as Record<string, string>)[col] : null) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const force = url.searchParams.get("force") === "true";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const now = Date.now();
  const graceIso = new Date(now - STALL_GRACE_MIN * 60000).toISOString();
  const slaIso = new Date(now - SUCCESS_SLA_MIN * 60000).toISOString();
  const ageCutoffIso = new Date(now - 85 * 86400000).toISOString();

  let report: Record<string, unknown>;
  try {
    const [sheetBacklog, apiBacklog, lastSheet, lastUpload] = await Promise.all([
      countBacklog(supabase, "sheet", graceIso, ageCutoffIso),
      countBacklog(supabase, "api", graceIso, ageCutoffIso),
      lastSuccess(supabase, "sheet_synced_at"),
      lastSuccess(supabase, "uploaded_at"),
    ]);

    const sheetStalled = sheetBacklog >= BACKLOG_THRESHOLD && (!lastSheet || lastSheet < slaIso);
    const apiStalled = apiBacklog >= BACKLOG_THRESHOLD && (!lastUpload || lastUpload < slaIso);

    report = {
      checked_at: new Date(now).toISOString(),
      sheet: { backlog: sheetBacklog, last_success: lastSheet, stalled: sheetStalled },
      api: { backlog: apiBacklog, last_success: lastUpload, stalled: apiStalled },
      thresholds: { stall_grace_min: STALL_GRACE_MIN, success_sla_min: SUCCESS_SLA_MIN, backlog_threshold: BACKLOG_THRESHOLD },
    };

    const alert = sheetStalled || apiStalled;
    if ((alert || force) && !dryRun) {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (resendKey) {
        const parts: string[] = [];
        if (sheetStalled) parts.push("Sheet (CallConvertOffline)");
        if (apiStalled) parts.push("Data Manager API (CallXfer/Test_DataMgrAPIUpload)");
        const subject = force && !alert
          ? "NBA offline-conversion health check — TEST (healthy)"
          : `⚠️ NBA offline conversions STALLED — ${parts.join(" + ")}`;
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "onboarding@resend.dev",
              to: ALERT_TO,
              subject,
              html: `<h2>Offline-conversion pipeline health</h2>
<p>One or more delivery paths appear stalled. Ingestion is unaffected; this is about delivery to Google.</p>
<pre>${JSON.stringify(report, null, 2)}</pre>
<p>First check: is the export view read timing out again? Probe safely with
<code>sync-google-sheet?dry_run=true</code> and
<code>upload-google-offline-conversions?validate_only=true</code>.
See <code>docs/pipeline-incident-2026-08/README.md</code>.</p>`,
            }),
          });
          report = { ...report, alert_emailed: true };
        } catch (emailErr) {
          console.error("health-check email error:", emailErr);
          report = { ...report, alert_emailed: false, email_error: String(emailErr) };
        }
      } else {
        report = { ...report, alert_emailed: false, email_error: "RESEND_API_KEY not set" };
      }
    }

    return new Response(JSON.stringify({ ok: true, alert, dry_run: dryRun, ...report }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("pipeline-health-check error:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
