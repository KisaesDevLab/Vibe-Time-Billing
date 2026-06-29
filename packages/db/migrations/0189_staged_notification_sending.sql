-- =====================================================================
-- Migration: 0189_staged_notification_sending.sql
--
-- Adds a transient 'SENDING' status to staged_notification so the worker
-- can ATOMICALLY claim a row (SCHEDULED -> SENDING) before fanning out to
-- recipients. Without the claim, a BullMQ stalled-job reprocess (worker
-- killed mid-fan-out, row still SCHEDULED) re-runs the handler and
-- re-sends to every recipient — duplicate client emails/SMS. The claim
-- makes the second execution lose the conditional UPDATE and skip.
-- =====================================================================

ALTER TABLE vibetb.staged_notification
  DROP CONSTRAINT IF EXISTS staged_notification_status_ck;

ALTER TABLE vibetb.staged_notification
  ADD CONSTRAINT staged_notification_status_ck
  CHECK (status IN ('PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELED', 'FAILED'));
