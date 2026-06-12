-- =====================================================================
-- Migration: 0154_file_share_bundle.sql
--
-- Combined multi-file shares: one gated link whose landing page lists
-- several files. A bundle share is a file_share row with file_id NULL
-- and one file_share_item row per included file. Single-file shares are
-- unchanged (file_id set, no items). The OTP/grant gate stays per-share
-- (one access code for the whole bundle).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

-- Bundle shares carry their files in file_share_item, not file_id.
ALTER TABLE vibetb.file_share
  ALTER COLUMN file_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS vibetb.file_share_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_share_id uuid NOT NULL REFERENCES vibetb.file_share(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES vibetb.files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS file_share_item_share_idx
  ON vibetb.file_share_item (file_share_id);

CREATE UNIQUE INDEX IF NOT EXISTS file_share_item_uk
  ON vibetb.file_share_item (file_share_id, file_id);
