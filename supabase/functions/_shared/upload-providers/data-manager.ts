// Google Data Manager API upload provider (Phase 1B primary path).
//
// Endpoint: POST https://datamanager.googleapis.com/v1/events:ingest
//
// Why Data Manager (not the classic Ads API): Data Manager API only
// requires OAuth — no Developer Token approval — so we can ship offline
// click-conversion uploads without waiting on Standard-tier access. The
// google-ads.ts provider is kept as a fallback for the same shape of
// event.
//
// Required setup before this provider can succeed:
//   - GOOGLE_ADS_CUSTOMER_ID         (operating account, no dashes)
//   - GOOGLE_LOGIN_CUSTOMER_ID       (manager account / MCC, no dashes)
//   - GOOGLE_DATA_MANAGER_DESTINATION_ID
//        — the numeric Google Ads conversion action id (ctId from the
//          Ads UI URL). Must be an Import-from-clicks (UPLOAD_CLICKS)
//          action; UPLOAD_CALLS actions reject gclid-based events.
//        — Also: this conversion action must have Enhanced Conversions
//          for Leads enabled in the Google Ads UI for userIdentifiers
//          to be honored (otherwise Google ignores the hashed PII).
//   - OAuth refresh token minted with both scopes:
//        https://www.googleapis.com/auth/adwords
//        https://www.googleapis.com/auth/datamanager
//
// Endpoint can be overridden via GOOGLE_DATA_MANAGER_ENDPOINT for staging.
//
// Match strategy:
//   1. adIdentifiers (gclid/gbraid/wbraid) — strongest, when present
//   2. userIdentifiers — hashed PII for Enhanced Conversions for Leads,
//      attached to every event when we have any. Google ORs the userIdentifier
//      entries and combines with adIdentifiers for the highest match rate.

import {
  ConversionEvent,
  UploadOutcome,
  UploadProvider,
  pickClickIdentifier,
} from "./types.ts";
import { getGoogleAccessToken } from "./google-oauth.ts";

const DATA_MANAGER_ENDPOINT =
  Deno.env.get("GOOGLE_DATA_MANAGER_ENDPOINT") ||
  "https://datamanager.googleapis.com/v1/events:ingest";

// ---- Hashing & normalization ---------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return trimmed;
}

function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  return trimmed || null;
}

// Data Manager API field naming differs from the classic Ads API:
//   emailAddress  (not hashedEmail)
//   phoneNumber   (not hashedPhoneNumber)
//   address.givenName / familyName  (not hashedFirstName / hashedLastName)
//   regionCode    is the ISO 3166-1 alpha-2 country code on Address; there is
//                 no separate countryCode field. State is not currently sent.
// The hex-encoded SHA-256 is signaled at the request level via encoding:"HEX".
async function buildUserIdentifiers(
  pii: ConversionEvent["pii"],
): Promise<Array<Record<string, unknown>>> {
  const ids: Array<Record<string, unknown>> = [];
  if (!pii) return ids;

  const email = normalizeEmail(pii.email);
  if (email) ids.push({ emailAddress: await sha256Hex(email) });

  const phone = normalizePhoneE164(pii.phone);
  if (phone) ids.push({ phoneNumber: await sha256Hex(phone) });

  const first = normalizeName(pii.first_name);
  const last = normalizeName(pii.last_name);
  const zip = pii.zip ? String(pii.zip).trim() : null;
  const country = (pii.country ? String(pii.country).trim() : "US").toUpperCase();

  if (first && last && zip) {
    ids.push({
      address: {
        givenName: await sha256Hex(first),
        familyName: await sha256Hex(last),
        postalCode: zip,
        regionCode: country,
      },
    });
  }

  return ids;
}

// ---- Provider ------------------------------------------------------------

export const dataManagerProvider: UploadProvider = {
  name: "data_manager",
  async upload(event: ConversionEvent): Promise<UploadOutcome> {
    const click = pickClickIdentifier(event);
    const userIdentifiers = await buildUserIdentifiers(event.pii);

    if (!click && userIdentifiers.length === 0) {
      return {
        kind: "permanent",
        error: {
          message:
            "No matchable identifiers: event has no click id (gclid/gbraid/wbraid) and no hashed PII",
        },
      };
    }

    const operatingAccountId =
      event.google_ads_customer_id || Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "";
    const loginAccountId = Deno.env.get("GOOGLE_LOGIN_CUSTOMER_ID") || "";
    const productDestinationId =
      Deno.env.get("GOOGLE_DATA_MANAGER_DESTINATION_ID") ||
      event.google_ads_conversion_action_id ||
      "";

    if (!operatingAccountId || !productDestinationId) {
      return {
        kind: "retryable",
        error: {
          message:
            "Data Manager not configured: GOOGLE_ADS_CUSTOMER_ID / GOOGLE_DATA_MANAGER_DESTINATION_ID missing",
        },
      };
    }

    let accessToken: string;
    try {
      accessToken = await getGoogleAccessToken();
    } catch (e) {
      return { kind: "retryable", error: { message: String(e) } };
    }

    const destination: Record<string, unknown> = {
      operatingAccount: {
        accountType: "GOOGLE_ADS",
        accountId: operatingAccountId,
      },
      productDestinationId,
    };
    // loginAccount is required when the OAuth user accesses the
    // operating account through a manager (MCC). Both fields use
    // accountType GOOGLE_ADS regardless of MCC vs sub-account — the
    // enum is google.ads.datamanager.v1.ProductAccount.AccountType
    // and the value is GOOGLE_ADS, not GOOGLE_ADS_ACCOUNT.
    if (loginAccountId) {
      destination.loginAccount = {
        accountType: "GOOGLE_ADS",
        accountId: loginAccountId,
      };
    }

    const eventBody: Record<string, unknown> = {
      transactionId: event.dedupe_key,
      eventTimestamp: event.conversion_time,
      eventSource: "WEB",
      currency: event.currency_code,
      conversionValue: event.conversion_value,
    };
    if (click) {
      const adIdentifiers: Record<string, string> = {};
      adIdentifiers[click.kind] = click.value;
      eventBody.adIdentifiers = adIdentifiers;
    }
    if (userIdentifiers.length > 0) {
      // userIdentifiers is nested under userData on Data Manager events,
      // not at the event top level — distinct from Google Ads API's flat
      // ClickConversion.user_identifiers shape.
      eventBody.userData = { userIdentifiers };
    }

    const body = {
      destinations: [destination],
      // Hashed values are HEX-encoded SHA-256.
      encoding: "HEX",
      events: [eventBody],
      validateOnly: false,
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
      // Data Manager returns { requestId } on success and surfaces any
      // event-level problems via HTTP error codes, not an inline errors
      // array. So a 2xx response means the event was accepted.
      return { kind: "success", response: respJson };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { kind: "retryable", error: { status: res.status, body: respJson } };
    }
    return { kind: "permanent", error: { status: res.status, body: respJson } };
  },
};
