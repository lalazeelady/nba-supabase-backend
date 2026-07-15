import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// --- Caliber Leads partner ingest ---
// Same lead data we send to CallTools also goes to Caliber Leads, in parallel.
// Per Caliber's spec the request must be HMAC-SHA256 signed over
// `${timestamp}.${body}` using a shared secret. Secret + their Supabase anon
// key are loaded from edge-function env (never the browser).
const CALIBER_URL = "https://dblgxzhlxcviknamnskj.supabase.co/functions/v1/ingest/nba";

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Map our 4 income buckets to Caliber's 6. Best-effort — both spans are
// approximate so we pick the bucket that contains the midpoint of ours.
function mapAnnualIncomeToCaliber(ours: string | null | undefined): string | undefined {
  switch ((ours || "").toLowerCase()) {
    case "under_50k": return "25_50k";   // could also be lt_25k; pick the common case
    case "50k_75k": return "50_75k";
    case "76k_150k": return "100_150k";  // could be 75_100k; pick higher midpoint
    case "150k_plus": return "gt_150k";
    default: return undefined;
  }
}

// Our form's `employed_full_time` / `employed_part_time` need to be normalized
// to Caliber's `full_time` / `part_time`. unemployed and retired already match.
// `self_employed` isn't a value our form collects today.
function mapEmploymentStatusToCaliber(ours: string | null | undefined): string | undefined {
  switch ((ours || "").toLowerCase()) {
    case "employed_full_time": return "full_time";
    case "employed_part_time": return "part_time";
    case "self_employed": return "self_employed";
    case "unemployed": return "unemployed";
    case "retired": return "retired";
    default: return undefined;  // drop unknown values rather than 400 the request
  }
}

// Caliber accepts only us_citizen / non_us_citizen. Our form has us_citizen,
// non_citizen_legal, and "other" — fold the latter two into non_us_citizen.
function mapCitizenshipToCaliber(ours: string | null | undefined): string | undefined {
  switch ((ours || "").toLowerCase()) {
    case "us_citizen": return "us_citizen";
    case "non_citizen_legal": return "non_us_citizen";
    case "other": return "non_us_citizen";
    default: return undefined;
  }
}

interface CaliberCallResult {
  status: number;
  ok: boolean;
  body: unknown;
  error: string | null;
  // Mapped fields for the leads update.
  derivedStatus: "success" | "duplicate" | "failed" | "skipped";
  leadId: string | null;
  action: string | null;
  // The exact JSON body we POSTed to Caliber, so api_logs can record what we
  // actually sent (field names + values). Null when the request was skipped
  // before the body was built. Excludes the HMAC signature/secret.
  requestBody: unknown;
}

async function postToCaliber(args: {
  phoneE164: string;
  payload: LeadPayload;
  clientIp: string;
  userAgent: string;
  refererUrl: string;
}): Promise<CaliberCallResult> {
  const secret = Deno.env.get("CALIBER_HMAC_SECRET") || "";
  const anonKey = Deno.env.get("CALIBER_ANON_KEY") || "";
  if (!secret || !anonKey) {
    return {
      status: 0, ok: false, body: null, error: "missing CALIBER_HMAC_SECRET or CALIBER_ANON_KEY",
      derivedStatus: "skipped", leadId: null, action: null, requestBody: null,
    };
  }

  const body = {
    consent: {
      given: !!args.payload.tcpa_consent,
      timestamp: new Date().toISOString(),
      ip: args.clientIp !== "unknown" ? args.clientIp : undefined,
      user_agent: args.userAgent || undefined,
      url: args.refererUrl || undefined,
      // Caliber consent field name kept as `jornaya_leadid` per Caliber API
      // spec (renaming on our side would break their TCPA validation). The
      // VALUE is now the TrustedForm cert URL going forward.
      jornaya_leadid: args.payload.trusted_form_cert_url || undefined,
    },
    contact: {
      first_name: args.payload.first_name || undefined,
      last_name: args.payload.last_name || undefined,
      email: args.payload.email || undefined,
      phone: args.phoneE164 || undefined,
      // Street line + city. These are free-text (not enums), so per Caliber's
      // rule an unrecognized field name is silently dropped rather than 400ing
      // the request — safe to send. Field names `address`/`city` mirror what we
      // send CallTools; confirm against Caliber's ingest spec that they land.
      address: args.payload.street_address || undefined,
      city: args.payload.city || undefined,
      state: args.payload.state || undefined,
      zip: args.payload.zip || undefined,
    },
    attribution: {
      utm_source: args.payload.utm_source || undefined,
      utm_medium: args.payload.utm_medium || undefined,
      utm_campaign: args.payload.utm_campaign || undefined,
      utm_content: args.payload.utm_content || undefined,
      utm_term: args.payload.utm_term || undefined,
    },
    extended: {
      // Per Caliber: unknown FIELDS are dropped, but bad VALUES on a known
      // enum field 400 the whole request — so we map our form values to
      // Caliber's accepted enum values, returning undefined for anything that
      // doesn't fit (omitted from the payload entirely).
      date_of_birth: args.payload.dob || undefined,
      citizenship: mapCitizenshipToCaliber(args.payload.citizenship),
      employment_status: mapEmploymentStatusToCaliber(args.payload.employment_status),
      annual_household_income_range: mapAnnualIncomeToCaliber(args.payload.annual_income),
    },
  };

  const bodyStr = JSON.stringify(body);
  const ts = new Date().toISOString();
  const signature = "sha256=" + await hmacSha256Hex(secret, `${ts}.${bodyStr}`);

  try {
    const resp = await fetch(CALIBER_URL, {
      method: "POST",
      headers: {
        "apikey": anonKey,
        "Content-Type": "application/json",
        "x-timestamp": ts,
        "x-signature": signature,
        // Stable request id keyed off transaction_id so retries within 24h are
        // idempotent on Caliber's side.
        "x-request-id": `nba-submit-lead-${args.payload.transaction_id}`,
      },
      body: bodyStr,
    });
    let respBody: unknown = null;
    try { respBody = await resp.json(); } catch { /* leave null */ }

    let derivedStatus: CaliberCallResult["derivedStatus"];
    if (resp.status === 201) derivedStatus = "success";
    else if (resp.status === 200 || resp.status === 409) derivedStatus = "duplicate";
    else derivedStatus = "failed";

    const r = (respBody || {}) as Record<string, unknown>;
    return {
      status: resp.status,
      ok: resp.ok,
      body: respBody,
      error: null,
      derivedStatus,
      leadId: typeof r.lead_id === "string" ? r.lead_id : null,
      // Caliber doesn't document a separate "action" enum but the 201 vs 200
      // distinction maps cleanly to created vs duplicate.
      action: derivedStatus === "success" ? "created"
            : derivedStatus === "duplicate" ? "duplicate"
            : null,
      requestBody: body,
    };
  } catch (e) {
    return {
      status: 0, ok: false, body: null,
      error: e instanceof Error ? e.message : String(e),
      derivedStatus: "failed",
      leadId: null, action: null, requestBody: body,
    };
  }
}

// Server-side phone validation (NANP + US-only area-code allowlist).
// Mirrors the client-side check on /apply/2/step-4-contact so submissions
// that bypass the form (direct POSTs, broken-JS browsers) are caught here
// instead of wasting a CallTools call and triggering a Resend alert.
// Accepts either 10 digits or 11 with a leading 1 (the E.164 formatter
// below already handles both).
//
// Allowlist intentionally omits codes NANPA currently has unassigned --
// e.g. 823, which CallTools rejected on a real submission. When CallTools
// rejects a future area code that's still in the list, drop it here AND
// in the matching frontend constant.
const VALID_NANP_AREA_CODES = new Set<string>([
  "201","202","203","205","206","207","208","209","210","212","213","214","215","216","217","218","219","220","223","224","225","228","229","231","234","235","239","240","248","251","252","253","254","256","260","262","267","269","270","272","274","276","278","279","281","283","301","302","303","304","305","307","308","309","310","312","313","314","315","316","317","318","319","320","321","323","324","325","326","327","329","330","331","332","334","336","337","339","341","346","347","350","351","352","353","357","360","361","363","364","369","380","385","386","401","402","404","405","406","407","408","409","410","412","413","414","415","417","419","423","424","425","430","432","434","435","436","440","442","443","445","447","448","457","458","463","464","469","470","471","472","475","478","479","480","483","484","501","502","503","504","505","507","508","509","510","512","513","515","516","517","518","520","521","522","525","530","531","534","539","540","541","551","557","559","561","562","563","564","567","570","571","573","574","575","580","585","586","601","602","603","605","606","607","608","609","610","612","614","615","616","617","618","619","620","623","626","628","629","630","631","636","641","645","646","650","651","657","659","660","661","662","667","669","678","680","681","682","689","701","702","703","704","706","707","708","712","713","714","715","716","717","718","719","720","724","725","726","727","728","729","731","732","734","737","738","740","743","747","754","757","760","762","763","765","769","770","771","772","773","774","775","776","779","781","783","785","786","801","802","803","804","805","806","808","810","812","813","814","815","816","817","818","820","828","830","831","832","833","838","839","840","843","844","845","847","848","850","854","855","856","857","858","859","860","861","862","863","864","865","866","870","872","877","878","888","903","904","906","907","908","909","910","912","913","914","915","916","917","918","919","920","925","928","929","930","931","934","936","937","938","940","941","943","945","947","948","949","951","952","954","956","959","970","971","972","973","978","979","980","983","984","985","986","989",
]);

type PhoneFailReason =
  | "wrong_length"
  | "nanp_violation"
  | "all_same_digit"
  | "bad_area_code";

function validatePhone(raw: string): PhoneFailReason | null {
  const digits = (raw || "").replace(/\D/g, "");
  let canonical: string;
  if (digits.length === 10) canonical = digits;
  else if (digits.length === 11 && digits[0] === "1") canonical = digits.slice(1);
  else return "wrong_length";
  // NANP: area code (digit 0) and exchange code (digit 3) must each start with 2-9.
  // Catches placeholders like 5551234567 (exchange 123 starts with 1) and real-world
  // CallTools rejects like 9290898075 (exchange 089 starts with 0).
  if (canonical[0] < "2" || canonical[3] < "2") return "nanp_violation";
  // Reject all-same-digit (e.g. 2222222222, 9999999999).
  if (/^(\d)\1{9}$/.test(canonical)) return "all_same_digit";
  // Reject NPAs not in the US 50-states+DC allowlist (foreign NANP, Canada,
  // and non-state US territories). Mirrors the client-side allowlist.
  if (!VALID_NANP_AREA_CODES.has(canonical.slice(0, 3))) return "bad_area_code";
  return null;
}

// Server-side email validation. Mirrors the client-side regex on
// /apply/2/step-4-contact, with one extra rule (consecutive dots) that
// caught a real CallTools rejection: "Osmolinskathy12@gmal..com is a
// invalid email address for field email". RFC 5322 forbids consecutive
// dots in the local part and in dot-atom domain labels.
function validateEmail(raw: string): "invalid_email" | null {
  const trimmed = (raw || "").trim();
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmed)) return "invalid_email";
  if (trimmed.includes("..")) return "invalid_email";
  if (trimmed.includes(".@")) return "invalid_email";
  if (trimmed.includes("@.")) return "invalid_email";
  return null;
}

interface LeadPayload {
  transaction_id: string;
  state: string;
  dob: string;
  citizenship: string;
  street_address: string;
  city: string;
  zip: string;
  annual_income: string;
  employment_status: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  tcpa_consent: boolean;
  trusted_form_cert_url: string;
  age?: number;
  click_id?: string;
  wbraid?: string;
  gbraid?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // Client + a handle to the inserted lead are declared outside the try so the
  // catch can flag a lead that was saved but then hit an exception before its
  // CRM status was resolved — otherwise it would sit at 'pending' forever
  // (invisible attribution: saved to Supabase, never posted to CallTools).
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );
  let insertedLeadId: string | null = null;

  try {
    const payload: LeadPayload = await req.json();

    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    // --- Bot detection: honeypot field + time-trap ---
    const hpWebsite = (payload as any).hp_website || "";
    const formDuration = (payload as any).form_duration_ms ?? 0;
    const isBotSuspected = hpWebsite.length > 0 || formDuration < 3000;

    if (isBotSuspected) {
      const reason = hpWebsite.length > 0 ? "honeypot_filled" : "too_fast";
      console.warn(`Bot detected (${reason}): IP=${clientIp}, duration=${formDuration}ms`);

      await supabase.from("bot_drops").insert({
        ip_address: clientIp,
        user_agent: req.headers.get("user-agent") || "unknown",
        detection_reason: reason,
        form_duration_ms: formDuration,
        raw_payload: payload,
      });

      // Return 200 so the bot thinks it succeeded
      return new Response(
        JSON.stringify({
          success: true,
          message: "Lead submitted successfully",
          transaction_id: payload.transaction_id,
          crm_accepted: false,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // --- Phone validation (NANP) ---
    // Drop invalid numbers into bot_drops with detection_reason `invalid_phone`
    // instead of inserting to leads + calling CallTools + emailing on failure.
    // CallTools rejects these server-side anyway; this just silences the noise.
    const phoneFailReason = validatePhone(payload.phone);
    if (phoneFailReason) {
      console.warn(`Invalid phone (${phoneFailReason}): IP=${clientIp}, phone=${payload.phone}`);

      await supabase.from("bot_drops").insert({
        ip_address: clientIp,
        user_agent: req.headers.get("user-agent") || "unknown",
        detection_reason: `invalid_phone:${phoneFailReason}`,
        form_duration_ms: formDuration,
        raw_payload: payload,
      });

      // Same fake-200 contract as the bot path so the client flow is consistent.
      return new Response(
        JSON.stringify({
          success: true,
          message: "Lead submitted successfully",
          transaction_id: payload.transaction_id,
          crm_accepted: false,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // --- Email validation ---
    // Same pattern as the phone gate: drop bad emails to bot_drops so we
    // don't burn a CallTools call and a Resend alert on a known-bad input.
    // Catches real CallTools rejections like "Osmolinskathy12@gmal..com".
    const emailFailReason = validateEmail(payload.email);
    if (emailFailReason) {
      console.warn(`Invalid email (${emailFailReason}): IP=${clientIp}, email=${payload.email}`);

      await supabase.from("bot_drops").insert({
        ip_address: clientIp,
        user_agent: req.headers.get("user-agent") || "unknown",
        detection_reason: emailFailReason,
        form_duration_ms: formDuration,
        raw_payload: payload,
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: "Lead submitted successfully",
          transaction_id: payload.transaction_id,
          crm_accepted: false,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Guarantee a non-empty transaction_id — our key identifier. The front end
    // normally supplies one; this covers the rare blank so neither the leads row
    // nor the CallTools/Caliber posts can ever go out without it.
    const transactionId = (typeof payload.transaction_id === "string" && payload.transaction_id.trim())
      ? payload.transaction_id.trim()
      : crypto.randomUUID();

    // Derive age from DOB once, up front, so it can be persisted on the leads
    // row (previously left null — leads.age was ~99% null) AND reused for the
    // CallTools payload. Front end may also supply an explicit age; prefer it.
    let computedAge: number | undefined;
    {
      const dobDate = new Date(payload.dob);
      if (!isNaN(dobDate.getTime())) {
        const today = new Date();
        computedAge = today.getFullYear() - dobDate.getFullYear();
        const monthDiff = today.getMonth() - dobDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
          computedAge--;
        }
      }
    }
    const ageToStore = (typeof payload.age === "number" ? payload.age : computedAge) ?? null;

    const { data: leadData, error: insertError } = await supabase
      .from("leads")
      .insert({
        transaction_id: transactionId,
        state: payload.state,
        dob: payload.dob,
        age: ageToStore,
        citizenship: payload.citizenship,
        street_address: payload.street_address,
        city: payload.city,
        zip: payload.zip,
        annual_income: payload.annual_income,
        employment_status: payload.employment_status,
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        tcpa_consent: payload.tcpa_consent,
        ip_address: clientIp,
        trusted_form_cert_url: payload.trusted_form_cert_url || "STATIC_JORNAYA_ID_PLACEHOLDER",
        crm_status: "pending",
        gclid: payload.click_id || null,
        wbraid: payload.wbraid || null,
        gbraid: payload.gbraid || null,
        utm_source: payload.utm_source || null,
        utm_medium: payload.utm_medium || null,
        utm_campaign: payload.utm_campaign || null,
        utm_content: payload.utm_content || null,
        utm_term: payload.utm_term || null,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to save lead" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Track the saved lead so the catch can move it off 'pending' if anything
    // downstream throws (e.g. a missing CRM token).
    insertedLeadId = leadData.id as string;

    const calltoolsToken = Deno.env.get("CALLTOOLS_API_TOKEN");
    if (!calltoolsToken) {
      throw new Error("CALLTOOLS_API_TOKEN is not set");
    }

    const phoneDigits = payload.phone.replace(/\D/g, "");
    let phoneFormatted: string;
    if (phoneDigits.length === 10) {
      phoneFormatted = `+1${phoneDigits}`;
    } else if (phoneDigits.length === 11 && phoneDigits.startsWith("1")) {
      phoneFormatted = `+${phoneDigits}`;
    } else if (phoneDigits.length > 0) {
      phoneFormatted = `+${phoneDigits}`;
    } else {
      phoneFormatted = "";
    }

    // gclid / gbraid / wbraid each post to their own named field on CallTools.
    // No cross-type fallback (e.g. wbraid value into a gclid field) — that
    // conflation was the root cause of the CallTools -> Ringba User:gclid
    // mis-mapping we cleaned up on 2026-04-30, where gbraid-shaped values
    // and UUIDs landed in the gclid column. Each click identifier goes only
    // where it belongs; if it's not present we send an empty string.
    const crmBody: Record<string, unknown> = {
      transaction_id: transactionId,
      state: payload.state,
      dob: payload.dob,
      ...((payload.age ?? computedAge) !== undefined && { age: payload.age ?? computedAge }),
      citizenship: payload.citizenship,
      address: payload.street_address,
      city: payload.city,
      zip_code: payload.zip,
      annual_income: ({ under_50k: 50000, "50k_75k": 75000, "76k_150k": 150000, "150k_plus": 150001 } as Record<string, number>)[payload.annual_income] ?? 0,
      employment_status: payload.employment_status,
      first_name: payload.first_name,
      last_name: payload.last_name,
      email: payload.email,
      home_phone_number: phoneFormatted,
      tcpa_consent: String(payload.tcpa_consent),
      // Outbound CallTools field name kept as `jornaya_lead_id` because the
      // CallTools side is configured to receive it under that name. The VALUE
      // is now the TrustedForm cert URL going forward.
      jornaya_lead_id: payload.trusted_form_cert_url || "",
      gclid: payload.click_id || "",
      wbraid: payload.wbraid || "",
      gbraid: payload.gbraid || "",
      utm_source: payload.utm_source || "",
      utm_medium: payload.utm_medium || "",
      utm_campaign: payload.utm_campaign || "",
      utm_content: payload.utm_content || "",
      utm_term: payload.utm_term || "",
      status: "new",
      do_not_contact: false,
      add_tags: [268591],
    };

    // Don't send empty values to CallTools. Duplicate mode is Overwrite (match by
    // phone), so a blank field would clobber whatever the existing contact already
    // has (e.g. wipe a real gclid with ""). Omitting the field instead leaves the
    // existing value untouched. Keeps false / 0 / arrays; drops null/undefined/"".
    for (const k of Object.keys(crmBody)) {
      const v = crmBody[k];
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
        delete crmBody[k];
      }
    }

    const crmUrl = "https://app.calltools.io/api/contacts/";

    console.log("CRM Request URL:", crmUrl);
    console.log("CRM Request Body:", crmBody);

    // Fire CallTools and Caliber Leads in parallel. Each has its own try/catch
    // so one provider's failure doesn't break the other; the lead row stays
    // accepted regardless. Total response time = max(calltools, caliber)
    // instead of the sum.
    const calltoolsPromise = (async () => {
      // CallTools occasionally returns a transient HTTP 5xx with an HTML error
      // page (its generic server-error page) instead of JSON. The old code did
      // `await result.json()` directly, which threw "Unexpected token '<'" on
      // that HTML and dropped an otherwise-valid lead (saved to Supabase + sent
      // to Caliber, but never posted to CallTools). We now:
      //   1. read the body as text first (never throws on HTML),
      //   2. parse JSON defensively and keep the raw body for the log/alert,
      //   3. retry transient failures (5xx / non-JSON / network timeout) up to
      //      3x with backoff. CallTools dedupes by phone, so a retry after a
      //      partially-applied create merges instead of creating a duplicate.
      // 4xx (request-side) is not retried — it won't change on a retry.
      let success = false;
      let response: any = null;
      let status = 0;
      let leadId: string | null = null;
      let action: string | null = null;
      let error: string | null = null;
      const MAX_ATTEMPTS = 3;
      const ATTEMPT_TIMEOUT_MS = 10000;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
        try {
          const result = await fetch(crmUrl, {
            method: "POST",
            headers: {
              "Authorization": `Token ${calltoolsToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(crmBody),
            signal: ac.signal,
          });
          status = result.status;
          // Read as text first so a non-JSON (HTML) body never throws here.
          const rawBody = await result.text();
          console.log("CRM Response Status:", status, "attempt", attempt);
          try {
            response = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            response = null; // non-JSON body (e.g. HTML error page)
          }
          console.log("CRM Response:", response);

          if (result.ok) {
            success = true;
            // Fresh insert returns the contact object with `id`.
            // Duplicate-merge returns { duplicate_contacts: [<id>], duplicate_action: "MERGE" }.
            // Fall through to duplicate_contacts[0] so merged leads still record the CallTools contact.
            leadId = response?.id
              ?? response?.contact_id
              ?? response?.uid
              ?? (Array.isArray(response?.duplicate_contacts) ? response.duplicate_contacts[0] : null)
              ?? null;
            action = response?.duplicate_action ?? (response?.id ? "CREATE" : null);
            error = null;
            break;
          }

          // Non-2xx. Capture the actual body (HTML error page or JSON string)
          // so api_logs/the alert show what CallTools really returned.
          error = `CallTools HTTP ${status}: ${rawBody.slice(0, 300)}`;
          // Only retry 5xx (transient server-side). 4xx is our request's fault.
          if (status < 500) break;
        } catch (e) {
          // Network-level error, or our per-attempt timeout fired (AbortError).
          console.error("CRM API error:", e);
          error = e instanceof Error
            ? (e.name === "AbortError"
              ? `CallTools request timed out after ${ATTEMPT_TIMEOUT_MS}ms`
              : e.message)
            : "Unknown error";
          success = false;
        } finally {
          clearTimeout(timer);
        }

        // Back off before the next attempt (400ms, then 800ms).
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }

      return { success, response, status, leadId, action, error };
    })();

    const caliberPromise = postToCaliber({
      phoneE164: phoneFormatted,
      payload,
      clientIp,
      userAgent: req.headers.get("user-agent") || "",
      refererUrl: req.headers.get("referer") || "",
    });

    const [crmResult, caliberResult] = await Promise.all([calltoolsPromise, caliberPromise]);

    const crmSuccess = crmResult.success;
    const crmResponse = crmResult.response;
    const crmStatus = crmResult.status;
    const crmLeadId = crmResult.leadId;
    const crmAction = crmResult.action;
    const errorMessage = crmResult.error;

    await supabase.from("api_logs").insert({
      lead_id: leadData.id,
      transaction_id: transactionId,
      caller_id: phoneFormatted,
      request_payload: crmBody,
      response_payload: crmResponse,
      http_status: crmStatus,
      success: crmSuccess,
      error_message: errorMessage,
    });

    // Separate api_logs row for Caliber so the audit trail per provider is
    // clean and we can filter on response_payload.provider downstream.
    await supabase.from("api_logs").insert({
      lead_id: leadData.id,
      transaction_id: transactionId,
      caller_id: phoneFormatted,
      request_payload: { provider: "caliber_leads", url: CALIBER_URL, body: caliberResult.requestBody } as object,
      response_payload: { provider: "caliber_leads", body: caliberResult.body, derived_status: caliberResult.derivedStatus } as object,
      http_status: caliberResult.status,
      // A duplicate (HTTP 409 duplicate_rejected, or 200) is a SUCCESSFUL
      // dedupe on Caliber's side, not a failure. Log success on both accepted
      // and duplicate so failure reporting off api_logs.success stops
      // overcounting Caliber "failures" (was ~6.8k mislabeled 409s).
      success: caliberResult.derivedStatus === "success" || caliberResult.derivedStatus === "duplicate",
      error_message: caliberResult.error,
    });

    // Stamp Caliber result on the leads row regardless of CallTools outcome.
    await supabase
      .from("leads")
      .update({
        caliber_status: caliberResult.derivedStatus,
        caliber_lead_id: caliberResult.leadId,
        caliber_action: caliberResult.action,
        caliber_submitted_at:
          (caliberResult.derivedStatus === "success" || caliberResult.derivedStatus === "duplicate")
            ? new Date().toISOString()
            : null,
      })
      .eq("id", leadData.id);

    if (crmSuccess) {
      await supabase
        .from("leads")
        .update({
          crm_lead_id: crmLeadId,
          crm_action: crmAction,
          crm_status: "success",
          crm_submitted_at: new Date().toISOString(),
        })
        .eq("id", leadData.id);
    } else {
      await supabase
        .from("leads")
        .update({
          crm_status: "failed",
        })
        .eq("id", leadData.id);

      // --- Send failure alert email via Resend ---
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (resendKey) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "onboarding@resend.dev",
              to: "larazielin1@gmail.com",
              subject: `NBA Lead Failed — ${payload.first_name} ${payload.last_name} (${crmStatus})`,
              html: `<h2>CallTools API Failure</h2>
<p><strong>HTTP Status:</strong> ${crmStatus}</p>
<p><strong>Error:</strong> ${errorMessage || "None"}</p>
<p><strong>CallTools Response:</strong></p>
<pre>${JSON.stringify(crmResponse, null, 2)}</pre>
<hr>
<h3>Lead Details</h3>
<ul>
  <li><strong>Name:</strong> ${payload.first_name} ${payload.last_name}</li>
  <li><strong>Email:</strong> ${payload.email}</li>
  <li><strong>Phone:</strong> ${payload.phone}</li>
  <li><strong>State:</strong> ${payload.state}</li>
  <li><strong>DOB:</strong> ${payload.dob}</li>
  <li><strong>Transaction ID:</strong> ${payload.transaction_id}</li>
</ul>
<p><em>This lead was saved to Supabase but was NOT posted to CallTools.</em></p>`,
            }),
          });
        } catch (emailErr) {
          console.error("Resend email error:", emailErr);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Lead submitted successfully",
        transaction_id: payload.transaction_id,
        // Truthful CallTools-acceptance signal for the funnel: only accepted
        // leads are routed to the completed-funnel thank-you number.
        crm_accepted: crmSuccess,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Function error:", error);

    // If the lead was already saved, don't leave it stranded at 'pending' —
    // mark it 'failed' so it's queryable as a submission that never completed
    // its CRM dispatch. Best-effort; never let this throw over the response.
    if (insertedLeadId) {
      try {
        await supabase
          .from("leads")
          .update({
            crm_status: "failed",
            crm_error: error instanceof Error ? error.message : String(error),
          })
          .eq("id", insertedLeadId);
      } catch (flagErr) {
        console.error("Failed to flag stranded lead:", flagErr);
      }
    }

    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
