-- Bing manual uploads (owner, 2026-09-25)
--
-- Until the uploader sends Bing, offline conversions were uploaded by hand to Microsoft Ads
-- as CallMonetize, keyed on msclkid, from the Microsoft "Enhanced Import" Excel template.
-- This table records those uploads (from the 5 files dated 2026-09-16 .. 2026-09-23), so the
-- uploader never sends the same conversion twice when Bing goes live.
--
-- Loaded from the Excel files with scripts/load_bing_manual_uploads.py. The files overlap,
-- so the unique key keeps one row per (msclkid, conversion_time). Times are UTC
-- (the template's "Parameters:TimeZone=+0000").
-- Loaded 2026-09-25 (all 5 files, 1,201 unique rows). The match rule was later changed to
-- msclkid only: see 20260925145907_bing_manual_match_msclkid_only_send_all_transfers.sql.
--
-- A platform_uploads bing row is marked skipped / 'uploaded_manually' when the same msclkid
-- was uploaded by hand within an hour of it — see mark_bing_manual_uploads().
--
-- Also adds cron upload-platform-conversions-bing-15min. Harmless until BING_UPLOAD_MODE=live:
-- in dry_run it only builds and stores the conversion.

create table if not exists public.bing_manual_uploads (
  msclkid          text        not null,
  conversion_time  timestamptz not null,
  conversion_value numeric     not null,
  conversion_name  text        not null,
  source_file      text        not null,
  loaded_at        timestamptz not null default now(),
  primary key (msclkid, conversion_time)
);

alter table public.bing_manual_uploads enable row level security;
revoke all on table public.bing_manual_uploads from anon, authenticated;

comment on table public.bing_manual_uploads is
  'Bing offline conversions uploaded by hand before the uploader sent Bing. Used to skip them. See docs/bing-offline-conversions/README.md';

-- Marks pending Bing rows already uploaded by hand. Manual uploads were CallMonetize only,
-- so only monetize rows are skipped; transfer rows (CallXfer) were never uploaded by hand.
-- Match: same msclkid and times within 1 hour. The manual time came from a different export
-- and differs by seconds to minutes (142 of 152 matches within 2 min), so Microsoft would not
-- see them as the same conversion. A same-click call hours later is a separate conversion
-- and still uploads. Returns the number of rows marked.
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
       and exists (select 1 from public.bing_manual_uploads m
                    where m.msclkid = v.msclkid
                      and abs(extract(epoch from m.conversion_time - v.conversion_time)) <= 3600)
    returning u.id
  )
  select count(*)::int from marked;
$$;

revoke all on function public.mark_bing_manual_uploads() from public, anon, authenticated;

select public.mark_bing_manual_uploads();

select cron.schedule('upload-platform-conversions-bing-15min', '7,22,37,52 * * * *', $cron$
  select net.http_post(
    url := 'https://quhxbgsgtfvrasyjvaba.supabase.co/functions/v1/upload-platform-conversions?platform=bing&limit=150',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-invoke-secret', (select decrypted_secret from vault.decrypted_secrets where name='uploader_invoke_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$cron$);
