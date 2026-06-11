-- =====================================================================
-- Migration: 0146_staged_notifications.sql
--
-- Staged client-notification pipeline. Configured engagement statuses
-- can notify the client on entry: IMMEDIATE sends right away, STAGED
-- queues a row for staff approval (send now / schedule / cancel, incl.
-- bulk). One staged_notification row per trigger event; recipients and
-- rendered per-channel content are SNAPSHOTTED at staging time so the
-- approver approves exactly what was previewed. A newer status change
-- supersedes (cancels) any still-unsent row for the same engagement —
-- enforced by a partial unique index on supersede_key.
--
-- Also: portal_notification — the client-portal in-app notification
-- facility (modeled on staff_notification), first used by the PORTAL
-- channel of this pipeline. Channel CHECKs on notification_template and
-- client_communication widen to admit 'PORTAL' (the template constraint
-- also picks up 'CALL', already in the Drizzle enum but missing from
-- the live 0018 constraint).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare IF NOT EXISTS only. Migrate runner wraps each file in one txn.
-- =====================================================================

-- Per-status notification config beside the existing master switch
-- triggers_client_comm (0050).
ALTER TABLE vibetb.engagement_status_config
  ADD COLUMN IF NOT EXISTS notify_mode text NOT NULL DEFAULT 'STAGED',
  ADD COLUMN IF NOT EXISTS notify_channels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notify_recipients text NOT NULL DEFAULT 'BILLING_CONTACT';

ALTER TABLE vibetb.engagement_status_config
  DROP CONSTRAINT IF EXISTS engagement_status_config_notify_mode_ck;
ALTER TABLE vibetb.engagement_status_config
  ADD CONSTRAINT engagement_status_config_notify_mode_ck
  CHECK (notify_mode IN ('IMMEDIATE', 'STAGED'));

ALTER TABLE vibetb.engagement_status_config
  DROP CONSTRAINT IF EXISTS engagement_status_config_notify_recipients_ck;
ALTER TABLE vibetb.engagement_status_config
  ADD CONSTRAINT engagement_status_config_notify_recipients_ck
  CHECK (notify_recipients IN ('BILLING_CONTACT', 'ALL_CONTACTS'));

-- One row per trigger event. IMMEDIATE mode also writes a row (status
-- SCHEDULED, scheduled_at = now) so every send flows through the same
-- worker path and the table doubles as the pipeline ledger.
CREATE TABLE IF NOT EXISTS vibetb.staged_notification (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  -- 'engagement_status' for now; future triggers plug in here.
  trigger_kind      text NOT NULL,
  entity_type       text NOT NULL,
  entity_id         uuid NOT NULL,
  -- { workflowState, fromState, statusLabel } — the fire-time guard
  -- re-checks workflowState generically across trigger kinds.
  trigger_context   jsonb NOT NULL,
  -- 'engagement_status:{engagementId}'; partial-unique below keeps at
  -- most one ACTIVE notification per engagement+trigger.
  supersede_key     text NOT NULL,
  -- 'IMMEDIATE' | 'STAGED'
  mode              text NOT NULL,
  -- 'PENDING_APPROVAL' | 'SCHEDULED' | 'SENT' | 'CANCELED' | 'FAILED'
  status            text NOT NULL,
  -- subset of EMAIL | SMS | PORTAL
  channels          text[] NOT NULL,
  -- 'BILLING_CONTACT' | 'ALL_CONTACTS'
  recipient_mode    text NOT NULL,
  -- snapshot: [{ personId, name, email, phone }]
  recipients        jsonb NOT NULL,
  -- snapshot: { EMAIL: {subject, body}, SMS: {body}, PORTAL: {title, body} }
  rendered          jsonb NOT NULL,
  template_kind     text NOT NULL,
  scheduled_at      timestamptz,
  decided_by        uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  -- 'SUPERSEDED' | 'MANUAL' | 'STATE_CHANGED_AT_FIRE'
  canceled_reason   text,
  sent_at           timestamptz,
  -- { EMAIL: {ok, sentTo[], error?}, ... } written by the worker.
  channel_results   jsonb,
  error_message     text,
  created_by        uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staged_notification_mode_ck
    CHECK (mode IN ('IMMEDIATE', 'STAGED')),
  CONSTRAINT staged_notification_status_ck
    CHECK (status IN ('PENDING_APPROVAL', 'SCHEDULED', 'SENT', 'CANCELED', 'FAILED')),
  CONSTRAINT staged_notification_recipient_mode_ck
    CHECK (recipient_mode IN ('BILLING_CONTACT', 'ALL_CONTACTS')),
  CONSTRAINT staged_notification_canceled_reason_ck
    CHECK (canceled_reason IS NULL OR canceled_reason IN ('SUPERSEDED', 'MANUAL', 'STATE_CHANGED_AT_FIRE'))
);

CREATE INDEX IF NOT EXISTS staged_notification_firm_status_idx
  ON vibetb.staged_notification (firm_id, status);
CREATE INDEX IF NOT EXISTS staged_notification_client_idx
  ON vibetb.staged_notification (client_id);
CREATE INDEX IF NOT EXISTS staged_notification_entity_idx
  ON vibetb.staged_notification (entity_type, entity_id);

-- Supersede invariant: at most one unsent notification per key. The
-- pipeline cancels the old row in the same txn that inserts the new one.
CREATE UNIQUE INDEX IF NOT EXISTS staged_notification_active_supersede_uk
  ON vibetb.staged_notification (supersede_key)
  WHERE status IN ('PENDING_APPROVAL', 'SCHEDULED');

-- Client-portal in-app notifications (PORTAL channel target). One row
-- per portal identity with access to the client at send time.
CREATE TABLE IF NOT EXISTS vibetb.portal_notification (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id           uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  portal_identity_id  uuid NOT NULL REFERENCES vibetb.portal_identity(id) ON DELETE CASCADE,
  type                text NOT NULL,
  entity_type         text,
  entity_id           uuid,
  title               text NOT NULL,
  body                text,
  action_url          text,
  -- 'UNREAD' | 'READ'
  status              text NOT NULL DEFAULT 'UNREAD',
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  read_at             timestamptz,
  CONSTRAINT portal_notification_status_ck
    CHECK (status IN ('UNREAD', 'READ'))
);

CREATE INDEX IF NOT EXISTS portal_notification_identity_client_status_idx
  ON vibetb.portal_notification (portal_identity_id, client_id, status);
CREATE INDEX IF NOT EXISTS portal_notification_created_idx
  ON vibetb.portal_notification (created_at);

-- Widen channel CHECKs: PORTAL joins the template + communication-log
-- vocabularies (CALL was already in the Drizzle template enum but the
-- live 0018 constraint predated it).
ALTER TABLE vibetb.notification_template
  DROP CONSTRAINT IF EXISTS notification_template_channel_check;
ALTER TABLE vibetb.notification_template
  ADD CONSTRAINT notification_template_channel_check
  CHECK (channel IN ('EMAIL', 'SMS', 'CALL', 'PORTAL'));

ALTER TABLE vibetb.client_communication
  DROP CONSTRAINT IF EXISTS client_communication_channel_check;
ALTER TABLE vibetb.client_communication
  ADD CONSTRAINT client_communication_channel_check
  CHECK (channel IN ('EMAIL', 'SMS', 'CALL', 'MEETING', 'NOTE', 'PORTAL'));
