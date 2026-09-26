-- Health check: Bing-aware (2026-09-26).
-- * upload_checks_failed_last_24h counts Google validate_only checks only. Bing dry runs were
--   raising "N upload check(s) failed" hourly for rows with no msclkid, which live mode skips.
-- * New: Bing stuck-queue alert. Bing counts as live once it has sent anything in 7 days; the
--   alert fires when rows have waited over 2h AND nothing was sent in the last hour (the go-live
--   backlog drains 150 rows per 15-minute run, so a busy queue does not alert).
CREATE OR REPLACE FUNCTION public.postback_health(p_uploads_live boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  et            timestamp := now() at time zone 'America/New_York';
  business_hrs  boolean   := extract(isodow from et) between 1 and 5 and extract(hour from et) between 10 and 19;
  -- Bing has no env switch here: it counts as live once it has sent anything in the last 7 days.
  bing_live     boolean   := exists (select 1 from platform_uploads where platform = 'bing' and status = 'sent'
                                        and sent_at > now() - interval '7 days');
  m             jsonb;
  problems      text[]    := '{}';
begin
  select jsonb_build_object(
    'last_transfer_at',              (select max(received_at) from postbacks where event_type = 'transfer'),
    'last_monetize_at',              (select max(received_at) from postbacks where event_type = 'monetize'),
    'transfers_last_2h',             (select count(*) from postbacks where event_type = 'transfer' and received_at > now() - interval '2 hours'),
    'transfers_last_7d',             (select count(*) from postbacks where event_type = 'transfer' and received_at > now() - interval '7 days'),
    'monetize_last_2h',              (select count(*) from postbacks where event_type = 'monetize' and received_at > now() - interval '2 hours'),
    'rows_last_24h',                 (select count(*) from postbacks where received_at > now() - interval '24 hours'),
    'match_rate_last_24h',           (select round(avg((lead_id is not null)::int), 3) from postbacks where received_at > now() - interval '24 hours'),
    'rows_prior_7d',                 (select count(*) from postbacks where received_at between now() - interval '8 days' and now() - interval '24 hours'),
    'match_rate_prior_7d',           (select round(avg((lead_id is not null)::int), 3) from postbacks
                                       where received_at between now() - interval '8 days' and now() - interval '24 hours'),
    -- Google validate_only checks only. A Bing dry run is not a check against Microsoft; its
    -- ok=false only means "no msclkid", which live mode skips as no_msclkid.
    'upload_checks_failed_last_24h', (select count(*) from platform_uploads
                                       where platform = 'google' and validated_at > now() - interval '24 hours' and (last_result->>'ok') = 'false'),
    'uploads_failed_last_24h',       (select count(*) from platform_uploads where status = 'failed' and last_attempt_at > now() - interval '24 hours'),
    'uploads_pending_over_2h',       (select count(*) from platform_uploads where status = 'pending' and platform = 'google' and created_at < now() - interval '2 hours'),
    'bing_live',                     bing_live,
    'bing_sent_last_1h',             (select count(*) from platform_uploads where platform = 'bing' and status = 'sent' and sent_at > now() - interval '1 hour'),
    'bing_pending_over_2h',          (select count(*) from platform_uploads p join v_platform_uploads_pending v on v.upload_id = p.id
                                       where p.platform = 'bing' and p.created_at < now() - interval '2 hours'),
    'business_hours',                business_hrs
  ) into m;

  if business_hrs and (m->>'monetize_last_2h')::int = 0 then
    problems := problems || 'No monetize postbacks in the last 2 hours (weekday business hours). Check the Caliber pixel and the postback-monetize-webhook logs for 401/422.';
  end if;
  if business_hrs and (m->>'transfers_last_7d')::int > 0 and (m->>'transfers_last_2h')::int = 0 then
    problems := problems || 'No transfer postbacks in the last 2 hours, but transfers arrived this week. Check the Caliber transfer pixel.';
  end if;
  if (m->>'rows_last_24h')::int >= 50 and (m->>'rows_prior_7d')::int >= 200
     and (m->>'match_rate_last_24h')::numeric < (m->>'match_rate_prior_7d')::numeric - 0.15 then
    problems := problems || format('Lead match rate dropped: %s in the last 24h vs %s the prior 7 days. Check transaction_id / email / phone values from Caliber.',
                                   m->>'match_rate_last_24h', m->>'match_rate_prior_7d');
  end if;
  if (m->>'upload_checks_failed_last_24h')::int > 0 then
    problems := problems || format('%s upload check(s) failed in the last 24h (validate_only / dry run). See platform_uploads.last_result.', m->>'upload_checks_failed_last_24h');
  end if;
  if (m->>'uploads_failed_last_24h')::int > 0 then
    problems := problems || format('%s upload(s) FAILED in the last 24h. See platform_uploads.last_result.', m->>'uploads_failed_last_24h');
  end if;
  if p_uploads_live and (m->>'uploads_pending_over_2h')::int > 0 then
    problems := problems || format('%s upload(s) pending for over 2 hours while uploads are live. Is the uploader running?', m->>'uploads_pending_over_2h');
  end if;
  -- Stuck, not busy: rows waiting over 2h and nothing sent for an hour (the go-live backlog drains
  -- 150 rows per 15-minute run, so a busy queue still shows recent sends).
  if bing_live and (m->>'bing_pending_over_2h')::int > 0 and (m->>'bing_sent_last_1h')::int = 0 then
    problems := problems || format('%s Bing upload(s) pending for over 2 hours while Bing is live. Check cron upload-platform-conversions-bing-15min and platform_uploads.last_result (Microsoft login / developer token).', m->>'bing_pending_over_2h');
  end if;

  if extract(hour from et) = 10 then
    problems := problems || public.recon_divergence_problems();
  end if;
  return m || jsonb_build_object('checked_at', now(), 'problems', to_jsonb(problems));
end;
$function$;
