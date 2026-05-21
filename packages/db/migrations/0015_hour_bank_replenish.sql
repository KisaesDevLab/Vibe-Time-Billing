-- =====================================================================
-- Migration: 0015_hour_bank_replenish.sql
--
-- Add auto-replenish settings to hour_bank (Phase 10 #15).
--
-- When auto_replenish_enabled is true and the running balance drops
-- below auto_replenish_threshold_hours, the bank-monitor worker tops
-- the bank up to auto_replenish_target_hours by creating a PURCHASE
-- transaction and (optionally) a draft invoice. Rollover-cap (Phase 10
-- #18) is enforced separately by clamping the post-replenish balance
-- against rollover_cap_hours.
-- =====================================================================

ALTER TABLE hour_bank
  ADD COLUMN IF NOT EXISTS auto_replenish_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_replenish_threshold_hours NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS auto_replenish_target_hours NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS auto_replenish_last_run_at TIMESTAMPTZ;
