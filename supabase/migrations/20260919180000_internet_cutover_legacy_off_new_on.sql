-- Internet cutover (owner, 2026-09-19, weekend with no traffic). Applied live the same day.
--
-- From the cutover moment the NEW pipeline uploads Internet and the LEGACY one stops.
-- Both pixels keep firing; only the uploads move.
--
-- Legacy side: a Caliber row created for a call at/after the cutover is stored with
-- status 'ignored', which the uploader's status filter does not select, so it never uploads.
-- Everything else about the legacy path is untouched: Ringba keeps uploading, the views,
-- triggers and reports are unchanged, and rows already uploaded stay uploaded.
-- Rollback: drop the trigger, or move the cutover to a future date.
--
-- New side: Internet uploads that belong to calls BEFORE the cutover are marked
-- 'uploaded_by_legacy' so Google never receives them twice, then the hold is released.
--
-- Checked first on 2026-09-18 (the last full day of traffic):
--   legacy stored 731 Internet rows and uploaded 660 ($4,289)
--   the new pipeline, under the SAME rules, would have uploaded 732 ($4,753) - parity
--   under the new rules (no unknown-source calls) it uploads 486 ($3,163)
--   the difference is the owner's rule: unknown-source calls never upload.

create or replace function public.legacy_caliber_upload_cutover()
returns timestamptz language sql immutable
as $$ select timestamptz '2026-09-19 17:00:00-04' $$;
comment on function public.legacy_caliber_upload_cutover() is
  'Internet cutover: Caliber calls at/after this moment are stored by the LEGACY pipeline as status ''ignored'' and never uploaded there; the postbacks pipeline uploads them instead. Move to a future date to roll back.';

create or replace function public.legacy_caliber_hold()
returns trigger language plpgsql
as $$
begin
  if new.source = 'caliber' and new.conversion_time >= legacy_caliber_upload_cutover() then
    new.status := 'ignored';
  end if;
  return new;
end;
$$;

create trigger trg_zz_legacy_caliber_hold
  before insert on public.offline_conversion_events
  for each row execute function public.legacy_caliber_hold();

update public.offline_conversion_events
   set status = 'ignored'
 where source = 'caliber'
   and conversion_time >= legacy_caliber_upload_cutover()
   and status in ('monetize_ready', 'transfer_ready', 'ready_to_upload');

update public.platform_uploads u
   set status = 'skipped', skip_reason = 'uploaded_by_legacy'
  from public.postbacks p
 where p.id = u.postback_id
   and u.status = 'pending'
   and p.offer = 'internet'
   and p.conversion_time < legacy_caliber_upload_cutover();

update public.offer_rules
   set uploads_held = false,
       note = note || ' · released 2026-09-19 17:00 ET: legacy uploads off from the same moment'
 where offer = 'internet';
