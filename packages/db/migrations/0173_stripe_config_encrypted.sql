-- =====================================================================
-- Migration: 0173_stripe_config_encrypted.sql
--
-- Firm-owned Stripe API keys (Q7) entered in Admin → Stripe, encrypted
-- at rest under KMS_KEY (same envelope as mail_config / sms_config).
-- Stores { secretKey, publishableKey, webhookSecret }.
-- =====================================================================

ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS stripe_config_encrypted text;
