// export-google-sheet-csv
//
// Returns NBA-publisher revenue conversion events as a CSV in the column
// order expected by the user's Google Ads scheduled offline-conversion +
// ECL upload template (see migrations/20260428020000_create_google_sheet_export_view).
//
// Phase 1: this endpoint is read-only — the operator pulls the CSV manually
// and pastes/uploads it into the prepared Google Sheet. Phase 2 will add a
// Sheets API write directly from this function (or a paired cron).
//
// Auth: shared secret in `x-invoke-secret` header (same secret as the
// uploader function, since this is a peer internal endpoint).
//
// Query params:
//   ?mark_synced=true  — stamp sheet_synced_at=now() on emitted rows so
//                        they don't appear in the next pull. Default false
//                        (preview mode).
//   ?limit=N           — cap emitted rows (default unlimited).
//   ?format=json       — return JSON array instead of CSV.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// CSV header matching the simplified click-conversion-only template.
// Order matches v_google_sheet_export_unsynced.
const CSV_HEADERS = [
  "Google Click ID",
  "gbraid",
  "wbraid",
  "Conversion Name",
  "Conversion Time",
  "Conversion Value",
  "Conversion Currency",
  "Order ID",
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
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // RFC 4180: wrap in quotes and double any embedded quotes if the value
  // contains comma, quote, or newline.
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
      "conversion_name, conversion_time, conversion_value, conversion_currency, order_id",
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

  // Optionally stamp sheet_synced_at so these rows don't re-emit on the
  // next pull. Done in chunks to stay under PostgREST's IN-list size cap.
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
