// Dry-run upload provider.
//
// Used during Phase 1A and any time GOOGLE_UPLOAD_ENABLED=false. It logs
// the exact payload that would be sent to Google but performs no network
// call. Rows handled by this provider stay at status=ready_to_upload so
// the next run picks them up once a real provider is enabled — they are
// NOT marked uploaded.
//
// The uploader function checks for this provider by name and skips its
// usual status-update path, so behavior is intentional, not accidental.

import { ConversionEvent, UploadOutcome, UploadProvider, pickClickIdentifier } from "./types.ts";

export const dryRunProvider: UploadProvider = {
  name: "dry_run",
  async upload(event: ConversionEvent): Promise<UploadOutcome> {
    const click = pickClickIdentifier(event);
    const intended = {
      provider: "dry_run",
      event_id: event.id,
      customer_id: event.google_ads_customer_id,
      conversion_action_id: event.google_ads_conversion_action_id,
      conversion_action_name: event.google_ads_conversion_action_name,
      click_identifier: click,
      conversion_time: event.conversion_time,
      conversion_value: event.conversion_value,
      currency_code: event.currency_code,
      order_id: event.dedupe_key,
    };
    console.log("[dry_run] would upload:", JSON.stringify(intended));
    return { kind: "success", response: { dry_run: true, intended } };
  },
};
