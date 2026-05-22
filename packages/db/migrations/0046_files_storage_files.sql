-- =====================================================================
-- Migration: 0046_files_storage_files.sql
--
-- Phase 5 of the file-manager rebuild — per FILE_MANAGER_ADDENDUM.md
-- §3.4. Flat row-per-file table. Subfolder structure is stored as a
-- string column (subfolder_path) rather than a hierarchical
-- self-referential tree — this matches how the virtual-drive layer
-- (rclone / Mountain Duck) describes paths, and avoids a separate
-- folders table that would drift from storage.
--
-- One row per (firm_id, storage_key). Soft-delete via deleted_at so
-- the sync worker can resurrect a row when a file reappears after a
-- spurious miss; hard-delete only happens via the retention worker.
--
-- pending_upload is the Phase-8 reservation flag: when the API issues
-- a presigned PUT URL, it INSERTs the row with pending_upload=true so
-- a concurrent sync tick doesn't soft-delete it before the client
-- actually writes the object. The janitor (Phase 8) sweeps stale
-- pending rows after 30 minutes.
--
-- Table names use the singular convention this project follows
-- (`firm`, `client`, `client_folders`, `app_user`).
-- =====================================================================

CREATE TABLE IF NOT EXISTS files (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id         UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  client_folder_id  UUID NOT NULL REFERENCES client_folders(id) ON DELETE CASCADE,
  subfolder_path    TEXT NOT NULL DEFAULT '',
  original_filename TEXT NOT NULL,
  storage_key       TEXT NOT NULL,
  mime_type         TEXT,
  size_bytes        BIGINT NOT NULL,
  sha256            TEXT,
  etag              TEXT,
  -- Soft enum for category. Free-text so firms can add new buckets
  -- without a schema migration; UI surfaces a known list.
  category          TEXT,
  -- 'app' | 'explorer' | 'generated'
  source            TEXT NOT NULL DEFAULT 'explorer',
  visibility        TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'client_visible')),
  uploaded_by       UUID REFERENCES app_user(id),
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  -- Phase 8 reservation flag — see header.
  pending_upload    BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT files_firm_storage_key_uk UNIQUE (firm_id, storage_key)
);

-- Hot index for the portal endpoint and staff filter-by-visibility.
CREATE INDEX IF NOT EXISTS idx_files_client_visibility
  ON files (client_id, visibility)
  WHERE deleted_at IS NULL;

-- Hot index for the Files tab tree view.
CREATE INDEX IF NOT EXISTS idx_files_folder_subfolder
  ON files (client_folder_id, subfolder_path)
  WHERE deleted_at IS NULL;

-- Used by the SHA-256 hashing worker.
CREATE INDEX IF NOT EXISTS idx_files_sha256_pending
  ON files (firm_id, size_bytes)
  WHERE sha256 IS NULL AND deleted_at IS NULL AND pending_upload = false;

-- Used by the Phase 8 janitor sweep over stale reservations.
CREATE INDEX IF NOT EXISTS idx_files_pending_upload
  ON files (uploaded_at)
  WHERE pending_upload = true;
