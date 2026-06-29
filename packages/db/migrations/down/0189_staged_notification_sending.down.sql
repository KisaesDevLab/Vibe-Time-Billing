-- Down: 0189_staged_notification_sending.sql
-- Any in-flight SENDING rows must be resolved first; park them as FAILED so
-- the narrower constraint can be re-applied.
UPDATE vibetb.staged_notification SET status = 'FAILED' WHERE status = 'SENDING';

ALTER TABLE vibetb.staged_notification
  DROP CONSTRAINT IF EXISTS staged_notification_status_ck;

ALTER TABLE vibetb.staged_notification
  ADD CONSTRAINT staged_notification_status_ck
  CHECK (status IN ('PENDING_APPROVAL', 'SCHEDULED', 'SENT', 'CANCELED', 'FAILED'));
