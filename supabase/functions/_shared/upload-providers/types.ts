// Shared types for the offline-conversion upload adapters.
//
// Each provider implements UploadProvider.upload(). The uploader function
// (upload-google-offline-conversions) selects which provider to use based
// on the GOOGLE_UPLOAD_PROVIDER env var. Adding a new provider is a matter
// of dropping a new file in this directory and registering it in index.ts
// — the rest of the pipeline does not change.

export interface ConversionEvent {
  id: string;
  conversion_time: string;        // ISO timestamp
  conversion_value: number;
  currency_code: string;          // e.g. "USD"
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  dedupe_key: string;             // also used as Google order_id
  google_ads_customer_id: string | null;
  google_ads_conversion_action_id: string | null;
  google_ads_conversion_action_name: string | null;

  // Enhanced Conversions for Leads: first-party PII to send hashed alongside
  // (or instead of) adIdentifiers. Matched events should be enriched with
  // lead-table PII before reaching the provider; unmatched events fall back
  // to whatever Ringba forwarded (e.g. caller_id only).
  pii?: {
    email?: string | null;
    phone?: string | null;        // any format; provider normalizes to E.164
    first_name?: string | null;
    last_name?: string | null;
    zip?: string | null;          // sent plaintext per Google
    state?: string | null;        // ISO 3166-2 region code; plaintext
    country?: string | null;      // ISO 3166-1 alpha-2; default "US"
  };
}

export type UploadOutcome =
  | { kind: "success"; response: unknown }
  | { kind: "retryable"; error: unknown }
  | { kind: "permanent"; error: unknown };

export interface UploadProvider {
  name: string;
  upload(event: ConversionEvent): Promise<UploadOutcome>;
}

// Pick the click identifier we will send to Google. Exactly one is allowed
// per event; gclid wins, then gbraid, then wbraid.
export function pickClickIdentifier(
  event: ConversionEvent,
): { kind: "gclid" | "gbraid" | "wbraid"; value: string } | null {
  if (event.gclid) return { kind: "gclid", value: event.gclid };
  if (event.gbraid) return { kind: "gbraid", value: event.gbraid };
  if (event.wbraid) return { kind: "wbraid", value: event.wbraid };
  return null;
}
