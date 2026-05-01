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
      derivedStatus: "skipped", leadId: null, action: null,
    };
  }

  const body = {
    consent: {
      given: !!args.payload.tcpa_consent,
      timestamp: new Date().toISOString(),
      ip: args.clientIp !== "unknown" ? args.clientIp : undefined,
      user_agent: args.userAgent || undefined,
      url: args.refererUrl || undefined,
      jornaya_leadid: args.payload.jornaya_leadid || undefined,
    },
    contact: {
      first_name: args.payload.first_name || undefined,
      last_name: args.payload.last_name || undefined,
      email: args.payload.email || undefined,
      phone: args.phoneE164 || undefined,
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
    };
  } catch (e) {
    return {
      status: 0, ok: false, body: null,
      error: e instanceof Error ? e.message : String(e),
      derivedStatus: "failed",
      leadId: null, action: null,
    };
  }
}

// Server-side phone validation (NANP). Mirrors the client-side check on
// /apply/2/step-4-contact so submissions that bypass the form (direct
// POSTs, broken-JS browsers) are caught here instead of wasting a
// CallTools call and triggering a Resend alert. Accepts either 10 digits
// or 11 with a leading 1 (the E.164 formatter below already handles both).
function validatePhone(raw: string): "wrong_length" | "nanp_violation" | "all_same_digit" | null {
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
  jornaya_leadid: string;
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

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

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
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: leadData, error: insertError } = await supabase
      .from("leads")
      .insert({
        transaction_id: payload.transaction_id,
        state: payload.state,
        dob: payload.dob,
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
        jornaya_leadid: payload.jornaya_leadid || "STATIC_JORNAYA_ID_PLACEHOLDER",
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

    let age: number | undefined;
    const dobDate = new Date(payload.dob);
    if (!isNaN(dobDate.getTime())) {
      const today = new Date();
      age = today.getFullYear() - dobDate.getFullYear();
      const monthDiff = today.getMonth() - dobDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
        age--;
      }
    }

    // Fall back to wbraid/gbraid when gclid is absent so click_id is never empty
    // for valid Google Ads clicks (iOS privacy-safe traffic).
    const clickId = payload.click_id || payload.wbraid || payload.gbraid || "";

    const crmBody: Record<string, unknown> = {
      transaction_id: payload.transaction_id,
      state: payload.state,
      dob: payload.dob,
      ...(age !== undefined && { age }),
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
      jornaya_lead_id: payload.jornaya_leadid || "STATIC_JORNAYA_ID_PLACEHOLDER",
      click_id: clickId,
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

    const crmUrl = "https://app.calltools.io/api/contacts/";

    console.log("CRM Request URL:", crmUrl);
    console.log("CRM Request Body:", crmBody);

    // Fire CallTools and Caliber Leads in parallel. Each has its own try/catch
    // so one provider's failure doesn't break the other; the lead row stays
    // accepted regardless. Total response time = max(calltools, caliber)
    // instead of the sum.
    const calltoolsPromise = (async () => {
      let success = false;
      let response: any = null;
      let status = 0;
      let leadId: string | null = null;
      let action: string | null = null;
      let error: string | null = null;
      try {
        const result = await fetch(crmUrl, {
          method: "POST",
          headers: {
            "Authorization": `Token ${calltoolsToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(crmBody),
        });
        status = result.status;
        console.log("CRM Response Status:", status);
        response = await result.json();
        console.log("CRM Response:", response);
        success = result.ok;
        if (success && response) {
          // Fresh insert returns the contact object with `id`.
          // Duplicate-merge returns { duplicate_contacts: [<id>], duplicate_action: "MERGE" }.
          // Fall through to duplicate_contacts[0] so merged leads still record the CallTools contact.
          leadId = response.id
            ?? response.contact_id
            ?? response.uid
            ?? (Array.isArray(response.duplicate_contacts) ? response.duplicate_contacts[0] : null)
            ?? null;
        }
        action = response?.duplicate_action ?? (response?.id ? "CREATE" : null);
      } catch (e) {
        console.error("CRM API error:", e);
        error = e instanceof Error ? e.message : "Unknown error";
        success = false;
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
      transaction_id: payload.transaction_id,
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
      transaction_id: payload.transaction_id,
      caller_id: phoneFormatted,
      request_payload: { provider: "caliber_leads", url: CALIBER_URL } as object,
      response_payload: { provider: "caliber_leads", body: caliberResult.body } as object,
      http_status: caliberResult.status,
      success: caliberResult.ok,
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
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Function error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
