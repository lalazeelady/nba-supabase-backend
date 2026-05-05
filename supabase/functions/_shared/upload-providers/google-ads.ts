// Google Ads API UploadClickConversions provider (alternate path).
//
// Use this provider by setting GOOGLE_UPLOAD_PROVIDER=google_ads.
// The Data Manager provider is the preferred primary path; this exists
// so we can fall back to a battle-tested API if Data Manager
// configuration is delayed.
//
// API reference (v18 at time of writing):
// https://developers.google.com/google-ads/api/reference/rpc/v18/ConversionUploadService

import {
  ConversionEvent,
  UploadOutcome,
  UploadProvider,
  pickClickIdentifier,
} from "./types.ts";
import { getGoogleAccessToken } from "./google-oauth.ts";

const GOOGLE_ADS_API_VERSION = Deno.env.get("GOOGLE_ADS_API_VERSION") || "v18";

function conversionActionResource(customerId: string, conversionActionId: string): string {
  return `customers/${customerId}/conversionActions/${conversionActionId}`;
}

// Google Ads API expects "yyyy-MM-dd HH:mm:ss+HH:MM".
function formatGoogleAdsTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Send in UTC with a +00:00 offset.
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}

export const googleAdsProvider: UploadProvider = {
  name: "google_ads",
  async upload(event: ConversionEvent): Promise<UploadOutcome> {
    const click = pickClickIdentifier(event);
    if (!click) {
      return {
        kind: "permanent",
        error: { message: "No click identifier (gclid/gbraid/wbraid) on event" },
      };
    }

    const customerId = event.google_ads_customer_id || Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "";
    const conversionActionId = event.google_ads_conversion_action_id ||
      Deno.env.get("GOOGLE_ADS_CONVERSION_ACTION_ID_CALL_CONVERTED_REVENUE") || "";
    const developerToken = Deno.env.get("GOOGLE_DEVELOPER_TOKEN");
    const loginCustomerId = Deno.env.get("GOOGLE_LOGIN_CUSTOMER_ID");

    if (!customerId || !conversionActionId || !developerToken) {
      return {
        kind: "retryable",
        error: {
          message:
            "Google Ads not configured: GOOGLE_ADS_CUSTOMER_ID / conversion action id / GOOGLE_DEVELOPER_TOKEN missing",
        },
      };
    }

    let accessToken: string;
    try {
      accessToken = await getGoogleAccessToken();
    } catch (e) {
      return { kind: "retryable", error: { message: String(e) } };
    }

    const conversion: Record<string, unknown> = {
      conversionAction: conversionActionResource(customerId, conversionActionId),
      conversionDateTime: formatGoogleAdsTimestamp(event.conversion_time),
      conversionValue: event.conversion_value,
      currencyCode: event.currency_code,
      orderId: event.dedupe_key,
    };
    if (click.kind === "gclid") conversion.gclid = click.value;
    if (click.kind === "gbraid") conversion.gbraid = click.value;
    if (click.kind === "wbraid") conversion.wbraid = click.value;

    const body = {
      conversions: [conversion],
      partialFailure: true,
      validateOnly: false,
    };

    const url =
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": developerToken,
      "Content-Type": "application/json",
    };
    if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      return { kind: "retryable", error: { message: `network: ${String(e)}` } };
    }

    const respText = await res.text();
    let respJson: unknown;
    try { respJson = JSON.parse(respText); } catch { respJson = respText; }

    if (res.ok) {
      // partialFailure surfaces per-conversion errors in the response body.
      const partial = (respJson as { partialFailureError?: unknown })?.partialFailureError;
      if (partial) {
        return { kind: "permanent", error: { partialFailure: partial } };
      }
      return { kind: "success", response: respJson };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { kind: "retryable", error: { status: res.status, body: respJson } };
    }
    return { kind: "permanent", error: { status: res.status, body: respJson } };
  },
};
