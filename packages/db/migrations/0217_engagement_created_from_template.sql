-- =====================================================================
-- Migration: 0217_engagement_created_from_template.sql
--
-- Provenance link: which engagement_template an engagement was created
-- from. The create endpoint received templateId but discarded it after
-- resolving defaults, so "does this client already have an engagement
-- from this template?" (the bulk-create duplicate skip) had nothing to
-- query. NULL for hand-built engagements and for everything created
-- before this migration (the bulk skip falls back to matching the
-- template's engagement type for those).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.engagement
  ADD COLUMN created_from_template_id uuid
  REFERENCES vibetb.engagement_template(id) ON DELETE SET NULL;

CREATE INDEX engagement_created_from_template_idx
  ON vibetb.engagement (client_id, created_from_template_id);
