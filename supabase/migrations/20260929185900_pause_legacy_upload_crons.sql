-- Pause the legacy Google offline-conversion crons (owner, 2026-09-29). Applied live the same day.
--
-- upload-google-offline-conversions had sent no Caliber call since the 2026-09-19 internet
-- cutover (Caliber rows are stored 'ignored') and no Ringba call since Ringba ended on
-- 2026-09-22. rematch-offline-conversions only feeds it. Legacy backlog was 0, so the health
-- check's legacy "stalled" alert cannot fire.
-- Paused, not unscheduled: to undo, set active := true.

select cron.alter_job(jobid, active := false)
  from cron.job
 where jobname in ('upload-google-offline-conversions', 'rematch-offline-conversions');
