-- =====================================================================
-- Migration: 0149_filer_file_flag_tax.sql
--
-- Vibe Filer: combined review action. 'flag_tax' already files the
-- document but forces the tax-returns subfolder; 'file_flag_tax' files
-- to the normal routed destination (override/rule path) AND creates
-- the tax-return flag. Routing log keeps using 'tax_flagged' for both
-- (the folder_path column records where it actually went).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.inbox_items
  DROP CONSTRAINT IF EXISTS inbox_items_review_action_ck;
ALTER TABLE vibetb.inbox_items
  ADD CONSTRAINT inbox_items_review_action_ck
  CHECK (review_action IS NULL OR review_action IN ('file', 'flag_tax', 'skip', 'file_flag_tax'));
