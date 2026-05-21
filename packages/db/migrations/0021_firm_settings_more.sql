-- =====================================================================
-- Migration: 0021_firm_settings_more.sql
--
-- Surfaces three more admin-editable fields for FirmSettings (Phase
-- 20 #4, #5, #6, #7, #8):
--
--   enabled_fee_structures jsonb  · per Phase 20 #4 — array of fee
--     structures the firm wants to expose in engagement-create dropdowns.
--     Default = all 5. Filters the EngagementCreateSchema enum at write
--     time. Stored on firm_settings (not firm) because it's pure UI
--     policy.
--
--   ai_provider text                · per Phase 23 #6 — admin can
--     override the firm-wide AI provider preference. NULL = use
--     local-first per Q15 (VIBE_AI_FEATURE_<NAME> still wins).
--
--   billable_target_hours_per_month integer · per Phase 20 #8 — firm-
--     wide default monthly billable target. Per-user override lives
--     on app_user (column added below) and the targets report's
--     enforcement code reads max(user, firm) or default 130.
--
-- App_user gains:
--   billable_target_hours_per_month integer · Phase 20 #8 per-user
--   (standard_hours_per_week already exists on app_user)
-- =====================================================================

ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS enabled_fee_structures JSONB NOT NULL
    DEFAULT '["HOURLY","HOURLY_NTE","FIXED_FEE","FIXED_FEE_WITH_MILESTONES","RECURRING_SUBSCRIPTION"]'::jsonb;

ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS ai_provider TEXT;

ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS billable_target_hours_per_month INTEGER NOT NULL DEFAULT 130;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS billable_target_hours_per_month INTEGER;
