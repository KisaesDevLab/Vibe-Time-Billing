-- =====================================================================
-- Migration: 0013_legal_hold.sql
--
-- Add legal_hold_flag to client (Phase 19 #12). When true:
--   - The retention worker skips the client's audit + ai_request_log
--     entries
--   - The client_archive endpoint refuses to archive
--   - Backups must be retained beyond the default 30-day window
-- =====================================================================

ALTER TABLE client
  ADD COLUMN IF NOT EXISTS legal_hold_flag BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legal_hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS legal_hold_set_at TIMESTAMPTZ;
