-- =====================================================================
-- Migration: 0111_calendar_reminders.sql  (Calendar Integration, CAL-7)
--
-- Appointment reminders: firm-wide reminder offsets, the sent-ledger
-- (idempotent per event × contact × offset), and a per-contact opt-out.
-- =====================================================================

ALTER TABLE vibetb.calendar_settings
  ADD COLUMN IF NOT EXISTS reminder_offsets_minutes jsonb NOT NULL DEFAULT '[1440, 120]'::jsonb;

ALTER TABLE vibetb.client_contact
  ADD COLUMN IF NOT EXISTS receive_appointment_reminders boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS vibetb.calendar_reminders_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES vibetb.calendar_events(id) ON DELETE CASCADE,
  client_contact_id uuid REFERENCES vibetb.client_contact(id) ON DELETE CASCADE,
  reminder_offset_minutes integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivery_status text NOT NULL DEFAULT 'sent',
  rsvp_token_id uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_reminders_sent_uk
  ON vibetb.calendar_reminders_sent (event_id, client_contact_id, reminder_offset_minutes);
