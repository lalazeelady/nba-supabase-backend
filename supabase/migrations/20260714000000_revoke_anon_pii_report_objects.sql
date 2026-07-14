-- Already applied to live on 2026-07-14 via MCP (recorded here to keep repo == live).
--
-- The public anon key (embedded in the funnel HTML) could read lead PII and
-- business metrics through SECURITY DEFINER report objects that bypass RLS.
-- Revoke anon/authenticated access on the exposed objects and make the views
-- honor the querying role's RLS. The token-gated lead_report_leads() is left
-- callable intentionally.

revoke select on public.lead_report_detail from anon, authenticated;
revoke select on public.lead_report_daily from anon, authenticated;
revoke select on public.v_google_sheet_export_unsynced from anon, authenticated;
revoke execute on function public.lead_report_daily_recent(integer) from anon, authenticated;

alter view public.lead_report_detail set (security_invoker = true);
alter view public.lead_report_daily set (security_invoker = true);
alter view public.v_google_sheet_export_unsynced set (security_invoker = true);
