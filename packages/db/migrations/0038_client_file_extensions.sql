-- =====================================================================
-- Migration: 0038_client_file_extensions.sql
--
-- v2 Part 1 — client_file extensions for the Canopy-class file manager:
--   visible_in_portal — toggleable per-row column; portal binding lands
--     in a later workstream, the flag is written here.
--   is_inbox          — file landed via upload without a folder pick;
--     drag-into-folder clears the flag.
--   is_internal       — firm-scoped file with no client. Surfaces in
--     the /files Internal files tab. Mutually exclusive with client_id.
--   external_url      — "Upload link" entries point to an external URL
--     (Dropbox, Google Drive, etc.) instead of holding a blob locally.
--
-- Plus: relax NOT NULL on client_id (internal files have none) and on
-- storage_path (link entries have none). Add CHECKs to keep the schema
-- honest: every row has either a client OR is_internal=true, and every
-- row has either a storage_path OR an external_url.
-- =====================================================================

ALTER TABLE client_file
  ADD COLUMN IF NOT EXISTS visible_in_portal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_inbox BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_url TEXT;

ALTER TABLE client_file ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE client_file ALTER COLUMN storage_path DROP NOT NULL;

ALTER TABLE client_file
  ADD CONSTRAINT client_file_scope_chk
    CHECK (client_id IS NOT NULL OR is_internal = true);

ALTER TABLE client_file
  ADD CONSTRAINT client_file_content_chk
    CHECK (storage_path IS NOT NULL OR external_url IS NOT NULL);

CREATE INDEX IF NOT EXISTS client_file_internal_idx
  ON client_file (firm_id)
  WHERE is_internal = true;

CREATE INDEX IF NOT EXISTS client_file_inbox_idx
  ON client_file (client_id)
  WHERE is_inbox = true AND client_id IS NOT NULL;
