-- =====================================================================
-- Migration: 0023_billing_batch_versioning.sql
--
-- Pre-bill reopen → new version (Phase 11 #23). When a partner needs
-- to revise a batch they've already approved or invoiced, the
-- /reopen endpoint creates a fresh DRAFT batch and chains it back to
-- the previous one via previous_version_id. Old batch flips to
-- CANCELLED so reports surface the right one. New batch carries
-- forward the entries that weren't billed.
-- =====================================================================

ALTER TABLE billing_batch
  ADD COLUMN IF NOT EXISTS previous_version_id UUID
    REFERENCES billing_batch(id) ON DELETE SET NULL;

ALTER TABLE billing_batch
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS billing_batch_previous_idx
  ON billing_batch (previous_version_id)
  WHERE previous_version_id IS NOT NULL;
