-- =====================================================================
-- Migration: 0041_tax_and_surcharge_tables.sql
--
-- v2 Part 2 — table changes for sales tax + per-engagement surcharge.
-- Enum values added in 0040; the table-level ALTERs land here so the
-- new enum values are fully committed and usable.
--
-- Locked: tax base = subtotal + surcharge (5% of $1,000+$30 = $51.50).
-- Per-engagement tax config; firm-default + per-engagement override
-- for the surcharge label.
-- =====================================================================

-- ---------------------------------------------------------------------
-- engagement: tax + surcharge config
-- ---------------------------------------------------------------------

ALTER TABLE engagement
  ADD COLUMN IF NOT EXISTS tax_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_label TEXT NOT NULL DEFAULT 'Sales tax',
  ADD COLUMN IF NOT EXISTS surcharge_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS surcharge_type TEXT NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN IF NOT EXISTS surcharge_value_bps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_amount_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_label TEXT;

ALTER TABLE engagement
  ADD CONSTRAINT engagement_tax_rate_range
    CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000);

ALTER TABLE engagement
  ADD CONSTRAINT engagement_surcharge_type_chk
    CHECK (surcharge_type IN ('PERCENT', 'FLAT_AMOUNT'));

ALTER TABLE engagement
  ADD CONSTRAINT engagement_surcharge_value_range
    CHECK (surcharge_value_bps >= 0 AND surcharge_value_bps <= 10000);

ALTER TABLE engagement
  ADD CONSTRAINT engagement_surcharge_amount_nonneg
    CHECK (surcharge_amount_cents >= 0);

-- ---------------------------------------------------------------------
-- firm_settings: default surcharge label inherited by engagements
-- whose surcharge_label is NULL.
-- ---------------------------------------------------------------------

ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS default_surcharge_label TEXT NOT NULL DEFAULT 'Surcharge';

-- ---------------------------------------------------------------------
-- invoice: persist the tax + surcharge totals so the PDF + reports can
-- round-trip without re-deriving from line items.
-- ---------------------------------------------------------------------

ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS tax_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_cents BIGINT NOT NULL DEFAULT 0;
