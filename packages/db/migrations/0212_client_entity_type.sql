-- =====================================================================
-- Migration: 0212_client_entity_type.sql
--
-- Business entity classification on clients. The business-side counterpart
-- to filing_status (which only applies to INDIVIDUAL clients): which
-- legal/tax entity a BUSINESS client is, keyed to the IRS return it files.
-- NULL = individual client or not yet classified.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TYPE vibetb.client_entity_type AS ENUM (
  'SOLE_PROPRIETOR',
  'JOINT_VENTURE',
  'PARTNERSHIP_1065',
  'S_CORP_1120S',
  'C_CORP_1120',
  'EXEMPT_ORG_990',
  'TRUST_1041',
  'ESTATE_706',
  'GIFT_709',
  'OTHER'
);

ALTER TABLE vibetb.client
  ADD COLUMN IF NOT EXISTS entity_type vibetb.client_entity_type;
