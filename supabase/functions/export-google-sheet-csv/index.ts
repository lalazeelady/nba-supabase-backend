// export-google-sheet-csv
//
// Returns NBA-publisher revenue conversion events as a CSV in the column
// order expected by the user's Google Ads scheduled offline-conversion
// upload template (15-column Enhanced-Conversions-for-Offline-Conversions
// template).
//
// PII handling: all fields (email, phone, first/last name, ip, session
// attributes, user agent) emitted RAW. Google Data Manager hashes
// email/phone/first/last server-side at ingest.
//
// This endpoint is the manual fallback / debug tool. The cron-driven
// sync-google-sheet edge function does the routine push. Use this CSV
// when you want to inspect what's queued without writing to the Sheet.
//
// Auth: shared secret in `x-invoke-secret` header.
//
// Query params:
//   ?mark_synced=true  — stamp sheet_synced_at=now() on emitted rows.
//   ?limit=N           — cap emitted rows (default unlimited, max 5000).
//   ?format=json       — return JSON array instead of CSV.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};

const CSV_HEADERS = [
  "Google Click ID",
  "gbraid",
  "wbraid",
  "Conversion Name",
  "Conversion Time",
  "Conversion Value",
  "Conversion Currency",
  "Order ID",
  "ip address",
  "email",
  "phone",
  "first name",
  "last name",
  "session attributes",
  "user agent",
];

interface ExportRow {
  event_id: string;
  google_click_id: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_name: string | null;
  conversion_time: string | null;
  conversion_value: number | string | null;
  conversion_currency: string | null;
  order_id: string | null;
  ip_address: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  session_attributes: string | null;
  user_agent: string | null;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsv(r: ExportRow): string {
  return [
    r.google_click_id, r.gbraid, r.wbraid,
    r.conversion_name, r.conversion_time,
    r.conversion_value, r.conversion_currency, r.order_id,
    r.ip_address,
    r.email, r.phone, r.first_name, r.last_name,
    r.session_attributes, r.user_agent,
  ].map(csvEscape).join(",");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const expected = Deno.env.get("UPLOADER_INVOKE_SECRET") || "";
  const provided = req.headers.get("x-invoke-secret") || "";
  if (!expected || provided !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const url = new URL(req.url);
  const markSynced = url.searchParams.get("mark_synced") === "true";
  const limitParam = Number(url.searchParams.get("limit"));
  const format = (url.searchParams.get("format") || "csv").toLowerCase();
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 5000)
    : null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let query = supabase
    .from("v_google_sheet_export_unsynced")
    .select(
      "event_id, google_click_id, gbraid, wbraid, " +
      "conversion_name, conversion_time, conversion_value, conversion_currency, order_id, " +
      "ip_address, email, phone, first_name, last_name, session_attributes, user_agent",
    );

  if (limit !== null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("export-google-sheet-csv view read error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const rows = (data ?? []) as ExportRow[];

  let markedCount = 0;
  if (markSynced && rows.length > 0) {
    const ids = rows.map((r) => r.event_id);
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const { error: updErr, count } = await supabase
        .from("offline_conversion_events")
        .update({ sheet_synced_at: new Date().toISOString() }, { count: "exact" })
        .in("id", slice);
      if (updErr) {
        console.error("export-google-sheet-csv mark_synced error:", updErr);
        return new Response(
          JSON.stringify({
            error: `Emitted CSV but failed to mark synced: ${updErr.message}`,
            emitted: rows.length,
            marked: markedCount,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      markedCount += count ?? slice.length;
    }
  }

  if (format === "json") {
    return new Response(
      JSON.stringify({
        ok: true,
        count: rows.length,
        marked_synced: markedCount,
        headers: CSV_HEADERS,
        rows,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const csv = [CSV_HEADERS.join(","), ...rows.map(rowToCsv)].join("\r\n") + "\r\n";

  return new Response(csv, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="nba-google-ads-conversions-${
        new Date().toISOString().slice(0, 10)
      }.csv"`,
      "X-Row-Count": String(rows.length),
      "X-Marked-Synced": String(markedCount),
    },
  });
});
