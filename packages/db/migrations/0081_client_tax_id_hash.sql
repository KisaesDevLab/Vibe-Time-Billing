-- =====================================================================
-- Migration: 0081_client_tax_id_hash.sql
--
-- Connect addendum I.4 — re-enable ssn-last-4 + ein knowledge-factor
-- portal step-up challenges. Stores a server-peppered HMAC of either
-- the SSN's last four digits OR the full nine-digit EIN.
--
-- Two columns:
--   tax_id_kind  'ssn_last4' | 'ein' — drives challenge type at verify
--   tax_id_hash  HMAC-SHA-256 base64url; never reversible
--
-- The two columns are paired: both set or both null. The pepper is in
-- env (TAX_ID_HASH_PEPPER); rotating it invalidates every stored hash
-- so firms must re-enroll. Audit_log records enroll/change events.
-- =====================================================================

ALTER TABLE vibetb.client
  ADD COLUMN IF NOT EXISTS tax_id_kind text,
  ADD COLUMN IF NOT EXISTS tax_id_hash text;

ALTER TABLE vibetb.client
  ADD CONSTRAINT client_tax_id_kind_ck
  CHECK (tax_id_kind IS NULL OR tax_id_kind IN ('ssn_last4', 'ein'));

ALTER TABLE vibetb.client
  ADD CONSTRAINT client_tax_id_paired_ck
  CHECK ((tax_id_kind IS NULL) = (tax_id_hash IS NULL));
