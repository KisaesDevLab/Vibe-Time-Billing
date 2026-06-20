-- =====================================================================
-- Migration: 0179_time_entry_appointment.sql
--
-- Durable link from a time entry back to the appointment it was logged
-- from (the "Log time" button on an appointment). Nullable — the vast
-- majority of time is logged with no appointment behind it. ON DELETE
-- SET NULL: appointments are effectively never hard-deleted, but if one
-- ever is, keep the time entry (it's billable work) and just drop the
-- back-link. Partial index because the column is overwhelmingly NULL.
-- =====================================================================

ALTER TABLE vibetb.time_entry
  ADD COLUMN IF NOT EXISTS appointment_id uuid
  REFERENCES vibetb.appointment (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS time_entry_appointment_idx
  ON vibetb.time_entry (appointment_id)
  WHERE appointment_id IS NOT NULL;
