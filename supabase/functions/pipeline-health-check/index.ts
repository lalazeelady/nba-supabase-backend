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
// CUSTOMER MATCH (added Sep 2026): a fourth, independent section watches the
//   audience pipeline (upload-google-customer-match). It is ENTIRELY SILENT unless
//   GOOGLE_CUSTOMER_MATCH_ENABLED=true, so building and dry-running that pipeline
//   cannot page anyone. It is also strictly additive: every offline-conversion check
//   above is untouched, and a Customer Match fault never changes what those report.
//   Members parked at 'awaiting_destination' (a program whose Google audience does
//   not exist yet) are excluded by cm_upload_backlog() — an unconfigured program is
//   a to-do, not an outage.
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
const SAVE_FAIL_WINDOW_H = 1;        // look back this far for saves that failed
const SAVE_FAIL_MIN = 1;             // a single lost lead or postback is worth an email
const CM_GRACE_H = 48;           // the CM cron is DAILY, so 48h = two missed runs
const CM_BACKLOG_THRESHOLD = 100;// ignore a small queue between daily runs
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

interface CustomerMatchAudit {
  enabled: boolean;
  ok: boolean;
  problems: string[];
  snapshot: Record<string, unknown>;
}

// Mirrors upload-google-customer-match's own env reads. Returns enabled:false and NO
// problems while the pipeline is off, so nothing here can page during dry-run work.
function auditCustomerMatch(): CustomerMatchAudit {
  const enabled = (Deno.env.get("GOOGLE_CUSTOMER_MATCH_ENABLED") || "false").toLowerCase() === "true";
  const audiences: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (k.startsWith("GOOGLE_CM_AUDIENCE_ID_") && (v || "").trim()) {
      audiences[k.slice("GOOGLE_CM_AUDIENCE_ID_".length).toLowerCase()] = v.trim();
    }
  }
  const oauthConfigured = Boolean(
    Deno.env.get("GOOGLE_CLIENT_ID") &&
    Deno.env.get("GOOGLE_CLIENT_SECRET") &&
    Deno.env.get("GOOGLE_REFRESH_TOKEN"),
  );

  const problems: string[] = [];
  if (enabled) {
    if (!audiences["all"]) {
      problems.push(
        "GOOGLE_CUSTOMER_MATCH_ENABLED is 'true' but GOOGLE_CM_AUDIENCE_ID_ALL is UNSET — " +
        "every monetized caller is being parked at 'awaiting_destination' and NOTHING is " +
        "reaching the universal Customer Match audience.",
      );
    }
    if (!Deno.env.get("GOOGLE_ADS_CUSTOMER_ID")) {
      problems.push(
        "GOOGLE_ADS_CUSTOMER_ID is UNSET — the Customer Match uploader cannot build a " +
        "destination and every batch fails as retryable until the attempt cap.",
      );
    }
    if (!oauthConfigured) {
      problems.push(
        "Google OAuth secrets incomplete — Customer Match batches retry until the attempt cap, " +
        "then go to 'failed'.",
      );
    }
  }

  return {
    enabled,
    ok: problems.length === 0,
    problems,
    snapshot: {
      enabled,
      audiences: Object.fromEntries(
        Object.entries(audiences).map(([k, v]) => [k, fingerprint(v)]),
      ),
      oauth_configured: oauthConfigured,
    },
  };
}

interface CustomerMatchBacklog {
  audience_key: string;
  pending: number;
  oldest_pending: string | null;
}

// Same contract as apiBacklogCount: null means the probe itself failed.
async function customerMatchBacklog(
  supabase: ReturnType<typeof createClient>,
): Promise<CustomerMatchBacklog[] | null> {
  const { data, error } = await supabase.rpc(
    "cm_upload_backlog",
    { grace_hours: CM_GRACE_H, max_attempts: MAX_ATTEMPTS } as unknown as undefined,
  );
  if (error) {
    console.error("customer-match backlog probe failed:", error.message);
    return null;
  }
  return (data ?? []) as unknown as CustomerMatchBacklog[];
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

// 5. FAILED SAVES — a lead or a postback that could not be written at all.
//
// The 9/11 and 9/14 outages lost 120 leads and 62 postbacks with no alert: the
// webhooks answered 200 and submit-lead answered 500, and the only trace was in the
// function logs. Both now leave an api_logs row (webhooks: success=false with
// "insert failed"; submit-lead: api_type='lead-save-failed'), and this probe turns
// those rows into an email within the hour.
//
// Reads api_logs by created_at — index api_logs_created_at_brin_idx keeps that cheap
// on an 847 MB table. Returns null if the probe itself fails, like the other probes.
async function failedSaves(
  supabase: ReturnType<typeof createClient>,
  sinceIso: string,
): Promise<{ count: number; kinds: string[] } | null> {
  const { data, error } = await supabase
    .from("api_logs")
    .select("api_type, error_message")
    .gte("created_at", sinceIso)
    .eq("success", false)
    .limit(500);
  if (error) {
    console.error("failed-save probe failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as Array<{ api_type: string | null; error_message: string | null }>;
  // success=false also covers CRM rejections (lead-to-ct / lead-to-caliber), which are
  // a different problem with their own email. Count only rows that mean "we could not
  // store it".
  const saves = rows.filter((r) =>
    (r.api_type ?? "") === "lead-save-failed" ||
    /insert failed/i.test(r.error_message ?? "")
  );
  const kinds = new Set<string>();
  for (const r of saves) kinds.add(r.api_type ?? "webhook-insert");
  return { count: saves.length, kinds: [...kinds].slice(0, 6) };
}

// 6. POSTBACK PIPELINE (postbacks / platform_uploads, added 2026-09-17). The SQL function
// postback_health() decides the problems (no postbacks in weekday business hours, match-rate
// drop, failed upload checks or uploads, stuck uploads while live) so the rules live next to
// the tables. Returns null if the probe itself fails, like the other probes.
async function postbackHealth(
  supabase: ReturnType<typeof createClient>,
  uploadsLive: boolean,
): Promise<{ problems: string[]; [k: string]: unknown } | null> {
  const { data, error } = await supabase.rpc(
    "postback_health",
    { p_uploads_live: uploadsLive } as unknown as undefined,
  );
  if (error) {
    console.error("postback health probe failed:", error.message);
    return null;
  }
  const out = (data ?? {}) as { problems?: string[]; [k: string]: unknown };
  return { ...out, problems: Array.isArray(out.problems) ? out.problems : [] };
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
    const cmConfig = auditCustomerMatch();
    const saveWindowIso = new Date(now - SAVE_FAIL_WINDOW_H * 3600000).toISOString();
    const postbackUploadsLive =
      (Deno.env.get("GOOGLE_POSTBACK_UPLOAD_MODE") || "validate_only").toLowerCase() === "live" &&
      (Deno.env.get("GOOGLE_POSTBACK_LIVE_OFFERS") || "").trim() !== "";
    const [backlog, lastUpload, failures, drops, saves, cmBacklog, postbacks] = await Promise.all([
      apiBacklogCount(supabase),
      lastUploadSuccess(supabase),
      failureStats(supabase),
      publisherDrops(supabase, dropWindowIso),
      failedSaves(supabase, saveWindowIso),
      // Probed only when the audience pipeline is live. While it is off this stays
      // null-by-choice and contributes nothing to `problems` or `alert`.
      cmConfig.enabled ? customerMatchBacklog(supabase) : Promise.resolve([]),
      postbackHealth(supabase, postbackUploadsLive),
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

    // Failed saves: a lead or postback that never reached the database. Unlike every
    // other check here this is about INGESTION, not delivery to Google.
    if (saves === null) {
      problems.push(
        "Failed-save probe failed — cannot tell whether leads or postbacks are failing to " +
        "save. This is the check that covers the 9/11 and 9/14 loss pattern.",
      );
    } else if (saves.count >= SAVE_FAIL_MIN) {
      problems.push(
        `${saves.count} lead(s)/postback(s) FAILED TO SAVE in the last ${SAVE_FAIL_WINDOW_H}h ` +
        `(${saves.kinds.join(", ")}). These are lost unless the sender retries: the webhooks ` +
        "answer 5xx only on the postback-* endpoints, and submit-lead answers 500 to the funnel " +
        "while the visitor still sees the thank-you page. Check the database health first.",
      );
    }
    const savesFailing = saves !== null && saves.count >= SAVE_FAIL_MIN;

    // Postback pipeline (postbacks / platform_uploads).
    if (postbacks === null) {
      problems.push("Postback pipeline probe postback_health() failed — cannot tell whether Caliber postbacks are arriving, matching or uploading.");
    } else {
      problems.push(...postbacks.problems.map((p) => `Postbacks: ${p}`));
    }
    const postbacksAlert = postbacks === null || postbacks.problems.length > 0;

    // ---- Customer Match (independent, silent while disabled) ----------------
    // Appended AFTER the offline-conversion problems so the existing report reads
    // identically when the audience pipeline is off.
    problems.push(...cmConfig.problems);

    const cmProbeFailed = cmConfig.enabled && cmBacklog === null;
    if (cmProbeFailed) {
      problems.push(
        "Customer Match backlog probe cm_upload_backlog() failed — cannot tell whether audience " +
        "members are being delivered.",
      );
    }
    const cmStalledAudiences = (cmBacklog ?? []).filter((b) => b.pending >= CM_BACKLOG_THRESHOLD);
    if (cmConfig.enabled && cmStalledAudiences.length > 0) {
      problems.push(
        `Customer Match delivery STALLED: ${cmStalledAudiences
          .map((b) => `${b.audience_key}=${b.pending} pending (oldest ${b.oldest_pending ?? "?"})`)
          .join("; ")}. These people were queued more than ${CM_GRACE_H}h ago and the daily ` +
        "uploader has not delivered them. Probe safely with " +
        "upload-google-customer-match?validate_only=true.",
      );
    }
    const cmAlert = cmConfig.enabled &&
      (!cmConfig.ok || cmProbeFailed || cmStalledAudiences.length > 0);

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
      postbacks: postbacks === null ? { probe: "failed" } : postbacks,
      saves: saves === null
        ? { probe: "failed" }
        : { window_hours: SAVE_FAIL_WINDOW_H, failed: saves.count, kinds: saves.kinds },
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
      customer_match: {
        ...cmConfig.snapshot,
        probe: cmProbeFailed ? "failed" : "ok",
        backlog: cmConfig.enabled ? (cmBacklog ?? null) : "not_enabled",
        stalled: cmStalledAudiences.length > 0,
      },
      thresholds: {
        stall_grace_min: STALL_GRACE_MIN,
        success_sla_min: SUCCESS_SLA_MIN,
        backlog_threshold: BACKLOG_THRESHOLD,
        age_days: AGE_DAYS,
        failure_window_h: FAILURE_WINDOW_H,
        failure_min: FAILURE_MIN,
        save_fail_window_h: SAVE_FAIL_WINDOW_H,
        save_fail_min: SAVE_FAIL_MIN,
        failure_rate: FAILURE_RATE,
        cm_grace_h: CM_GRACE_H,
        cm_backlog_threshold: CM_BACKLOG_THRESHOLD,
      },
    };

    const alert = stalled || rejecting || backlogUnknown || failures === null ||
      publisherDropping || drops === null || savesFailing || saves === null ||
      postbacksAlert || !config.ok || cmAlert;
    if ((alert || force) && !dryRun) {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (resendKey) {
        const parts: string[] = [];
        if (stalled) parts.push("delivery STALLED");
        if (rejecting) parts.push("Google REJECTING uploads");
        if (backlogUnknown) parts.push("BACKLOG UNKNOWN");
        if (publisherDropping) parts.push("PUBLISHER-GATE DROPS");
        if (savesFailing) parts.push("FAILED SAVES");
        if (postbacksAlert) parts.push("POSTBACKS");
        if (!config.ok) parts.push("MISCONFIGURED");
        if (cmAlert) parts.push("CUSTOMER MATCH");
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
