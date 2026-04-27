// Shared CORS headers. Mirrors the values used by submit-lead so the two
// functions stay consistent. Ringba and the cron caller will not actually
// hit the OPTIONS preflight in production, but we keep the same shape so
// browser-based debugging works.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, x-webhook-secret, x-invoke-secret",
};
