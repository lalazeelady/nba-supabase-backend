-- Owner rule, 2026-09-25:
--   * A Bing monetize row is excluded when its msclkid appears in the manual uploads — msclkid
--     only, no time window. Otherwise it uploads by the normal rules.
--   * All Bing transfers send (CallXfer was never uploaded by hand).
-- bing_manual_uploads now holds all 5 manual files (1,201 unique rows, $15,541.50).
-- The uploader calls mark_bing_manual_uploads() before every Bing batch.

create or replace function public.mark_bing_manual_uploads()
returns integer
language sql
security definer
set search_path = public
as $$
  with marked as (
    update public.platform_uploads u
       set status = 'skipped', skip_reason = 'uploaded_manually'
      from public.v_postbacks v
     where v.postback_id = u.postback_id
       and u.platform = 'bing'
       and u.conversion_action = 'monetize'
       and u.status = 'pending'
       and exists (select 1 from public.bing_manual_uploads m where m.msclkid = v.msclkid)
    returning u.id
  )
  select count(*)::int from marked;
$$;
revoke all on function public.mark_bing_manual_uploads() from public, anon, authenticated;
grant execute on function public.mark_bing_manual_uploads() to service_role;

-- 'uploaded_by_legacy' was never true for Bing (the legacy uploader sent Google only), and the
-- earlier 1-hour manual match is replaced by msclkid-only. Re-open those Bing rows, then re-mark.
update public.platform_uploads
   set status = 'pending', skip_reason = null
 where platform = 'bing' and status = 'skipped'
   and skip_reason in ('uploaded_by_legacy', 'uploaded_manually');

select public.mark_bing_manual_uploads();
