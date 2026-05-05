// Provider selector.
//
// GOOGLE_UPLOAD_PROVIDER controls which adapter the uploader uses:
//   dry_run      — log the intended payload, do not call Google (default)
//   data_manager — Google Data Manager API (Phase 1B primary)
//   google_ads   — Google Ads API UploadClickConversions (alternate)
//
// GOOGLE_UPLOAD_ENABLED=false forces dry_run regardless of provider, as a
// safety belt during testing.

import { UploadProvider } from "./types.ts";
import { dryRunProvider } from "./dry-run.ts";
import { dataManagerProvider } from "./data-manager.ts";
import { googleAdsProvider } from "./google-ads.ts";

export { ConversionEvent, UploadOutcome, UploadProvider } from "./types.ts";

export function selectProvider(): UploadProvider {
  const enabled = (Deno.env.get("GOOGLE_UPLOAD_ENABLED") || "false").toLowerCase() === "true";
  if (!enabled) return dryRunProvider;

  const name = (Deno.env.get("GOOGLE_UPLOAD_PROVIDER") || "dry_run").toLowerCase();
  switch (name) {
    case "data_manager": return dataManagerProvider;
    case "google_ads":   return googleAdsProvider;
    case "dry_run":      return dryRunProvider;
    default:
      console.warn(`Unknown GOOGLE_UPLOAD_PROVIDER="${name}", falling back to dry_run`);
      return dryRunProvider;
  }
}
