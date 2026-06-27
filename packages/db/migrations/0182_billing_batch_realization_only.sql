-- =====================================================================
-- Migration: 0182_billing_batch_realization_only.sql
--
-- Realization-only close-out batches (engagement WIP true-up). Such a
-- batch clears accumulated WIP and carries a per-timekeeper realization
-- adjustment, but its revenue was already collected (e.g. via recurring
-- monthly fees) — so it must NEVER be turned into a client invoice.
--
-- This flag is the durable, enforceable marker: generate-from-batch
-- rejects it and the invoiceable-batch queue excludes it. Existing
-- batches default to false (normal, invoiceable pre-bills).
-- =====================================================================

ALTER TABLE vibetb.billing_batch
  ADD COLUMN IF NOT EXISTS realization_only boolean NOT NULL DEFAULT false;
