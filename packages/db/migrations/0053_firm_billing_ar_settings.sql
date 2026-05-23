-- =====================================================================
-- Migration: 0053_firm_billing_ar_settings.sql
--
-- Wires firm-level Billing + A/R settings into firm_settings.
-- Mirrors the legacy "Firm — Billing and A/R" tab:
--   • Contact channels: fax + web (phone/email already exist).
--   • A/R Terms text — printed at the bottom of every invoice PDF.
--   • Statement defaults: format key + standing email message body.
--   • Payment processing toggles: ACH, credit card.
--   • Service charges: enabled flag + rate in basis points.
--   • Five dunning-message slots keyed by "periods old" (1..5+).
--   • Default statement format key (label only — no separate template
--     library yet; the field stores the firm's preferred preset).
-- =====================================================================

ALTER TABLE firm_settings
  ADD COLUMN brand_support_fax text,
  ADD COLUMN brand_support_web text,
  ADD COLUMN ar_terms_text text,
  ADD COLUMN statement_email_message text,
  ADD COLUMN default_statement_format text NOT NULL DEFAULT 'detailed_open_amounts',
  ADD COLUMN ach_processing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN credit_card_processing_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN assess_service_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN service_charge_rate_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN dunning_message_1 text,
  ADD COLUMN dunning_message_2 text,
  ADD COLUMN dunning_message_3 text,
  ADD COLUMN dunning_message_4 text,
  ADD COLUMN dunning_message_5 text;

-- Service charge rate sanity. 0 = disabled regardless of the boolean.
ALTER TABLE firm_settings
  ADD CONSTRAINT service_charge_rate_bounded
  CHECK (service_charge_rate_bps >= 0 AND service_charge_rate_bps <= 10000);
