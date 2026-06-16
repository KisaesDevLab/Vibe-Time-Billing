-- =====================================================================
-- Migration: 0163_route_sheet_blank.sql
--
-- Allow a "blank" route sheet — printable when a client has no engagement
-- selected or available. Such a print stores a single item row carrying a
-- client-only snapshot and no engagement, so engagement_id must be nullable.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.route_sheet_print_item
  ALTER COLUMN engagement_id DROP NOT NULL;
