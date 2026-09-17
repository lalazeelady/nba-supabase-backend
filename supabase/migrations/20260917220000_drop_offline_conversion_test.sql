-- P3.1: the CallTools test pixel was removed by the owner on 2026-09-17 (last call 6:26pm ET,
-- then silent). Its sink is no longer written to and nothing reads it: no view, no function, no
-- foreign key. 13,871 rows, none of which ever reached Google.
-- The `ringba-conversion-webhook-test` function must still be deleted in the dashboard or with
-- `supabase functions delete`; until then it answers 503 if anything ever calls it again.
drop table public.offline_conversion_test;
