-- =====================================================================
-- Migration: 0079_notification_log.sql
--
-- Connect addendum H.8 — audit log for every notification dispatch.
-- One row per send attempt (success or failure) so firms can answer
-- "did the dunning email actually go out?" without grepping pino logs.
--
-- Distinct from audit_log: audit_log captures state-changing actions
-- by actors; notification_log captures outbound side effects.
-- Append-only at the app layer; no DB role enforcement (the table is
-- not security-sensitive — it doesn't authorize anything).
--
-- firm_id is nullable because magic-link sends happen before a session
-- exists (no firm context yet). When we know the firm, we set it so
-- per-firm filters work.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.notification_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id              uuid REFERENCES vibetb.firm(id) ON DELETE SET NULL,
  channel              text NOT NULL,
  -- Provider id ('console' | 'smtp' | 'postmark' | 'resend' | 'emailit'
  -- | 'ses' | 'textlink' | 'twilio'). Free-text so adding a new
  -- provider doesn't need a migration.
  provider             text NOT NULL,
  -- Template key the call site supplied (e.g. 'magic-link',
  -- 'invoice-sent', 'retainer-activated'). Free-text — the H.2 set is
  -- the published catalog but the column tolerates new templates.
  template_key         text,
  recipient            text NOT NULL,
  subject              text,
  status               text NOT NULL,
  provider_message_id  text,
  error_message        text,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_log_channel_ck
    CHECK (channel IN ('email', 'sms')),
  CONSTRAINT notification_log_status_ck
    CHECK (status IN ('sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS notification_log_firm_idx
  ON vibetb.notification_log (firm_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS notification_log_status_idx
  ON vibetb.notification_log (status, occurred_at DESC)
  WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS notification_log_recipient_idx
  ON vibetb.notification_log (recipient, occurred_at DESC);
