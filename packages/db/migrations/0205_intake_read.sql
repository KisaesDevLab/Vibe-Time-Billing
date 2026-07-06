-- 0205 — intake read/unread. A received submission can be marked read
-- without disposing it; the nav badge counts unread received sessions.
-- Orthogonal to the status lifecycle (received/disposed/rejected), so no
-- status-check change is needed.
ALTER TABLE vibetb.intake_sessions
  ADD COLUMN IF NOT EXISTS read_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL;
