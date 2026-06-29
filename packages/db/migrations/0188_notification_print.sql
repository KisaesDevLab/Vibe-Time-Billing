-- =====================================================================
-- Migration: 0188_notification_print.sql
--
-- PRINT channel for notification templates. A notification template with
-- channel='PRINT' defines a printed message + a target printer; when the
-- notification fires it auto-prints via the Vibe Print gateway. The
-- `channel` column is plain text (TS-level enum), so 'PRINT' needs no DDL
-- here; this only adds the per-template printer binding.
-- =====================================================================

ALTER TABLE vibetb.notification_template
  ADD COLUMN IF NOT EXISTS printer_mode text,
  ADD COLUMN IF NOT EXISTS printer_id integer;
