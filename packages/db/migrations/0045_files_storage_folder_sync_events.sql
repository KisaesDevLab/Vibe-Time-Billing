-- =====================================================================
-- Migration: 0045_files_storage_folder_sync_events.sql
--
-- Phase 2 of the file-manager rebuild — per FILE_MANAGER_ADDENDUM.md
-- §3.3. Append-only audit log of every sync-state transition the
-- worker observes. Admins drain the unresolved rows from the
-- Storage Conflicts panel (Phase 4/9).
--
-- resolved_by points at app_user (the app's user table). The
-- addendum used `users(id)` as placeholder — mapped here to
-- app_user(id) per the project's table naming.
--
-- event_type vocabulary (from §3.3 + §4 Phase 3 state machine):
--   discovered        new folder w/ sentinel, no existing row
--   renamed           sentinel matches existing row at a new path
--   missing           existing folder no longer in storage
--   sentinel_changed  sentinel parsed but doesn't match a known client
--   sentinel_lost     existing folder, sentinel file is gone
--   conflict          two folders share a sentinel client_id
--   orphan            sentinel client_id isn't in this firm
--   restored          archived folder reappeared with same client_id
-- =====================================================================

CREATE TABLE IF NOT EXISTS folder_sync_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firm(id),
  client_folder_id  UUID REFERENCES client_folders(id),
  event_type        TEXT NOT NULL,
  path_before       TEXT,
  path_after        TEXT,
  sentinel_payload  JSONB,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID REFERENCES app_user(id),
  resolution        TEXT,
  notes             TEXT,
  CONSTRAINT folder_sync_events_event_chk CHECK (
    event_type IN (
      'discovered', 'renamed', 'missing', 'sentinel_changed',
      'sentinel_lost', 'conflict', 'orphan', 'restored'
    )
  )
);

-- Hot index for the admin "open events" view + the worker's
-- idempotency check (skip if an identical event was already logged
-- and is still open).
CREATE INDEX IF NOT EXISTS idx_folder_sync_events_open
  ON folder_sync_events (firm_id, detected_at)
  WHERE resolved_at IS NULL;
