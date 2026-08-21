-- Durable fix, cleanup: remove the 30s stopgap now that the read is fast.
--
-- APPLY LAST — only after 20260821000200 is live and the export read is confirmed
-- well under 8s (re-run the health probe / a real cron cycle first). Resetting drops
-- service_role back to the inherited 8s limit; if anything regressed you'd see the
-- timeout again, so confirm the fast view first.

alter role service_role reset statement_timeout;
-- (equivalent to the platform default; the 8s comes from the authenticator role.)
-- Remember: notify pgrst, 'reload config';  so PostgREST picks up the change.
