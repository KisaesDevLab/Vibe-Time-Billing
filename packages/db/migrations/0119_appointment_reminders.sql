-- =====================================================================
-- Migration: 0119_appointment_reminders.sql  (gap fix for D-BK-06)
--
-- Appointment reminders. The calendar reminder engine (0111) only covers
-- ingested calendar_events; booked appointments need their own pre-meeting
-- reminders. This ledger gives per (appointment × contact × offset)
-- idempotency, mirroring calendar_reminders_sent. Firm-wide offsets reuse
-- calendar_settings.reminder_offsets_minutes; per-contact opt-out reuses
-- client_contact.receive_appointment_reminders.
--
-- NOTE: bare IF NOT EXISTS only (pglite harness strips DO $$ blocks).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.appointment_reminders_sent (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id         uuid NOT NULL REFERENCES vibetb.appointment(id) ON DELETE CASCADE,
  client_contact_id      uuid REFERENCES vibetb.client_contact(id) ON DELETE CASCADE,
  reminder_offset_minutes integer NOT NULL,
  sent_at                timestamptz NOT NULL DEFAULT now(),
  delivery_status        text NOT NULL DEFAULT 'sent'
);

CREATE UNIQUE INDEX IF NOT EXISTS appointment_reminders_sent_uk
  ON vibetb.appointment_reminders_sent (appointment_id, client_contact_id, reminder_offset_minutes);
CREATE INDEX IF NOT EXISTS appointment_reminders_sent_appt_idx
  ON vibetb.appointment_reminders_sent (appointment_id);
