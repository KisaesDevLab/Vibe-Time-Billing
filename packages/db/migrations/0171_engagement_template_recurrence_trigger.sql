-- =====================================================================
-- Migration: 0171_engagement_template_recurrence_trigger.sql
--
-- Completes the engagement template's recurrence default: alongside
-- default_recurrence_frequency (0170), store the trigger mode so a
-- template fully defines the recurrence ('SCHEDULE' | 'ON_COMPLETION').
-- =====================================================================

ALTER TABLE vibetb.engagement_template
  ADD COLUMN IF NOT EXISTS default_recurrence_trigger_mode text;
