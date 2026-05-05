-- Rename leads.jornaya_leadid -> leads.trusted_form_cert_url.
--
-- The column was introduced when the project intended to integrate Jornaya
-- LeadiD for TCPA proof. Jornaya never actually went live -- the column has
-- only ever held an empty string or the literal "STATIC_JORNAYA_ID_PLACEHOLDER"
-- fallback. Going forward the column carries TrustedForm certificate URLs
-- (https://cert.trustedform.com/<hash>), which is the actual TCPA evidence
-- the funnel now produces.
--
-- Outbound CRM field names (CallTools `jornaya_lead_id`, Caliber
-- `consent.jornaya_leadid`) are intentionally NOT renamed -- those are
-- contractual on the CRM side. Only the internal column name changes.

alter table public.leads
  rename column jornaya_leadid to trusted_form_cert_url;

comment on column public.leads.trusted_form_cert_url is
  'TrustedForm certificate URL captured at form submission. Falls back to '
  'literal "STATIC_JORNAYA_ID_PLACEHOLDER" string when TF script failed to '
  'populate the hidden xxTrustedFormCertUrl field. Forwarded to CallTools '
  '(field: jornaya_lead_id) and Caliber (field: consent.jornaya_leadid) -- '
  'those external field names are kept for backwards compatibility with the '
  'CRMs'' configured ingestion mappings.';
