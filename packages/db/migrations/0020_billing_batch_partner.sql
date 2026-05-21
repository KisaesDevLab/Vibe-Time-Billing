-- =====================================================================
-- Migration: 0020_billing_batch_partner.sql
--
-- Pre-bill partner assignment (Phase 11 #10). Adds assigned_partner_id
-- to billing_batch so a different partner can review a pre-bill than
-- the engagement's partner-in-charge. NULL = falls back to engagement
-- partner. Index for the partner's pending-prebill dashboard.
-- =====================================================================

ALTER TABLE billing_batch
  ADD COLUMN IF NOT EXISTS assigned_partner_id UUID
    REFERENCES app_user(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS billing_batch_assigned_partner_idx
  ON billing_batch (assigned_partner_id, status)
  WHERE assigned_partner_id IS NOT NULL;
