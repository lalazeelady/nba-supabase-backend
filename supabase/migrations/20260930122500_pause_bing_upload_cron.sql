-- Bing uploads moved to Caliber (owner, 2026-09-30 ~08:20 ET). Applied live 2026-09-30 08:24 ET.
--
-- Caliber uploads Bing conversions directly. Our last Bing send was 2026-09-29 20:37 ET and
-- nothing was pending at the pause, so every Bing call before Caliber's start was already sent
-- by us. Caliber must upload only calls after its start time, or they are counted twice
-- (Caliber's order ids differ from ours; Microsoft dedupes only on click id + goal + time).
-- Paused, not unscheduled: to undo, set active := true.
-- With both upload crons paused, queue_platform_uploads() no longer runs, so no new
-- platform_uploads rows are created.

select cron.alter_job(jobid, active := false)
  from cron.job
 where jobname = 'upload-platform-conversions-bing-15min';
