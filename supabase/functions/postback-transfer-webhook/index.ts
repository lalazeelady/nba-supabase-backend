// postback-transfer-webhook (v4, 2026-09-17)
//
// Caliber transfer postbacks -> public.postbacks. All logic is in ../_shared/postback-handler.ts,
// shared with the other postback endpoint so the two cannot drift apart. This endpoint
// only sets the event type: a postback sent here is a transfer.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handlePostback } from "../_shared/postback-handler.ts";

Deno.serve((req: Request) => handlePostback(req, "transfer", "postback-transfer-webhook"));
