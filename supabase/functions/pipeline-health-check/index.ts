// pipeline-health-check
//
// Guards against the Aug-2026 silent outage: the offline-conversion delivery path
// 500'd internally for days while the pg_cron job kept reporting "succeeded"
// (net.http_post only dispatches — it can't see the function's 500). Nothing
// alerted because the failing SELECT never reached the code that flips rows to
// `failed` / emails.
//
// SCOPE (post Sheet->API cutover, 2026-09-03): the Sheet is no longer a DELIVERY
// path. Google Ads' scheduled Sheet import is turned off, so the Data Manager API is
// the only thing feeding CallConvertOffline and CallXfer -- this check watches only
// that.
//
// Note `sync-google-sheet-15min` (cron jobid 3) is deliberately STILL RUNNING. It
// keeps mirroring rows to the Sheet so a rollback stays lossless (re-enable the Ads
// import and no window is missing). That is why the Sheet is not monitored here even
// though it is still writing: a Sheet fault no longer costs a conversion, and once
// the cron is eventually unscheduled `sheet_synced_at` stops filling by design, so a
// Sheet backlog would page every hour forever for no reason.
//
// To restore Sheet monitoring during a rollback, see
// docs/offline-cv-accuracy/SHEET-TO-API-READY.md — add a second backlog count filtered
// on `sheet_synced_at IS NULL` plus a max(sheet_synced_at) last-success.
//
// Three independent failure modes are checked:
//
//   1. STALL — rows the uploader SHOULD have delivered by now but hasn't, AND no
//      successful upload in the last hour. The backlog comes from the
//      offline_cv_api_backlog() RPC, which applies the SAME eligibility the
//      uploader uses (v_offline_conversion_export: Google/YouTube-sourced, has a
//      matchable identifier). Counting the base table instead over-counts wildly —
//      at cutover that was 2902 vs an actually-eligible 0, i.e. a false STALLED
//      email every hour. The RPC carries its own short statement_timeout and a
//      failure is reported as "backlog unknown" (which alerts on its own) rather
//      than 500ing the check, so a slow view still cannot take the watchdog down.
//
//   2. REJECTED — Google is ACCEPTING the connection but rejecting the events.
//      The stall check structurally cannot see this: a rejected row is marked
//      status='failed' and leaves the ready set, so the backlog drains to zero and
//      stall goes quiet while every conversion is lost. The config audit misses it
//      too — it verifies the OAuth secrets are PRESENT, not that the refresh token
//      still WORKS, so a revoked grant reports all-green while failing every upload.
//      Alerts on a sustained failure RATE (not a raw count), so the handful of
//      naturally-unmatchable rows never pages anyone, and includes the most common
//      error message so the email says what Google actually objected to.
//
//   3. MISCONFIG — the uploader is running but wired so nothing (or the wrong
//      thing) reaches Google. This is the failure mode a backlog check CANNOT see:
//      with GOOGLE_UPLOAD_ENABLED unset the uploader silently falls back to
//      dry_run, marks rows attempted, and the backlog stays flat while Google
//      receives zero conversions. Likewise a missing destination id silently
//      skips every event, and a left-on TEST_OVERRIDE quietly sends monetized
//      calls to the test action instead of CallConvertOffline. Secret VALUES are
//      never emailed — only set/unset plus a last-4 fingerprint.
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

const STALL_GRACE_MIN = 90;      // a row older than this should already be delivered (cron runs /15min)
const SUCCESS_SLA_MIN = 60;      // no success on the path in this long (with backlog) => stalled
const BACKLOG_THRESHOLD = 50;    // ignore tiny transient backlogs (~1-2 cycles of volume)
const AGE_DAYS = 85;             // matches the uploader's Google 90-day cutoff
const MAX_ATTEMPTS = 6;          // matches the uploader's retry cap
const FAILURE_WINDOW_H = 3;      // look back this far for delivery failures
const FAILURE_MIN = 10;          // floor: ignore a trickle of naturally-unmatchable rows
const FAILURE_RATE = 0.20;       // ...and only alert when this share of attempts failed
const PUBLISHER_DROP_WINDOW_H = 3;   // look back this far for publisher-gate drops
const PUBLISHER_DROP_MIN = 5;        // ignore a trickle of genuine other-publisher traffic
const ALERT_TO = "larazielin1@gmail.com";

// Report a secret as set/unset with a last-4 fingerprint — enough to tell two
// destination ids apart in an email without disclosing either one.
function fingerprint(v: string): string {
  return v ? `set(…${v.slice(-4)})` : "UNSET";
}

interface ConfigAudit {
  ok: boolean;
  problems: string[];
  snapshot: Record<string, unknown>;
}

// Mirrors upload-google-offline-conversions' own env reads (selectProvider +
// destinationFor). Supabase secrets are project-wide, so this function sees the
// exact same values the uploader does.
function auditConfig(): ConfigAudit {
  const uploadEnabled = (Deno.env.get("GOOGLE_UPLOAD_ENABLED") || "false").toLowerCase() === "true";
  const provider = (Deno.env.get("GOOGLE_UPLOAD_PROVIDER") || "dry_run").toLowerCase();
  const ccoDest = Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE") ||
    Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID") || "";
  const xferDest = Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER") || "";
  const testOverride = Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID_TEST_OVERRIDE") || "";
  const oauthConfigured = Boolean(
    Deno.env.get("GOOGLE_CLIENT_ID") &&
    Deno.env.get("GOOGLE_CLIENT_SECRET") &&
    Deno.env.get("GOOGLE_REFRESH_TOKEN"),
  );

  const problems: string[] = [];
  if (!uploadEnabled) {
    problems.push(
      "GOOGLE_UPLOAD_ENABLED is not 'true' — the uploader has silently fallen back to dry_run. " +
      "Rows are being marked as attempted but NOTHING is reaching Google Ads.",
    );
  }
  if (provider !== "data_manager") {
    problems.push(
      `GOOGLE_UPLOAD_PROVIDER="${provider}" — expected "data_manager". The uploader falls back to dry_run.`,
    );
  }
  if (!ccoDest) {
    problems.push(
      "No CallConvertOffline destination id (GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLMONETIZE) — " +
      "every monetized-call event is being skipped as skipped_no_destination.",
    );
  }
  if (!xferDest) {
    problems.push(
      "No CallXfer destination id (GOOGLE_DATA_MANAGER_DESTINATION_ID_CALLXFER) — " +
      "every transfer event is being skipped as skipped_no_destination.",
    );
  }
  if (!oauthConfigured) {
    problems.push(
      "Google OAuth secrets incomplete (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN) — " +
      "token refresh fails and every upload retries until it hits the attempt cap, then goes to 'failed'.",
    );
  }
  if (testOverride) {
    problems.push(
      "GOOGLE_DATA_MANAGER_DESTINATION_ID_TEST_OVERRIDE is SET — monetized calls are going to the " +
      "TEST action, not the real CallConvertOffline action. Unset it to resume normal delivery.",
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    snapshot: {
      upload_enabled: uploadEnabled,
      provider,
      callmonetize_destination: fingerprint(ccoDest),
      callxfer_destination: fingerprint(xferDest),
      test_override: fingerprint(testOverride),
      oauth_configured: oauthConfigured,
    },
  };
}

// Returns null when the probe itself fails — the caller alerts on that separately
// instead of letting one slow query take down the whole health check.
async function apiBacklogCount(
  supabase: ReturnType<typeof createClient>,
): Promise<number | null> {
  // The RPC isn't in the generated DB types (there are none in this project), so
  // supabase-js infers its args as `undefined`. Cast the ARGS at the call site rather
  // than aliasing supabase.rpc into a local — an alias drops the `this` binding and
  // throws "Cannot read properties of undefined (reading 'rest')" at runtime.
  const { data, error } = await supabase.rpc(
    "offline_cv_api_backlog",
    {
      grace_minutes: STALL_GRACE_MIN,
      age_days: AGE_DAYS,
      max_attempts: MAX_ATTEMPTS,
    } as unknown as undefined,
  );
  if (error) {
    console.error("backlog probe failed:", error.message);
    return null;
  }
  return typeof data === "number" ? data : Number(data ?? 0);
}

interface FailureStats {
  failed: number;
  uploaded: number;
  topError: string | null;
  topErrorCount: number;
}

// Delivery failures vs successes over the recent window. Returns null if the probe
// itself fails, same contract as apiBacklogCount.
async function failureStats(
  supabase: ReturnType<typeof createClient>,
): Promise<FailureStats | null> {
  const { data, error } = await supabase.rpc(
    "offline_cv_failure_stats",
    { window_hours: FAILURE_WINDOW_H } as unknown as undefined,
  );
  if (error) {
    console.error("failure probe failed:", error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return { failed: 0, uploaded: 0, topError: null, topErrorCount: 0 };
  return {
    failed: Number(row.failed_count ?? 0),
    uploaded: Number(row.uploaded_count ?? 0),
    topError: (row.top_error as string | null) ?? null,
    topErrorCount: Number(row.top_error_count ?? 0),
  };
}

// 4. PUBLISHER-DROPPED — the cutover failure mode nothing else can see.
//
// Both webhooks hard-drop any event whose `publisher` is not exactly 'NBA':
// api_logs row, HTTP 200, no retry, no email. That is correct for other
// publishers' traffic, but during the Ringba->Caliber migration it is also
// exactly what a Caliber pixel looks like when its publisher token resolves to
// something else (or does not resolve at all). Every Energy event would vanish
// on day one with no backlog, no failure and no symptom anywhere — the stall
// and rejection checks structurally cannot see it, because the rows never
// existed to begin with.
//
// Returns null if the probe itself fails, matching the other probes' contract.
async function publisherDrops(
  supabase: ReturnType<typeof createClient>,
  sinceIso: string,
): Promise<{ count: number; values: string[] } | null> {
  const { data, error } = await supabase
    .from("api_logs")
    .select("response_payload")
    .gte("created_at", sinceIso)
    .eq("response_payload->>reason", "non-nba-publisher")
    .limit(500);
  if (error) {
    console.error("publisher-drop probe failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as Array<{ response_payload: Record<string, unknown> | null }>;
  const values = new Set<string>();
  for (const r of rows) {
    const p = r.response_payload?.publisher;
    values.add(p === null || p === undefined || p === "" ? "(empty)" : String(p));
  }
  return { count: rows.length, values: [...values].slice(0, 10) };
}

async function lastUploadSuccess(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const { data, error } = await supabase.from("offline_conversion_events")
    .select("uploaded_at").not("uploaded_at", "is", null)
    .order("uploaded_at", { ascending: false }).limit(1);
  if (error) throw new Error(`lastSuccess(uploaded_at): ${error.message}`);
  return (data && data[0] ? (data[0] as Record<string, string>).uploaded_at : null) ?? null;
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
  const slaIso = new Date(now - SUCCESS_SLA_MIN * 60000).toISOString();

  let report: Record<string, unknown>;
  try {
    const config = auditConfig();
    const dropWindowIso = new Date(now - PUBLISHER_DROP_WINDOW_H * 3600000).toISOString();
    const [backlog, lastUpload, failures, drops] = await Promise.all([
      apiBacklogCount(supabase),
      lastUploadSuccess(supabase),
      failureStats(supabase),
      publisherDrops(supabase, dropWindowIso),
    ]);

    // `config` stays a pure audit of the environment. Runtime faults (probe failures,
    // rejections) go in `problems` alongside it, so config.ok never reads `true` next to
    // a listed problem.
    const problems: string[] = [...config.problems];

    // An unknown backlog is itself a fault (we are blind), but it is NOT a stall.
    const backlogUnknown = backlog === null;
    if (backlogUnknown) {
      problems.push(
        "Backlog probe offline_cv_api_backlog() failed — the export view may be timing out again " +
        "(see docs/pipeline-incident-2026-08/README.md). Delivery may be fine; we cannot currently tell.",
      );
    }
    const stalled = !backlogUnknown && backlog >= BACKLOG_THRESHOLD && (!lastUpload || lastUpload < slaIso);

    // Google is rejecting us: enough failures to be real, AND a high share of attempts.
    // Rate (not count) so a busy healthy day can't out-scale the threshold, and the floor
    // so a couple of unmatchable rows on a quiet night can't trip it.
    const failureAttempts = failures ? failures.failed + failures.uploaded : 0;
    const failureRate = failureAttempts > 0 ? (failures as FailureStats).failed / failureAttempts : 0;
    const rejecting = Boolean(
      failures && failures.failed >= FAILURE_MIN && failureRate >= FAILURE_RATE,
    );
    if (failures === null) {
      problems.push(
        "Failure probe offline_cv_failure_stats() failed — cannot tell whether Google is " +
        "rejecting uploads.",
      );
    } else if (rejecting) {
      problems.push(
        `Google is REJECTING uploads: ${failures.failed} of ${failureAttempts} attempts in the ` +
        `last ${FAILURE_WINDOW_H}h failed (${Math.round(failureRate * 100)}%). These rows are marked ` +
        "'failed' and will NOT be retried, so they are lost unless requeued. Most common error: " +
        `${failures.topError ?? "(none recorded)"}${failures.topErrorCount ? ` (x${failures.topErrorCount})` : ""}. ` +
        "Most likely causes: the Google OAuth grant was revoked/expired, or the destination id " +
        "no longer points at a live conversion action.",
      );
    }

    // Publisher-gate drops. Note this alerts on ANY sustained drop, including
    // legitimate other-publisher traffic — during a migration a quiet gate is
    // worth more than a quiet inbox, and the email names the values received so
    // it takes seconds to tell "Caliber is misconfigured" from "not our call".
    if (drops === null) {
      problems.push(
        "Publisher-drop probe failed — cannot tell whether events are being dropped at the " +
        "publisher gate. During the Caliber cutover this is the failure mode with no other symptom.",
      );
    } else if (drops.count >= PUBLISHER_DROP_MIN) {
      problems.push(
        `${drops.count} event(s) DROPPED at the publisher gate in the last ${PUBLISHER_DROP_WINDOW_H}h ` +
        `(publisher must be exactly 'NBA'; received: ${drops.values.join(", ")}). ` +
        "These never became rows: no backlog, no failure, nothing to retry. If a value here looks " +
        "like a Caliber publisher name or is (empty), a migrated pixel is misconfigured and every " +
        "event from it is being lost silently — map the value or fix the token at source.",
      );
    }
    const publisherDropping = drops !== null && drops.count >= PUBLISHER_DROP_MIN;

    report = {
      checked_at: new Date(now).toISOString(),
      problems,
      publisher_gate: drops === null
        ? { probe: "failed" }
        : {
            window_hours: PUBLISHER_DROP_WINDOW_H,
            dropped: drops.count,
            values_received: drops.values,
            dropping: publisherDropping,
          },
      api: { backlog, last_success: lastUpload, stalled },
      delivery: failures === null ? { probe: "failed" } : {
        window_hours: FAILURE_WINDOW_H,
        failed: failures.failed,
        uploaded: failures.uploaded,
        failure_rate: Number(failureRate.toFixed(3)),
        top_error: failures.topError,
        top_error_count: failures.topErrorCount,
        rejecting,
      },
      config,
      thresholds: {
        stall_grace_min: STALL_GRACE_MIN,
        success_sla_min: SUCCESS_SLA_MIN,
        backlog_threshold: BACKLOG_THRESHOLD,
        age_days: AGE_DAYS,
        failure_window_h: FAILURE_WINDOW_H,
        failure_min: FAILURE_MIN,
        failure_rate: FAILURE_RATE,
      },
    };

    const alert = stalled || rejecting || backlogUnknown || failures === null ||
      publisherDropping || drops === null || !config.ok;
    if ((alert || force) && !dryRun) {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (resendKey) {
        const parts: string[] = [];
        if (stalled) parts.push("delivery STALLED");
        if (rejecting) parts.push("Google REJECTING uploads");
        if (backlogUnknown) parts.push("BACKLOG UNKNOWN");
        if (publisherDropping) parts.push("PUBLISHER-GATE DROPS");
        if (!config.ok) parts.push("MISCONFIGURED");
        const subject = force && !alert
          ? "NBA offline-conversion health check — TEST (healthy)"
          : `⚠️ NBA offline conversions (Data Manager API) — ${parts.join(" + ")}`;
        const problemHtml = problems.length
          ? `<h3>What's wrong</h3><ul>${problems.map((p) => `<li>${p}</li>`).join("")}</ul>`
          : "";
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "onboarding@resend.dev",
              to: ALERT_TO,
              subject,
              html: `<h2>Offline-conversion pipeline health (Data Manager API)</h2>
<p>The Data Manager API is the sole delivery path to Google Ads. Ingestion (Ringba/Caliber
webhooks) is unaffected by anything below; this is about delivery to Google.</p>
${problemHtml}
<pre>${JSON.stringify(report, null, 2)}</pre>
<p>First checks: probe the uploader safely with
<code>upload-google-offline-conversions?validate_only=true</code> (sends validateOnly to Google,
writes nothing). If that is clean, the export view read may be timing out again — see
<code>docs/pipeline-incident-2026-08/README.md</code>. Per-day delivery counts:
<code>select * from v_offline_cv_upload_daily order by conversion_day_et desc limit 14;</code></p>`,
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
