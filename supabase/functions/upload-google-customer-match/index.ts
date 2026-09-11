// upload-google-customer-match
//
// Feeds Google Ads Customer Match audiences from Supabase, replacing the manual
// "NBA Google Customer Match" Google Sheet. It is the audience counterpart of
// `upload-google-offline-conversions` and follows the same shape on purpose: same
// OAuth flow, same x-invoke-secret auth, same api_logs row, same
// success/retryable/permanent outcome model.
//
// WHAT IT SENDS
//   POST https://datamanager.googleapis.com/v1/audienceMembers:ingest
//   Members are identified by hashed email, hashed phone, and a hashed
//   name + plaintext zip/country block. Google ORs them for the best match rate.
//
// MEMBERSHIP — NOT the offline-conversion rule
//   Every monetized caller with revenue, from EVERY source. There is no
//   Google/YouTube deny-list here: a conversion may only be reported to the channel
//   that earned it, but a customer is a customer whoever sent them. This function
//   never reads v_offline_conversion_export, so the deny-list and this pipeline
//   cannot affect each other.
//
// ROUTING — one audience per program, discovered from the environment
//   GOOGLE_CM_AUDIENCE_ID_ALL=9470111997     -> audience_key 'all'  (the universal list)
//   GOOGLE_CM_AUDIENCE_ID_ACA=...            -> audience_key 'aca'
//   GOOGLE_CM_AUDIENCE_ID_ENERGY=...         -> audience_key 'energy'
//   The suffix, lowercased, IS the audience_key. Adding a program is a new secret,
//   never a code change. Members of an audience with no id configured are parked at
//   'awaiting_destination' (the health check ignores that status) and release
//   themselves on the next run once the secret appears.
//
// WHY THE REFRESH RPC EXISTS
//   The person-level rollup measures ~15s on this instance and service_role has an
//   8s statement_timeout, so it lives in refresh_customer_match_members() which
//   carries its own raised timeout. This function must never aggregate; it only does
//   indexed reads from v_customer_match_upload_queue.
//
// SAFETY
//   GOOGLE_CUSTOMER_MATCH_ENABLED is SEPARATE from GOOGLE_UPLOAD_ENABLED, so nothing
//   here can disturb offline-conversion uploads. Unset/false = dry run: the payload
//   is logged, nothing reaches Google, and no member is marked uploaded.
//
// Auth: shared secret in x-invoke-secret (UPLOADER_INVOKE_SECRET).
// Params: ?validate_only=true  — ask Google to validate the payload and record NO
//                                outcome. Queue maintenance (the rollup, and
//                                releasing parked members) still runs, because
//                                without it there would be nothing to validate.
//         ?limit=N             — cap members considered this run
//         ?skip_refresh=true   — skip the rollup (use the ledger as it stands)
//         ?refresh_only=true   — run the rollup and return, upload nothing

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

const DATA_MANAGER_ENDPOINT = Deno.env.get("GOOGLE_CM_ENDPOINT") ||
  "https://datamanager.googleapis.com/v1/audienceMembers:ingest";

// Google's hard cap is 10,000 members per request. 5,000 keeps the JSON body near
// 1.5MB and leaves headroom in the edge runtime; raise via GOOGLE_CM_BATCH_SIZE.
const BATCH_SIZE = Math.min(
  10_000,
  Number(Deno.env.get("GOOGLE_CM_BATCH_SIZE")) || 5_000,
);
const DEFAULT_LIMIT = 100_000;   // the whole backfill fits in one invocation
const MAX_ATTEMPTS = 6;
const AUDIENCE_ENV_PREFIX = "GOOGLE_CM_AUDIENCE_ID_";

// PostgREST caps EVERY response at db-max-rows (1,000 on this project) and does so
// SILENTLY — `.limit(10000)` returns 1,000 rows with no error and no indication the
// result was truncated. DECISIONS.md records the same trap for the reporting script.
//
// This is not merely a backfill inconvenience. Without paging, the nightly job would
// deliver at most 1,000 people per run, forever, and report success every time: a
// burst or a re-queue would drain in slow motion with no symptom anywhere. That is
// the silent-stall class this whole pipeline is built to avoid.
const PAGE_SIZE = 1_000;

const QUEUE_COLUMNS =
  "member_id, audience_key, member_key, upload_attempts, phone_e164, email, " +
  "first_name, last_name, zip, state, country";

interface QueueRow {
  member_id: string;
  audience_key: string;
  member_key: string;
  upload_attempts: number | null;
  phone_e164: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  zip: string | null;
  state: string | null;
  country: string | null;
}

type UploadOutcome =
  | { kind: "uploaded"; response: unknown }
  | { kind: "retryable"; error: unknown }
  | { kind: "permanent"; error: unknown };

// ---- OAuth ----------------------------------------------------------------
// Same refresh-token flow and same secrets as the conversion uploader. The token
// already carries the datamanager scope, which covers audienceMembers.

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google OAuth not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing.",
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth refresh failed: ${res.status} ${await res.text()}`);

  const json = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return cachedToken.token;
}

// ---- Normalization & hashing ----------------------------------------------
//
// Per https://developers.google.com/data-manager/api/devguides/concepts/formatting.
// Hashed: email, phone, given name, family name. Plaintext: postal code, region code.
// Hashes are SHA-256, hex-encoded, signalled once per request via encoding:"HEX".
//
// NOTE: this is a FULLER normalization than the conversion uploader's, which
// lowercases the email and stops. Google also wants whitespace stripped, and for
// gmail/googlemail the dots removed from the local part and any "+tag" dropped.
// Match quality is the entire point of an audience, so the complete rules are applied
// here. The SQL helper normalize_email_for_google() is likewise partial (gmail dots
// only) and is deliberately NOT reused — changing it would alter the offline
// conversion path.

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip ALL whitespace, including interior, then lowercase.
  const e = String(raw).replace(/\s+/g, "").toLowerCase();
  // Exactly one "@", and something either side. Guards against "a@b@gmail.com"
  // being rewritten into a valid-looking gmail address.
  const parts = e.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let [local, domain] = parts;
  if (!domain.includes(".")) return null;

  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

// E.164. The member key is already a NANP 10-digit string from cm_phone10(), so the
// queue's phone_e164 is always well-formed; this stays defensive for safety.
function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  return t || null;
}

// US postal code, plaintext. Junk like a city name in the zip column (which the old
// Sheet demonstrably contained) yields null, and the member simply uploads without
// the address block.
function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  return d.length >= 5 ? d.slice(0, 5) : null;
}

// Google ORs these entries, so more identifiers means a better match rate. The
// address block needs all of given name + family name + postal code; a partial block
// is dropped rather than sent incomplete.
async function buildUserIdentifiers(row: QueueRow): Promise<Array<Record<string, unknown>>> {
  const ids: Array<Record<string, unknown>> = [];

  const email = normalizeEmail(row.email);
  if (email) ids.push({ emailAddress: await sha256Hex(email) });

  const phone = normalizePhoneE164(row.phone_e164);
  if (phone) ids.push({ phoneNumber: await sha256Hex(phone) });

  const first = normalizeName(row.first_name);
  const last = normalizeName(row.last_name);
  const zip = normalizeZip(row.zip);
  const country = (row.country || "US").trim().toUpperCase();
  if (first && last && zip) {
    ids.push({
      address: {
        givenName: await sha256Hex(first),
        familyName: await sha256Hex(last),
        postalCode: zip,
        regionCode: country,
      },
    });
  }

  return ids;
}

// ---- Audience routing ------------------------------------------------------
//
// Read every GOOGLE_CM_AUDIENCE_ID_* secret and map suffix -> audience_key. This is
// why adding a program never needs a code change.
function audienceMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (!key.startsWith(AUDIENCE_ENV_PREFIX)) continue;
    const id = (value || "").trim();
    if (!id) continue;
    map[key.slice(AUDIENCE_ENV_PREFIX.length).toLowerCase()] = id;
  }
  return map;
}

// ---- Google call -----------------------------------------------------------

async function ingestBatch(
  audienceId: string,
  members: Array<Record<string, unknown>>,
  validateOnly: boolean,
): Promise<UploadOutcome> {
  const operatingAccountId = Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "";
  const loginAccountId = Deno.env.get("GOOGLE_LOGIN_CUSTOMER_ID") || "";
  if (!operatingAccountId) {
    return { kind: "retryable", error: { message: "GOOGLE_ADS_CUSTOMER_ID missing" } };
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken();
  } catch (e) {
    return { kind: "retryable", error: { message: String(e) } };
  }

  const destination: Record<string, unknown> = {
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: operatingAccountId },
    productDestinationId: audienceId,   // the Google Ads List ID from Audience manager
  };
  // loginAccount is required when the OAuth user reaches the operating account
  // through a manager (MCC). Both use accountType GOOGLE_ADS.
  if (loginAccountId) {
    destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: loginAccountId };
  }

  const body = {
    destinations: [destination],
    audienceMembers: members,
    encoding: "HEX",
    // Required whenever UserData is ingested. The account has accepted Customer
    // Match terms; this asserts that per request.
    termsOfService: { customerMatchTermsOfServiceStatus: "ACCEPTED" },
    // NBA runs US traffic only and every lead carries TCPA consent, so consent is
    // granted. Override with GOOGLE_CM_CONSENT=denied if that ever changes.
    consent: {
      adUserData: consentValue(),
      adPersonalization: consentValue(),
    },
    validateOnly,
  };

  let res: Response;
  try {
    res = await fetch(DATA_MANAGER_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { kind: "retryable", error: { message: `network: ${String(e)}` } };
  }

  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }

  if (res.ok) {
    // Success is { requestId, fieldWarnings? }. Warnings are per-field advisories
    // (e.g. an identifier Google could not parse) and do NOT fail the batch, but we
    // keep them on the row so a match-rate problem is diagnosable later.
    return { kind: "uploaded", response: json };
  }
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    return { kind: "retryable", error: { status: res.status, body: json } };
  }
  return { kind: "permanent", error: { status: res.status, body: json } };
}

function consentValue(): string {
  return (Deno.env.get("GOOGLE_CM_CONSENT") || "granted").toLowerCase() === "denied"
    ? "CONSENT_DENIED"
    : "CONSENT_GRANTED";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- Handler ---------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const validateOnly = url.searchParams.get("validate_only") === "true";
  const skipRefresh = url.searchParams.get("skip_refresh") === "true";
  const refreshOnly = url.searchParams.get("refresh_only") === "true";
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;

  // Dry run unless explicitly enabled. This flag is SEPARATE from
  // GOOGLE_UPLOAD_ENABLED so Customer Match can never disturb conversion uploads.
  const enabled = (Deno.env.get("GOOGLE_CUSTOMER_MATCH_ENABLED") || "false").toLowerCase() === "true";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const counters = {
    members_added: 0,
    master_rows: 0,
    considered: 0,
    uploaded: 0,
    retryable: 0,
    permanent: 0,
    dry_run: 0,
    skipped_no_identifier: 0,
    parked_no_destination: 0,
    released: 0,
    batches: 0,
  };
  // Named separately from the counters so the response can always SAY which
  // audiences had no Google List ID — a bare "batches: 0" is not a diagnosis.
  const audiencesWithoutDestination: string[] = [];

  // 1. Roll up the master and queue anyone newly monetized. This RPC carries its own
  //    raised statement_timeout; see the migration header for why that is required.
  if (!skipRefresh) {
    const { data, error } = await supabase.rpc("refresh_customer_match_members");
    if (error) {
      console.error("refresh_customer_match_members failed:", error);
      return json({ error: `refresh failed: ${error.message}` }, 500);
    }
    const row = Array.isArray(data) ? data[0] : data;
    counters.members_added = Number(row?.members_added ?? 0);
    counters.master_rows = Number(row?.master_rows ?? 0);
  }
  if (refreshOnly) {
    return json({ ok: true, refresh_only: true, ...counters });
  }

  // 2. Any audience that now HAS an id releases its parked members automatically.
  const audiences = audienceMap();
  for (const key of Object.keys(audiences)) {
    const { data, error } = await supabase.rpc("cm_release_awaiting", { p_audience_key: key });
    if (error) console.error(`cm_release_awaiting(${key}) failed:`, error);
    else counters.released += Number(data ?? 0);
  }

  // 3. Read the pending queue, PAGED. Indexed join only — no aggregation here.
  //
  // Ordering is (first_seen_at, member_id), not first_seen_at alone. The backfill
  // inserted all 63,765 rows in ONE transaction, so they share an identical
  // first_seen_at — ordering by it alone is non-deterministic, and offset paging over
  // a non-deterministic order silently skips and duplicates rows. member_id (the uuid
  // primary key) is the unique tiebreaker that makes the order total.
  //
  // The whole page set is read BEFORE anything is uploaded, so the pending set cannot
  // shift underneath the offsets mid-read.
  const rows: QueueRow[] = [];
  for (let from = 0; rows.length < limit; from += PAGE_SIZE) {
    const want = Math.min(PAGE_SIZE, limit - rows.length);
    const { data: page, error: queueErr } = await supabase
      .from("v_customer_match_upload_queue")
      .select(QUEUE_COLUMNS)
      .lt("upload_attempts", MAX_ATTEMPTS)
      .order("first_seen_at", { ascending: true })
      .order("member_id", { ascending: true })
      .range(from, from + want - 1);

    if (queueErr) {
      console.error("queue select failed:", queueErr);
      return json({ error: queueErr.message }, 500);
    }
    const got = (page ?? []) as unknown as QueueRow[];
    rows.push(...got);
    // A short page means the queue is exhausted. Also guards against an empty first
    // page turning the loop infinite.
    if (got.length < want) break;
  }
  counters.considered = rows.length;

  // 4. Group by audience — each audience is its own Google destination.
  const byAudience = new Map<string, QueueRow[]>();
  for (const row of rows) {
    const list = byAudience.get(row.audience_key) ?? [];
    list.push(row);
    byAudience.set(row.audience_key, list);
  }

  const validateResults: Array<Record<string, unknown>> = [];

  for (const [audienceKey, audienceRows] of byAudience) {
    const audienceId = audiences[audienceKey];

    // No Google List ID for this program yet. Park the whole audience so the health
    // check stays quiet; cm_release_awaiting() brings them back when the secret
    // appears. Never treat this as a failure.
    if (!audienceId) {
      audiencesWithoutDestination.push(audienceKey);
      if (!validateOnly) {
        const { data, error } = await supabase.rpc("cm_mark_awaiting", { p_audience_key: audienceKey });
        if (error) console.error(`cm_mark_awaiting(${audienceKey}) failed:`, error);
        else counters.parked_no_destination += Number(data ?? 0);
      }
      continue;
    }

    // Build identifiers. member_key is a NANP phone, so an empty identifier set is
    // effectively impossible — but a row with nothing to match on would be rejected
    // by Google for the whole batch, so it is removed here rather than risked.
    const usable: Array<{ id: string; member: Record<string, unknown> }> = [];
    const unusable: string[] = [];
    for (const row of audienceRows) {
      const userIdentifiers = await buildUserIdentifiers(row);
      if (userIdentifiers.length === 0) {
        unusable.push(row.member_id);
        continue;
      }
      usable.push({ id: row.member_id, member: { userData: { userIdentifiers } } });
    }

    if (unusable.length > 0 && !validateOnly) {
      counters.skipped_no_identifier += unusable.length;
      await supabase.rpc("cm_record_outcome", {
        p_ids: unusable,
        p_outcome: "permanent",
        p_audience_id: audienceId,
        p_payload: { message: "No matchable identifier for this member" },
        p_max_attempts: MAX_ATTEMPTS,
      });
    }

    for (const batch of chunk(usable, BATCH_SIZE)) {
      counters.batches++;
      const ids = batch.map((b) => b.id);
      const members = batch.map((b) => b.member);

      // Dry run: log the shape and STOP. Attempts are deliberately NOT incremented
      // — the conversion uploader does increment them, which means six dry runs
      // silently push a row past MAX_ATTEMPTS and out of the eligible set forever.
      // See docs/customer-match/ORPHANS-customer-match.md §6.
      if (!enabled) {
        counters.dry_run += ids.length;
        console.log("[dry_run] would ingest:", JSON.stringify({
          audience_key: audienceKey,
          audience_id: audienceId,
          members: ids.length,
          sample_identifier_count: members[0]
            ? ((members[0] as { userData: { userIdentifiers: unknown[] } }).userData.userIdentifiers).length
            : 0,
        }));
        continue;
      }

      const outcome = await ingestBatch(audienceId, members, validateOnly);

      if (validateOnly) {
        validateResults.push({
          audience_key: audienceKey,
          audience_id: audienceId,
          members: ids.length,
          outcome,
        });
        continue;
      }

      if (outcome.kind === "uploaded") counters.uploaded += ids.length;
      else if (outcome.kind === "permanent") counters.permanent += ids.length;
      else counters.retryable += ids.length;

      await supabase.rpc("cm_record_outcome", {
        p_ids: ids,
        p_outcome: outcome.kind,
        p_audience_id: audienceId,
        p_payload: (outcome.kind === "uploaded" ? outcome.response : outcome.error) as object,
        p_max_attempts: MAX_ATTEMPTS,
      });

      await logAttempt(supabase as unknown as InsertableClient, audienceKey, audienceId, ids.length, outcome);
    }
  }

  // Always report the configuration the run actually saw. Audience IDs are never
  // echoed — only which audience KEYS are configured — so the response is safe to
  // paste into a ticket.
  const config = {
    enabled,
    configured_audiences: Object.keys(audiences).sort(),
    audiences_without_destination: audiencesWithoutDestination.sort(),
  };

  if (validateOnly) {
    return json({ ok: true, validate_only: true, ...config, ...counters, results: validateResults });
  }
  return json({ ok: true, ...config, ...counters });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// One api_logs row per batch, mirroring the conversion uploader's shape so both
// pipelines are queryable the same way. api_type distinguishes them.
// The client is typed structurally rather than as ReturnType<typeof createClient>:
// supabase-js v2 infers a `never` schema for an untyped client, so the generated
// generics reject an untyped insert. Only `.from().insert()` is needed here.
type InsertableClient = {
  from: (table: string) => { insert: (values: Record<string, unknown>) => PromiseLike<unknown> };
};

async function logAttempt(
  supabase: InsertableClient,
  audienceKey: string,
  audienceId: string,
  memberCount: number,
  outcome: UploadOutcome,
) {
  const success = outcome.kind === "uploaded";
  await supabase.from("api_logs").insert({
    api_type: "cm-upload",
    lead_id: null,
    transaction_id: `customer-match:${audienceKey}:${new Date().toISOString()}`,
    caller_id: "",
    request_payload: {
      source: "upload-google-customer-match",
      audience_key: audienceKey,
      audience_id: audienceId,
      members: memberCount,
    } as object,
    response_payload: (success
      ? (outcome as { response: unknown }).response
      : (outcome as { error: unknown }).error) as object,
    http_status: success ? 200 : 0,
    success,
    error_message: success ? null : `audience=${audienceKey} outcome=${outcome.kind}`,
  });
}
