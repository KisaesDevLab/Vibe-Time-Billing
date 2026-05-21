-- =====================================================================
-- Migration: 0035_messaging_config.sql
--
-- v2 Sprint A — DB-backed email + SMS provider config (workstream 3.1).
-- Replaces env-var-only configuration with per-firm provider settings.
-- Env vars become fallback defaults: if the firm has not configured a
-- provider via the UI, the dispatcher resolves from env.
--
-- The config blob is encrypted at rest using AES-256-GCM (Sprint A locked
-- decision #1 — app-level AES via KMS_KEY, matching the TOTP secret
-- pattern). The on-disk column holds the v1:<iv>:<ct>:<tag> envelope as
-- TEXT; the DB never sees plaintext.
--
-- Two separate columns so email and SMS can be rotated independently;
-- a single JSONB would force re-encrypting the other every time.
-- =====================================================================

ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS mail_config_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS sms_config_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS mail_config_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_config_updated_at TIMESTAMPTZ;
