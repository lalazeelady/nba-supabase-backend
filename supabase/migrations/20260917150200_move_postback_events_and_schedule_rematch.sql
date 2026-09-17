-- Move the test rows from postback_events into postbacks, drop postback_events, and
-- schedule the hourly rematch. Run AFTER postback-transfer-webhook and
-- postback-monetize-webhook v4 are deployed (they write to postbacks), so no row
-- arrives in postback_events after the copy.
--
-- Values come from raw_payload (what Caliber sent), not from the old columns, which
-- had lead values mixed in. The insert trigger matches each row to its lead.

insert into public.postbacks (
  received_at, cv_source, event_type, offer, conversion_time, conversion_value,
  caliber_call_id, calltools_call_id, transaction_id, phone, email, state,
  gclid, gbraid, wbraid, msclkid, fbclid, oppref, utm_source, ib_source, raw_payload)
select
  e.created_at,
  'caliber',
  case e.event_type when 'call_transferred' then 'transfer' else 'monetize' end,
  nullif(regexp_replace(regexp_replace(lower(trim(coalesce(r->>'offer', r->>'program', ''))), '^cpn_', ''), '[^a-z0-9]+', '_', 'g'), ''),
  e.conversion_time,
  case e.event_type when 'call_transferred' then 0 else e.conversion_value end,
  e.conversion_call_id,
  nullif(trim(r->>'call_id'), ''),
  nullif(trim(r->>'transaction_id'), ''),
  nullif(right(regexp_replace(coalesce(r->>'caller_id', ''), '\D', '', 'g'), 10), ''),
  nullif(lower(trim(r->>'email')), ''),
  nullif(upper(trim(r->>'state')), ''),
  nullif(trim(r->>'gclid'), ''),
  nullif(trim(r->>'gbraid'), ''),
  nullif(trim(r->>'wbraid'), ''),
  nullif(trim(r->>'msclkid'), ''),
  nullif(trim(r->>'fbclid'), ''),
  nullif(trim(coalesce(r->>'oppref', r->>'oppref_id')), ''),
  nullif(trim(r->>'utm_source'), ''),
  nullif(trim(r->>'ib_source'), ''),
  r
from public.postback_events e
cross join lateral (select e.raw_payload - 'secret' as r) x
where e.conversion_call_id is not null
  and length(right(regexp_replace(coalesce(e.raw_payload->>'caller_id', ''), '\D', '', 'g'), 10)) = 10
on conflict (caliber_call_id, event_type) do nothing;

drop table public.postback_events;

select cron.schedule('rematch-postbacks-hourly', '13 * * * *', $$ select public.rematch_postbacks(7); $$);
