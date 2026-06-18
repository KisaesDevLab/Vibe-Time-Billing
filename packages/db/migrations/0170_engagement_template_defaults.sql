-- =====================================================================
-- Migration: 0170_engagement_template_defaults.sql
--
-- Lets an engagement template pre-fill more of the New Engagement screen:
-- the Mixed-mode / Fee-passthrough / Charge-sales-tax / Add-invoice-surcharge
-- toggles (+ their sub-config) and a default recurrence frequency. The create
-- API already accepts these engagement fields; this just stores the defaults.
--
-- NOTE: bare IF NOT EXISTS only (pglite test harness strips DO $$ blocks).
-- =====================================================================

ALTER TABLE vibetb.engagement_template
  ADD COLUMN IF NOT EXISTS default_mixed_mode_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_fee_passthrough_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_tax_enabled             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_tax_rate_bps            integer,
  ADD COLUMN IF NOT EXISTS default_tax_label               text,
  ADD COLUMN IF NOT EXISTS default_surcharge_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_surcharge_type          text,
  ADD COLUMN IF NOT EXISTS default_surcharge_value_bps     integer,
  ADD COLUMN IF NOT EXISTS default_surcharge_amount_cents  bigint,
  ADD COLUMN IF NOT EXISTS default_surcharge_label         text,
  ADD COLUMN IF NOT EXISTS default_recurrence_frequency    text;
