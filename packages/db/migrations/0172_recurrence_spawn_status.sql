-- =====================================================================
-- Migration: 0172_recurrence_spawn_status.sql
--
-- Make the lifecycle status of a recurrence-spawned engagement
-- configurable. spawnNextEngagement() previously hardcoded 'ACTIVE'.
-- The template now carries a default (default_recurrence_status); an
-- individual recurrence can override it (spawn_status). NULL on either
-- falls back to 'ACTIVE', preserving existing behavior.
-- =====================================================================

ALTER TABLE vibetb.engagement_template
  ADD COLUMN IF NOT EXISTS default_recurrence_status engagement_status;

ALTER TABLE vibetb.engagement_recurrence
  ADD COLUMN IF NOT EXISTS spawn_status engagement_status;
