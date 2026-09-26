-- Attribution: a transaction-id match decides the platform (owner, 2026-09-25). Both platforms.
--
-- When a postback is matched to its lead by transaction_id (our own lead id), the LEAD's source
-- decides the platform — the lead's utm_source first, then the lead's click ids — and the
-- postback's own click ids are ignored. Why: Caliber attaches a gclid to calls whose lead
-- came from Bing (utm_source=bing, landing bg1/apply2); under the old order the gclid won and
-- those calls went to Google. attribution = 'transaction_id', confidence = 'absolute'.
-- A transaction-id lead with no source at all falls through to the old order.
--
-- Impact when applied (all history): 35 monetize ($309) + 8 transfers google -> bing,
-- 2 transfers google -> meta. 32 of them were already sent to Google and stay sent; nothing
-- pending on Google changed. The next queue run adds their Bing rows.
--
-- Column list is unchanged, so dependent views (v_platform_uploads_pending, v_recon_daily,
-- v_recon_scorecard) are untouched.

create or replace view public.v_postbacks with (security_invoker = true) as
 SELECT p.id AS postback_id,
    p.received_at,
    ((p.conversion_time AT TIME ZONE 'America/New_York'::text))::date AS conversion_date_et,
    p.conversion_time,
    p.cv_source,
    p.event_type,
    p.offer,
    p.conversion_value,
    p.caliber_call_id,
    p.calltools_call_id,
    p.transaction_id,
    p.lead_id,
    p.match_method,
    l.transaction_id AS lead_transaction_id,
    l.caliber_lead_id AS lead_caliber_lead_id,
    l.crm_lead_id AS lead_calltools_contact_id,
    l.created_at AS lead_created_at,
    COALESCE(p.phone, NULLIF("right"(regexp_replace(COALESCE(l.phone, ''::text), '\D'::text, ''::text, 'g'::text), 10), ''::text)) AS phone,
    COALESCE(p.email, NULLIF(l.email, ''::text)) AS email,
    COALESCE(p.state, NULLIF(l.state, ''::text)) AS state,
    l.first_name,
    l.last_name,
    l.street_address,
    l.city,
    l.zip,
    l.ip_address,
    l.user_agent,
    k.gclid,
    k.gbraid,
    k.wbraid,
    k.msclkid,
    k.fbclid,
    k.oppref,
    k.utm_source,
    l.utm_medium,
    l.utm_campaign,
    l.utm_content,
    l.utm_term,
    l.landing_page,
    p.ib_source,
    ibp.platform AS ib_source_platform,
    split_part(a.pa, '|'::text, 1) AS platform,
    split_part(a.pa, '|'::text, 2) AS attribution,
        CASE split_part(a.pa, '|'::text, 2)
            WHEN 'click_id'::text THEN 'absolute'::text
            WHEN 'transaction_id'::text THEN 'absolute'::text
            WHEN 'none'::text THEN 'unknown'::text
            ELSE 'confident'::text
        END AS confidence
   FROM ((((postbacks p
     LEFT JOIN leads l ON ((l.id = p.lead_id)))
     LEFT JOIN ib_source_platforms ibp ON ((ibp.ib_source = p.ib_source)))
     CROSS JOIN LATERAL ( SELECT COALESCE(p.gclid, NULLIF(l.gclid, ''::text)) AS gclid,
            COALESCE(p.gbraid, NULLIF(l.gbraid, ''::text)) AS gbraid,
            COALESCE(p.wbraid, NULLIF(l.wbraid, ''::text)) AS wbraid,
            COALESCE(p.msclkid, NULLIF(l.msclkid, ''::text)) AS msclkid,
            COALESCE(p.fbclid, NULLIF(l.fbclid, ''::text)) AS fbclid,
            COALESCE(p.oppref, NULLIF(l.oppref, ''::text)) AS oppref,
            COALESCE(p.utm_source, NULLIF(l.utm_source, ''::text)) AS utm_source) k)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    -- transaction-id match: the lead's own source decides
                    WHEN p.match_method = 'transaction_id' AND l.id IS NOT NULL THEN
                        CASE
                            WHEN (l.utm_source ~* '^(google|youtube|adwords)'::text) THEN 'google|transaction_id'::text
                            WHEN (l.utm_source ~* '(bing|microsoft)'::text) THEN 'bing|transaction_id'::text
                            WHEN (l.utm_source ~* '(meta|facebook|instagram|^fb$)'::text) THEN 'meta|transaction_id'::text
                            WHEN (l.utm_source ~* '(openai|chatgpt)'::text) THEN 'openai|transaction_id'::text
                            WHEN (COALESCE(NULLIF(l.gclid, ''::text), NULLIF(l.gbraid, ''::text), NULLIF(l.wbraid, ''::text)) IS NOT NULL) THEN 'google|transaction_id'::text
                            WHEN (NULLIF(l.msclkid, ''::text) IS NOT NULL) THEN 'bing|transaction_id'::text
                            WHEN (NULLIF(l.fbclid, ''::text) IS NOT NULL) THEN 'meta|transaction_id'::text
                            WHEN (NULLIF(l.oppref, ''::text) IS NOT NULL) THEN 'openai|transaction_id'::text
                        END
                END AS lead_pa) t)
     CROSS JOIN LATERAL ( SELECT COALESCE(t.lead_pa,
                CASE
                    WHEN (COALESCE(k.gclid, k.gbraid, k.wbraid) IS NOT NULL) THEN 'google|click_id'::text
                    WHEN (k.msclkid IS NOT NULL) THEN 'bing|click_id'::text
                    WHEN (k.fbclid IS NOT NULL) THEN 'meta|click_id'::text
                    WHEN (k.oppref IS NOT NULL) THEN 'openai|click_id'::text
                    WHEN (k.utm_source ~* '^(google|youtube|adwords)'::text) THEN 'google|utm_source'::text
                    WHEN (k.utm_source ~* '(bing|microsoft)'::text) THEN 'bing|utm_source'::text
                    WHEN (k.utm_source ~* '(meta|facebook|instagram|^fb$)'::text) THEN 'meta|utm_source'::text
                    WHEN (k.utm_source ~* '(openai|chatgpt)'::text) THEN 'openai|utm_source'::text
                    WHEN (ibp.platform IS NOT NULL) THEN (ibp.platform || '|ib_source'::text)
                    ELSE 'unknown|none'::text
                END) AS pa) a;

revoke all on public.v_postbacks from anon, authenticated;
