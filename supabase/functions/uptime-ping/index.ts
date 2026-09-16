// uptime-ping
//
// A public endpoint for an EXTERNAL uptime monitor (P3.2 Part A, 2026-09-15).
//
// Why it exists: every other alert in this project is computed inside the database
// and emailed by pipeline-health-check. On 2026-09-14 the database was the thing
// that failed, so the health check's own cron job could not even start and no email
// was ever sent. A check that lives inside the system cannot report that the system
// is down. This endpoint gives something outside Supabase a URL to watch.
//
// Behaviour:
//   200 {"ok":true}  — the database answered a trivial read
//   503 {"ok":false} — it did not (the monitor alerts)
//
// It returns NO data: one row id is read and discarded, so the endpoint needs no
// secret and leaks nothing. It is deliberately tiny — no lead data, no counts, no
// business logic — because a monitor calls it every few minutes forever.
//
// Monitor setup (owner): any free uptime service (UptimeRobot, Better Stack, ...).
//   URL:      https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/uptime-ping
//   Method:   GET        Interval: 5 minutes
//   Alert on: any non-200 response, or no response
// Deploy with verify_jwt=false, or the monitor gets 401 instead of a health signal.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Read timeout. A monitor should see a slow database as down, not wait for it.
const PING_TIMEOUT_MS = 8000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const started = Date.now();
  try {
    // One indexed primary-key read, capped by a timeout. cron.job is tiny and is not
    // written by traffic, so this cannot interfere with the lead path.
    const probe = supabase.from("offline_conversion_events").select("id").limit(1);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${PING_TIMEOUT_MS}ms`)), PING_TIMEOUT_MS)
    );
    const { error } = await Promise.race([probe, timeout]) as { error: { message: string } | null };
    if (error) {
      console.error("uptime-ping: database error:", error.message);
      return new Response(
        JSON.stringify({ ok: false, db: "error", ms: Date.now() - started }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, db: "ok", ms: Date.now() - started }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("uptime-ping: probe failed:", e);
    return new Response(
      JSON.stringify({ ok: false, db: "unreachable", ms: Date.now() - started }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
