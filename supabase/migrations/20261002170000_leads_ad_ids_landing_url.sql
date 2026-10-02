-- Caliber attribution ids (Jonathan, Caliber, 2026-10-02). The funnel now captures the
-- Google/Bing ValueTrack ids, the full landing URL and the browser referrer, and
-- submit-lead stores them here as well as sending them to Caliber in `attribution`.
--
-- landing_page (short funnel id, e.g. info02) and referrer (HTTP Referer of the submit,
-- i.e. our own last funnel step) are unchanged: reports and the apply-subdomain filter
-- depend on them.
alter table public.leads
  add column if not exists gcid text,           -- Google campaign id
  add column if not exists gagid text,          -- Google ad group id
  add column if not exists gkid text,           -- Google keyword / target id
  add column if not exists gad text,            -- Google ad (creative) id
  add column if not exists mcid text,           -- Bing campaign id
  add column if not exists magid text,          -- Bing ad group id
  add column if not exists mkid text,           -- Bing keyword id
  add column if not exists mad text,            -- Bing ad id
  add column if not exists landing_url text,    -- full first landing URL incl. query string
  add column if not exists page_referrer text;  -- document.referrer on that landing page

comment on column public.leads.landing_url is 'Full landing URL (with query string) captured in the browser on the first funnel page. Sent to Caliber as attribution.landing_page.';
comment on column public.leads.page_referrer is 'document.referrer on the landing page (e.g. https://www.google.com/). Sent to Caliber as attribution.referrer. Differs from leads.referrer, which is the HTTP Referer of the submit request.';
