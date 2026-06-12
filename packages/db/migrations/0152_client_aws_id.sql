-- =====================================================================
-- Migration: 0152_client_aws_id.sql
--
-- Second client identifier for the Vibe Filer document mapper. Some
-- export pipelines stamp filenames with a different id than the
-- practice-management external_id ("AWS Id"); the filer matcher now
-- accepts either. Same shape as external_id: free text, unique per
-- firm when set.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.client
  ADD COLUMN IF NOT EXISTS aws_id text;

CREATE UNIQUE INDEX IF NOT EXISTS client_firm_aws_id_uk
  ON vibetb.client (firm_id, aws_id)
  WHERE aws_id IS NOT NULL;
