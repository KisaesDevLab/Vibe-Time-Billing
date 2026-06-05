-- =====================================================================
-- Migration: 0117_staff_notification.sql  (BK-7, used from BK-4/BK-5)
--
-- In-app staff notification center. A per-recipient actionable feed —
-- distinct from notification_log (outbound email/SMS audit) and from
-- approval_request (approval decisions). Appointment booking writes:
--   reschedule_requested | appointment_cancelled_by_client |
--   provider_write_failed
-- with an action_url deep-linking the relevant appointment.
--
-- NOTE: bare IF NOT EXISTS only (pglite harness strips DO $$ blocks).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.staff_notification (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  recipient_app_user_id  uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  type                   text NOT NULL,
  entity_type            text NOT NULL,
  entity_id              uuid,
  title                  text NOT NULL,
  body                   text,
  action_url             text,
  status                 text NOT NULL DEFAULT 'UNREAD',
  metadata               jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  read_at                timestamptz,
  CONSTRAINT staff_notification_status_ck
    CHECK (status IN ('UNREAD','READ','DISMISSED','ACTIONED'))
);

CREATE INDEX IF NOT EXISTS staff_notification_recipient_status_idx
  ON vibetb.staff_notification (recipient_app_user_id, status);
CREATE INDEX IF NOT EXISTS staff_notification_entity_idx
  ON vibetb.staff_notification (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS staff_notification_created_idx
  ON vibetb.staff_notification (created_at);
