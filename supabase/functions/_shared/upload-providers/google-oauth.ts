// Shared Google OAuth helper.
//
// Both the Data Manager API and the Google Ads API authenticate with the
// same OAuth refresh-token flow against the same client/secret. This
// module exchanges the long-lived refresh token for a short-lived access
// token and caches it for its remaining lifetime so we are not spending
// a token-exchange call per upload.

let cached: { token: string; expiresAt: number } | null = null;

export async function getGoogleAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) {
    return cached.token;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google OAuth not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing.",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google OAuth refresh failed: ${res.status} ${text}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };
  cached = {
    token: json.access_token,
    expiresAt: now + (json.expires_in * 1000),
  };
  return cached.token;
}
