-- =====================================================================
-- Migration: 0076_fmv2_folder_link_attempts.sql  (FMv2 §2)
--
-- File Manager v2 per-client linking + conflict resolution schema.
--
-- Two changes:
--   1. New table `folder_link_attempts` (§2.1) — durable record of
--      every link attempt. Contested entries become the work queue
--      for admins with `storage.folder.reconcile`.
--   2. Expand the `folder_sync_events.event_type` CHECK to include
--      `link_attempted`, `link_contested`, `link_reassigned` (§2.2).
-- =====================================================================

-- --- (1) folder_link_attempts ----------------------------------------

CREATE TABLE IF NOT EXISTS folder_link_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id           uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  storage_path        text NOT NULL,
  attempted_by        uuid NOT NULL REFERENCES app_user(id),
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  match_confidence    numeric(4, 3),
  match_reason_code   text,
  outcome             text NOT NULL DEFAULT 'pending',
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES app_user(id),
  resolution_reason   text,
  notes               text,
  CONSTRAINT folder_link_attempts_outcome_chk CHECK (
    outcome IN ('pending', 'linked', 'contested', 'denied', 'reassigned', 'aborted')
  ),
  CONSTRAINT folder_link_attempts_confidence_range CHECK (
    match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)
  )
);

-- Hot index for the admin "open conflicts" surface.
CREATE INDEX IF NOT EXISTS idx_folder_link_attempts_open
  ON folder_link_attempts (firm_id, outcome)
  WHERE outcome IN ('pending', 'contested');

-- Per-client history for the client detail audit panel.
CREATE INDEX IF NOT EXISTS idx_folder_link_attempts_client
  ON folder_link_attempts (client_id, attempted_at DESC);

-- --- (2) Extend folder_sync_events event_type vocabulary -------------
--
-- The CHECK constraint in 0045 enumerates 8 event types. Drop + re-add
-- with the three new values appended. This is safe because nothing
-- in the existing data violates the new (super)set.

ALTER TABLE folder_sync_events
  DROP CONSTRAINT IF EXISTS folder_sync_events_event_chk;

ALTER TABLE folder_sync_events
  ADD CONSTRAINT folder_sync_events_event_chk CHECK (
    event_type IN (
      'discovered', 'renamed', 'missing', 'sentinel_changed',
      'sentinel_lost', 'conflict', 'orphan', 'restored',
      'link_attempted', 'link_contested', 'link_reassigned'
    )
  );

-- Index supporting the conflict detail view: pull all link-related
-- events for a path. Uses path_after which is the canonical bound
-- path for link_* events.
CREATE INDEX IF NOT EXISTS idx_folder_sync_events_path_after
  ON folder_sync_events (path_after, detected_at DESC)
  WHERE path_after IS NOT NULL;
