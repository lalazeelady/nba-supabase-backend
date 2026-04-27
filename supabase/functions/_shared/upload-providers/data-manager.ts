// Google Data Manager API upload provider (Phase 1B primary path).
//
// This is a scaffold. Google's Data Manager API uses a destination
// configuration created in the Ads UI (or via the API) that bundles the
// customer id + conversion action + matching settings. The exact request
// shape will be confirmed against a live destination during Phase 1B —
// the Data Manager API is newer than the classic Ads API, and field names
// have shifted between previews.
//
// Until that confirmation:
//   - The code path runs end-to-end with a real OAuth token.
//   - It POSTs to a configurable endpoint placeholder.
//   - It reads GOOGLE_DATA_MANAGER_DESTINATION_ID for routing.
//
// Switching to the verified shape will only require editing this file.
// The selector + uploader function above stay the same.

import {
  ConversionEvent,
  UploadOutcome,
  UploadProvider,
  pickClickIdentifier,
} from "./types.ts";
import { getGoogleAccessToken } from "./google-oauth.ts";

const DATA_MANAGER_ENDPOINT =
  Deno.env.get("GOOGLE_DATA_MANAGER_ENDPOINT") ||
  "https://datamanager.googleapis.com/v1/audienceMembers:upload";

export const dataManagerProvider: UploadProvider = {
  name: "data_manager",
  async upload(event: ConversionEvent): Promise<UploadOutcome> {
    const click = pickClickIdentifier(event);
    if (!click) {
      return {
        kind: "permanent",
        error: { message: "No click identifier (gclid/gbraid/wbraid) on event" },
      };
    }

    const destinationId = Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID");
    if (!destinationId) {
      return {
        kind: "retryable",
        error: { message: "GOOGLE_DATA_MANAGER_DESTINATION_ID not configured" },
      };
    }

    let accessToken: string;
    try {
      accessToken = await getGoogleAccessToken();
    } catch (e) {
      return { kind: "retryable", error: { message: String(e) } };
    }

    // Body shape is the current best-guess for an offline-conversion
    // upload via Data Manager. Confirm against Google's reference once
    // we have a live destination configured. The dedupe_key is sent as
    // both transactionId and an idempotency-style identifier so duplicate
    // postbacks do not double-count revenue.
    const body = {
      destinationId,
      eventData: [{
        eventId: event.dedupe_key,
        eventTime: event.conversion_time,
        userIdentifiers: [{ [click.kind]: click.value }],
        conversionValue: {
          value: event.conversion_value,
          currencyCode: event.currency_code,
        },
        conversionActionId: event.google_ads_conversion_action_id,
        transactionId: event.dedupe_key,
      }],
    };

    let res: Response;
    try {
      res = await fetch(DATA_MANAGER_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { kind: "retryable", error: { message: `network: ${String(e)}` } };
    }

    const respText = await res.text();
    let respJson: unknown;
    try { respJson = JSON.parse(respText); } catch { respJson = respText; }

    if (res.ok) {
      return { kind: "success", response: respJson };
    }
    // 4xx → permanent (bad request, invalid id, etc.)
    // 5xx, 408, 429 → retryable.
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { kind: "retryable", error: { status: res.status, body: respJson } };
    }
    return { kind: "permanent", error: { status: res.status, body: respJson } };
  },
};
