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
