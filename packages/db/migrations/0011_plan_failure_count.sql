-- =====================================================================
-- Migration: 0011_plan_failure_count.sql
--
-- Track consecutive autopay failures per recurring plan (Phase 10 #30).
-- When this counter reaches `autopay_pause_threshold`, the recurring
-- billing worker pauses the plan and records pausedReason='autopay_threshold'.
-- The threshold is per-plan with firm-wide default of 3.
-- =====================================================================

ALTER TABLE recurring_billing_plan
  ADD COLUMN IF NOT EXISTS consecutive_failure_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autopay_pause_threshold     INTEGER NOT NULL DEFAULT 3;
