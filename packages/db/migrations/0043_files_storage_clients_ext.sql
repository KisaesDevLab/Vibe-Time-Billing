-- =====================================================================
-- Migration: 0043_files_storage_clients_ext.sql
--
-- Phase 2 of the file-manager rebuild — clients table extension per
-- FILE_MANAGER_ADDENDUM.md §3.1.
--
-- tax_software_id     — opaque identifier the firm uses in their tax
--                       software (UltraTax / Lacerte / GoSystem /
--                       Axcess) to refer to this client. Sometimes
--                       encoded inside the existing folder name on
--                       B2 (e.g. "0042 - Smith, John"); the
--                       onboarding tool in Phase 4 parses it out for
--                       fuzzy-match scoring.
-- tax_software_kind   — which software the id belongs to. Free-text
--                       for now (no CHECK constraint) so firms can
--                       add new entries without a migration.
--
-- The partial index speeds the onboarding-scan query that filters
-- by (firm_id, tax_software_id) when matching folders to clients.
-- =====================================================================

ALTER TABLE client
  ADD COLUMN IF NOT EXISTS tax_software_id TEXT,
  ADD COLUMN IF NOT EXISTS tax_software_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_client_tax_software_id
  ON client (firm_id, tax_software_id)
  WHERE tax_software_id IS NOT NULL;
