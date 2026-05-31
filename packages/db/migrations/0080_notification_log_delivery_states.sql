-- =====================================================================
-- Migration: 0080_notification_log_delivery_states.sql
--
-- H.8 follow-up — provider delivery webhooks update notification_log
-- rows with their post-send delivery outcome. The status column gains
-- four more allowed values:
--
--   'sent'        — provider accepted the message (set at dispatch)
--   'delivered'   — provider confirmed the recipient received it
--   'bounced'     — provider returned a bounce
--   'complained'  — recipient marked as spam
--   'opened'      — recipient opened the email (Postmark only)
--   'failed'      — provider rejected at dispatch (set at dispatch)
--
-- Also add a delivered_at / failed_at timestamp for time-series
-- analytics (response_time graph etc).
-- =====================================================================

ALTER TABLE vibetb.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_status_ck;

ALTER TABLE vibetb.notification_log
  ADD CONSTRAINT notification_log_status_ck
  CHECK (status IN ('sent', 'failed', 'delivered', 'bounced', 'complained', 'opened'));

ALTER TABLE vibetb.notification_log
  ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz;

-- Lookup index for webhook receivers — most callbacks pass back the
-- provider's message id and we need an O(1) lookup to mark the row.
CREATE INDEX IF NOT EXISTS notification_log_provider_message_idx
  ON vibetb.notification_log (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
