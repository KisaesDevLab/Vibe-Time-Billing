-- =====================================================================
-- Migration: 0024_time_entry_approval.sql
--
-- Per-entry approval (Phase 9 #22). When an engagement requires
-- per-entry sign-off (e.g. partner-reviewed audit work), the
-- approving user lands in approver_id with approved_at. Approval
-- happens via a new endpoint POST /time-entries/:id/approve.
-- =====================================================================

ALTER TABLE time_entry
  ADD COLUMN IF NOT EXISTS approver_id UUID REFERENCES app_user(id) ON DELETE SET NULL;

ALTER TABLE time_entry
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS time_entry_unapproved_idx
  ON time_entry (engagement_id, status)
  WHERE approver_id IS NULL;
