-- Offline-CV accuracy, step 0: additive columns only. ZERO behavior change.
--
-- Pure `add column if not exists` — no data rewritten, no view/trigger/function touched,
-- nothing uploaded differently. Safe to apply independently and ahead of the behavior
-- changes; later phases populate and read these.
--
-- offline_conversion_events — new fields carried by the Caliber pixel (and useful for
-- reporting on the existing pixels where present):
--   ib_source     -- inbound route / source phone number. Drives the Google-upload source
--                    filter. Always present from CallTools/Caliber; often blank from Ringba.
--   oppref        -- OpenAI ads click id (Caliber param `oppref_id`).
--   msclkid       -- Microsoft/Bing click id.
--   fbclid        -- Meta/Facebook click id (stored for completeness; Meta has its own DB).
--   call_type     -- e.g. 'inbound' / 'outbound' (future outbound-callback inclusion).
--   queue         -- call-center queue (NBA Queue / NBA Afterhours) for reporting/splits.
--   agent_name    -- handling agent (Caliber `agent_name`).
--   call_status   -- Caliber call status (e.g. 'connected' / 'no connect'). NOTE: distinct from
--                    the pipeline `status` column. 'no connect' fires are dropped before dedup,
--                    so stored rows carry the real (connected) status; kept for visibility.
--
-- leads:
--   lead_source   -- which source submitted the lead (google / bing / openai / other).
--   landing_page  -- landing-page identifier (apply1 / apply2 / info01 / ...). Backend-ready now;
--                    the funnel pages start sending it in a later, site-repo task. Nullable.

alter table public.offline_conversion_events
  add column if not exists ib_source   text,
  add column if not exists oppref      text,
  add column if not exists msclkid     text,
  add column if not exists fbclid      text,
  add column if not exists call_type   text,
  add column if not exists queue       text,
  add column if not exists agent_name  text,
  add column if not exists call_status text;

alter table public.leads
  add column if not exists lead_source  text,
  add column if not exists landing_page text,
  add column if not exists msclkid      text,   -- Bing click id
  add column if not exists oppref       text,   -- OpenAI click id
  add column if not exists fbclid       text;   -- Meta click id

comment on column public.offline_conversion_events.ib_source is
  'Inbound route / source phone number (CallTools/Caliber). Drives the Google-upload source filter.';
comment on column public.offline_conversion_events.call_status is
  'Caliber call status (connected / no connect / ...). Distinct from the pipeline `status` column.';
comment on column public.leads.lead_source is
  'Which source submitted the lead (google/bing/openai/other). Populated by submit-lead.';
comment on column public.leads.landing_page is
  'Landing-page identifier (apply1/apply2/info01/...). Sent by the funnel in a later site-repo task.';
