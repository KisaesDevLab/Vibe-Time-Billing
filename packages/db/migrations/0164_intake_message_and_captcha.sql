-- =====================================================================
-- Migration: 0164_intake_message_and_captcha.sql
--
-- Public document-intake form improvements:
--   1. has_message — lets a message-only submission (no file) complete; a
--      plaintext flag so "complete" needn't decrypt message_enc.
--   2. Cloudflare Turnstile CAPTCHA, configured in the admin UI: the public
--      site key + the KMS-encrypted secret envelope on firm_settings.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.intake_sessions
  ADD COLUMN IF NOT EXISTS has_message boolean NOT NULL DEFAULT false;

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS turnstile_site_key text,
  ADD COLUMN IF NOT EXISTS turnstile_secret_enc text;
