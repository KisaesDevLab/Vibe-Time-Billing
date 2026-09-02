-- =====================================================================
-- Migration: 0233_sms_inbox_settings.sql
--
-- Two-way SMS inbox (Twilio) — phase 1: firm-level inbox settings and
-- the firm's texting lines. Twilio credentials stay in the existing
-- firm_settings.sms_config_encrypted envelope (extended with the
-- Messaging Service SID + optional API key); everything non-secret the
-- inbox needs lives on firm_settings as discrete columns, and each
-- number in the Messaging Service gets an sms_line row (ingest toggle,
-- default assignee, poll cursor).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS sms_inbox_enabled boolean NOT NULL DEFAULT false,
  -- Override for the origin Twilio signs webhooks against; NULL falls back
  -- to PUBLIC_BASE_URL then APP_BASE_URL.
  ADD COLUMN IF NOT EXISTS sms_public_base_url text,
  ADD COLUMN IF NOT EXISTS sms_poll_interval_minutes integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS sms_unassigned_retention_days integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS sms_spam_retention_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS sms_default_work_code_id uuid
    REFERENCES vibetb.work_code(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sms_pii_warnings_enabled boolean NOT NULL DEFAULT true,
  -- Kill switch for the D8a consent gate on outbound-initiated sends.
  ADD COLUMN IF NOT EXISTS sms_consent_enforced boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_a2p_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS sms_a2p_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_a2p_override_allow boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_last_inbound_webhook_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_last_status_webhook_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_last_poll_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_last_send_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_health jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE vibetb.firm_settings DROP CONSTRAINT IF EXISTS firm_settings_sms_a2p_status_ck;
ALTER TABLE vibetb.firm_settings ADD CONSTRAINT firm_settings_sms_a2p_status_ck
  CHECK (sms_a2p_status IN ('unknown', 'unregistered', 'pending', 'registered', 'not_applicable'));

CREATE TABLE IF NOT EXISTS vibetb.sms_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  phone_number_e164 text NOT NULL,
  twilio_sid text,                                   -- PN... (IncomingPhoneNumber)
  label text,
  default_assignee_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  ingest boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  poll_cursor_at timestamptz,
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_line_firm_number_uk UNIQUE (firm_id, phone_number_e164)
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_line_default_uk
  ON vibetb.sms_line (firm_id) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS sms_line_firm_idx
  ON vibetb.sms_line (firm_id, status);
