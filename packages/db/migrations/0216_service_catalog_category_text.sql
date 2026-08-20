-- =====================================================================
-- Migration: 0216_service_catalog_category_text.sql
--
-- Service (and terms-template) categories become firm-managed. Both
-- columns were locked to the service_category enum (TAX/BOOKKEEPING/
-- AUDIT/ADVISORY/PAYROLL/CFO), so Admin → Services could not offer the
-- categories the firm defines on its Taxonomy service lines. Relax to
-- free text — the same move 0148 made for service_line.category (and
-- 0101 for workflow states). Existing values carry over verbatim;
-- grouping/filtering keeps working (by string instead of enum). The
-- enum TYPE itself stays in the schema.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.services_catalog
  ALTER COLUMN category TYPE text USING category::text;

ALTER TABLE vibetb.services_catalog
  DROP CONSTRAINT IF EXISTS services_catalog_category_nonempty_ck;
ALTER TABLE vibetb.services_catalog
  ADD CONSTRAINT services_catalog_category_nonempty_ck
  CHECK (length(trim(category)) > 0);

ALTER TABLE vibetb.terms_templates
  ALTER COLUMN category TYPE text USING category::text;

ALTER TABLE vibetb.terms_templates
  DROP CONSTRAINT IF EXISTS terms_templates_category_nonempty_ck;
ALTER TABLE vibetb.terms_templates
  ADD CONSTRAINT terms_templates_category_nonempty_ck
  CHECK (length(trim(category)) > 0);
