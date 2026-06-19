-- =====================================================================
-- Migration: 0174_webhook_keys_encrypted.sql
--
-- Firm-configurable inbound webhook signing secrets for the notification
-- providers (Postmark / Resend / Twilio / TextLink). Stored as an
-- encrypted JSON map under KMS_KEY; each receiver prefers the DB secret
-- and falls back to its env var.
-- =====================================================================

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS webhook_keys_encrypted text;
