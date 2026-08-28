# EDU monetizations — deferred (Phase 8, low priority)

**Status:** not built. Documented so it isn't forgotten.

**Situation:** EDU is one LOB. EDU **transfers** already arrive in Ringba as normal transfers and are
counted like any other Ringba transfer (no change needed). EDU **monetizations/conversions** are NOT
pixel-fired — they're entered **manually at end of day**. Volume is low.

**Goal:** account for EDU monetized calls + revenue automatically, so the picture is complete.

**Blocker:** no known data source yet — we don't know where an EDU monetization would fire from
(Ringba? a separate EDU buyer postback? a sheet the owner fills?).

**When ready, likely shape:**
- If EDU monetizations can post to a webhook: they'd flow through `ringba-conversion-webhook` like any
  Ringba monetization (RGB id → per-call, revenue attached) — possibly with a `program=EDU` tag for
  reporting. No new action needed unless EDU needs its own conversion action.
- If they stay manual: a small importer that reads the owner's EOD source (sheet/CSV) and inserts
  `call_converted_revenue` rows (publisher=NBA, per-call id, revenue) — deduped like the rest.

**Next step (owner):** decide/confirm where EDU monetization data will come from, then we spec it.
