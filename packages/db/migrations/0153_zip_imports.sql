-- =====================================================================
-- Migration: 0153_zip_imports.sql
--
-- Vibe Filer zip import: upload a client document export (.zip),
-- match the client from the zip name (External/AWS Id), pick a
-- destination folder, and extract in the worker — preserving the
-- zip's internal structure, never overwriting (same-name files are
-- skipped and reported), files land internal-only (private).
-- One row per import; per-entry outcomes in `results` JSONB.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.zip_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  zip_name text NOT NULL,
  zip_key text NOT NULL,
  zip_size_bytes bigint NOT NULL DEFAULT 0,
  matched_client uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  dest_folder text,
  -- draft -> queued -> running -> done | error
  status text NOT NULL DEFAULT 'draft',
  total_entries integer,
  imported_count integer,
  skipped_count integer,
  error_count integer,
  results jsonb,
  error text,
  created_by uuid REFERENCES vibetb.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zip_imports_firm_created_idx
  ON vibetb.zip_imports (firm_id, created_at DESC);
