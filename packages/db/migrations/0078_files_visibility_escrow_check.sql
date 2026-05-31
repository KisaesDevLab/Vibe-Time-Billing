-- =====================================================================
-- Migration: 0078_files_visibility_escrow_check.sql
--
-- Bug fix: migration 0060 introduced the 'escrow' visibility value at
-- the app layer but didn't relax the inline CHECK constraint from
-- migration 0046, which still restricts visibility to
-- ('private', 'client_visible'). Files saved with visibility='escrow'
-- fail the constraint. Drop the unnamed constraint and replace it with
-- a named version that includes 'escrow'.
-- =====================================================================

ALTER TABLE vibetb.files
  DROP CONSTRAINT IF EXISTS files_visibility_check;

ALTER TABLE vibetb.files
  ADD CONSTRAINT files_visibility_ck
  CHECK (visibility IN ('private', 'client_visible', 'escrow'));
