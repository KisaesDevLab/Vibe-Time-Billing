-- 0121 — Per-type / per-booking reminder schedules + multi-channel + quiet hours.
--
-- A reminder schedule is a jsonb array of steps { offsetMinutes, channel } where
-- channel is EMAIL | SMS | CALL. It can live on an appointment_type (default) or
-- on an appointment (per-booking override). When neither is set, the firm's
-- calendar_settings.reminder_offsets_minutes (email) remains the fallback.
--
-- The reminder ledger gains a `channel` column so the same offset can fire on
-- multiple channels idempotently. Quiet hours bound SMS/voice sends.

ALTER TABLE vibetb.appointment_type
  ADD COLUMN IF NOT EXISTS reminder_schedule jsonb;

ALTER TABLE vibetb.appointment
  ADD COLUMN IF NOT EXISTS reminder_schedule jsonb;

ALTER TABLE vibetb.appointment_reminders_sent
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'EMAIL';

-- Rebuild the idempotency key to include channel (one send per
-- appointment × contact × offset × channel).
DROP INDEX IF EXISTS vibetb.appointment_reminders_sent_uk;
CREATE UNIQUE INDEX IF NOT EXISTS appointment_reminders_sent_uk
  ON vibetb.appointment_reminders_sent
     (appointment_id, client_contact_id, reminder_offset_minutes, channel);

-- Quiet hours for SMS/voice reminders (wall-clock in the firm/office tz).
-- Email ignores these. Defaults: 08:00–20:00.
ALTER TABLE vibetb.calendar_settings
  ADD COLUMN IF NOT EXISTS reminder_quiet_start text NOT NULL DEFAULT '08:00';
ALTER TABLE vibetb.calendar_settings
  ADD COLUMN IF NOT EXISTS reminder_quiet_end text NOT NULL DEFAULT '20:00';
