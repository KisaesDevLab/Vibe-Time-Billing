-- =====================================================================
-- Migration: 0112_calendar_time_suggestions.sql  (Calendar, CAL-8)
--
-- When a confirmed appointment's end time passes, prompt the staff member
-- to log time. One suggestion per event, tracked through pending → logged
-- / dismissed / snoozed.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.staff_time_suggestion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES vibetb.calendar_events(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  suggested_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL DEFAULT 'pending'
    CHECK (action IN ('pending','logged','dismissed','snoozed')),
  time_entry_id uuid,
  snoozed_until timestamptz,
  snooze_count integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_time_suggestion_log_event_uk
  ON vibetb.staff_time_suggestion_log (event_id);
CREATE INDEX IF NOT EXISTS staff_time_suggestion_log_staff_action_idx
  ON vibetb.staff_time_suggestion_log (staff_id, action);
