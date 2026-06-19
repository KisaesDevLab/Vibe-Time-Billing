-- =====================================================================
-- Migration: 0178_pricing_suggestion.sql
--
-- AI pricing suggestion. The deterministic engine builds a fee range from
-- expected effort × burdened cost, a true gross margin (division), and an
-- economic factor; the LLM only writes the rationale. This migration adds the
-- firm-settings knobs, a cached economic_index (CPI/ECI + as-of date) so the
-- factor is auditable and survives a fetch outage, and a pricing_decision log
-- (suggestion + the CPA's accept/edit/override, audit-only). Net-new; no
-- backfill.
-- =====================================================================

-- --- firm_settings knobs -------------------------------------------------
ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS pricing_economic_source TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS pricing_economic_manual_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS pricing_target_margin_pct NUMERIC(5, 2) NOT NULL DEFAULT 40.00,
  ADD COLUMN IF NOT EXISTS pricing_expected_hours_stat TEXT NOT NULL DEFAULT 'TRIMMED_MEAN',
  ADD COLUMN IF NOT EXISTS pricing_cohort_min INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS pricing_burdened_cost_per_tier JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS pricing_allow_llm_adjust BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE vibetb.firm_settings
  DROP CONSTRAINT IF EXISTS firm_settings_pricing_economic_source_chk;
ALTER TABLE vibetb.firm_settings
  ADD CONSTRAINT firm_settings_pricing_economic_source_chk
  CHECK (pricing_economic_source IN ('MANUAL', 'CPI', 'ECI'));

ALTER TABLE vibetb.firm_settings
  DROP CONSTRAINT IF EXISTS firm_settings_pricing_hours_stat_chk;
ALTER TABLE vibetb.firm_settings
  ADD CONSTRAINT firm_settings_pricing_hours_stat_chk
  CHECK (pricing_expected_hours_stat IN ('TRIMMED_MEAN', 'MEDIAN'));

ALTER TABLE vibetb.firm_settings
  DROP CONSTRAINT IF EXISTS firm_settings_pricing_margin_chk;
ALTER TABLE vibetb.firm_settings
  ADD CONSTRAINT firm_settings_pricing_margin_chk
  CHECK (pricing_target_margin_pct >= 0 AND pricing_target_margin_pct < 100);

-- --- economic_index (cached CPI/ECI) ------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.economic_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  value_pct NUMERIC(6, 3) NOT NULL,
  as_of_date date NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economic_index_source_chk CHECK (source IN ('CPI', 'ECI'))
);
CREATE INDEX IF NOT EXISTS economic_index_firm_source_idx
  ON vibetb.economic_index (firm_id, source, fetched_at);

-- --- pricing_decision (suggestion + override log) -----------------------
CREATE TABLE IF NOT EXISTS vibetb.pricing_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,

  inputs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggested_low_cents bigint NOT NULL,
  suggested_high_cents bigint NOT NULL,
  suggested_rationale TEXT,
  rationale_source TEXT,
  economic_source TEXT,
  economic_as_of date,
  confidence TEXT,

  user_action TEXT NOT NULL DEFAULT 'PENDING',
  final_low_cents bigint,
  final_high_cents bigint,
  decided_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  decided_at timestamptz,

  created_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_decision_action_chk
    CHECK (user_action IN ('PENDING', 'ACCEPTED', 'EDITED', 'OVERRIDDEN'))
);
CREATE INDEX IF NOT EXISTS pricing_decision_engagement_idx
  ON vibetb.pricing_decision (engagement_id, created_at);
CREATE INDEX IF NOT EXISTS pricing_decision_firm_idx
  ON vibetb.pricing_decision (firm_id, created_at);
