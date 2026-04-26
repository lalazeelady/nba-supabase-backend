import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

    let crmSuccess = false;
    let crmResponse: any = null;
    let crmStatus = 0;
    let crmLeadId = null;
    let crmAction: string | null = null;
    let errorMessage = null;

    try {
      const crmResult = await fetch(crmUrl, {
        method: "POST",
        headers: {
          "Authorization": `Token ${calltoolsToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(crmBody),
      });

      crmStatus = crmResult.status;
      console.log("CRM Response Status:", crmStatus);

      crmResponse = await crmResult.json();
      console.log("CRM Response:", crmResponse);
      crmSuccess = crmResult.ok;

      if (crmSuccess && crmResponse) {
        // Fresh insert returns the contact object with `id`.
        // Duplicate-merge returns { duplicate_contacts: [<id>], duplicate_action: "MERGE" }.
        // Fall through to duplicate_contacts[0] so merged leads still record the CallTools contact.
        crmLeadId = crmResponse.id
          ?? crmResponse.contact_id
          ?? crmResponse.uid
          ?? (Array.isArray(crmResponse.duplicate_contacts) ? crmResponse.duplicate_contacts[0] : null)
          ?? null;
      }

      // Derive how CallTools handled this submission: MERGE (existing contact) or CREATE (new).
      crmAction = crmResponse?.duplicate_action
        ?? (crmResponse?.id ? "CREATE" : null);
    } catch (error) {
      console.error("CRM API error:", error);
      errorMessage = error instanceof Error ? error.message : "Unknown error";
      crmSuccess = false;
    }

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
