-- =====================================================================
-- Migration: 0044_files_storage_client_folders.sql
--
-- Phase 2 of the file-manager rebuild — per FILE_MANAGER_ADDENDUM.md
-- §3.2. One row per client; the storage_path column carries the
-- top-level folder name (always trailing slash, mutable display
-- string). Identity is anchored in the _Vibe/client.json sentinel
-- inside the folder, not the path — so renames in File Explorer
-- propagate via the sync worker (Phase 3) without breaking the
-- binding.
--
-- The status column tracks sync state. Transitions:
--   active     — sentinel present, path matches the row
--   renaming   — Phase 9 mutation job in flight; reads see the row
--                  but writes are queued
--   missing    — folder no longer exists in storage; client may be
--                  archived / restored
--   conflict   — two folders share the same sentinel client_id
--   orphan     — sentinel points at a client not in this firm
-- =====================================================================

CREATE TABLE IF NOT EXISTS client_folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  storage_path    TEXT NOT NULL,
  sentinel_etag   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Storage path is unique within a firm — two clients can't claim
  -- the same folder. Sync worker uses this to detect duplicates.
  CONSTRAINT client_folders_firm_path_uk UNIQUE (firm_id, storage_path),
  -- One folder per client. Phase 4 onboarding rebinds by archiving
  -- the existing row (DELETE) before inserting a new one.
  CONSTRAINT client_folders_client_uk UNIQUE (client_id),
  -- Domain invariant on status values. Soft enum — TEXT + CHECK
  -- chosen over native ENUM so adding a new state doesn't require
  -- a fresh migration.
  CONSTRAINT client_folders_status_chk CHECK (
    status IN ('active', 'renaming', 'missing', 'conflict', 'orphan')
  )
);

-- Partial index over non-active rows. Sync worker scans this to
-- surface what needs admin attention.
CREATE INDEX IF NOT EXISTS idx_client_folders_status
  ON client_folders (firm_id, status)
  WHERE status <> 'active';
