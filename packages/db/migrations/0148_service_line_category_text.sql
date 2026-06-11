-- =====================================================================
-- Migration: 0148_service_line_category_text.sql
--
-- Service-line categories become firm-managed. The category column was
-- locked to the service_line_category enum (tax/audit/advisory/
-- bookkeeping/payroll); firms classify work their own way, so it
-- relaxes to free text managed on the Taxonomy screen — same move 0101
-- made for engagement workflow states. Existing values carry over
-- verbatim; reports that group by category keep working (grouping by
-- string instead of enum). The enum TYPE itself stays in the schema
-- because other tables may still reference it.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.service_line
  ALTER COLUMN category TYPE text USING category::text;

-- Guard against empty categories now that the enum no longer enforces
-- membership.
ALTER TABLE vibetb.service_line
  DROP CONSTRAINT IF EXISTS service_line_category_nonempty_ck;
ALTER TABLE vibetb.service_line
  ADD CONSTRAINT service_line_category_nonempty_ck
  CHECK (length(trim(category)) > 0);
