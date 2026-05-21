-- =====================================================================
-- Migration: 0012_entry_action_held.sql
--
-- Add WRITE_OFF_HELD as a fourth billing_batch_entry_action value
-- (Phase 11 #6). Existing WRITE_OFF is treated as "removed" — entry
-- discarded permanently. WRITE_OFF_HELD keeps the entry visible on the
-- WIP dashboard so the partner can revisit it later.
-- =====================================================================

ALTER TYPE billing_batch_entry_action ADD VALUE IF NOT EXISTS 'WRITE_OFF_HELD';
