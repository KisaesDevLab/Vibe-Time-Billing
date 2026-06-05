-- =====================================================================
-- Migration: 0116_appointment_booking.sql  (Addendum BK-1)
--
-- Multi-staff appointment booking. Builds ON TOP OF the existing
-- single-staff `appointment` table (0073) rather than replacing it:
--   * new `appointment_type` library (firm-managed)
--   * `appointment_staff` join — one row per staff member per
--     appointment (multi-staff); carries the per-staff provider event
--     handle + write status (the CAL-9 single-lead external_ref is
--     superseded by this; external_ref is retained + backfilled here)
--   * `appointment_participant` — client contacts invited (RSVP)
--   * `appointment_reschedule_request` — client-initiated reschedule asks
--   * `appointment_engagement_note` — links a booking to its auto-note
--   * `staff_availability` + `staff_booking_settings` — per-staff hours,
--     buffers, notice, slot increment, booking on/off
-- Plus additive columns on `appointment` (type, duration, internal
-- notes, cancel/reschedule tokens, client/staff cancel actor).
--
-- NOTE: do NOT wrap DDL in `DO $$ BEGIN IF NOT EXISTS ... END $$` — the
-- pglite test harness strips that shape. Use bare IF NOT EXISTS. The
-- migrate runner wraps each file in one transaction (no CONCURRENTLY).
-- =====================================================================

-- New enums (bare CREATE — runs once per DB; reuse existing
-- appointment_location for location types).
CREATE TYPE provider_write_status AS ENUM ('pending', 'written', 'failed');
CREATE TYPE appointment_cancelled_by AS ENUM ('staff', 'client');
CREATE TYPE reschedule_request_status AS ENUM ('pending', 'accepted', 'declined');
CREATE TYPE appointment_rsvp_status AS ENUM ('pending', 'confirmed', 'declined');

-- 1. appointment_type ------------------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.appointment_type (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  default_duration_minutes integer NOT NULL DEFAULT 30,
  default_location_type    appointment_location NOT NULL DEFAULT 'VIDEO',
  description              text,
  color                    text,
  is_active                boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointment_type_firm_sort_idx
  ON vibetb.appointment_type (firm_id, sort_order);

-- 2. appointment additive columns (extend 0073 table) ----------------
ALTER TABLE vibetb.appointment
  ADD COLUMN IF NOT EXISTS appointment_type_id uuid
    REFERENCES vibetb.appointment_type(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS internal_notes text,
  ADD COLUMN IF NOT EXISTS cancel_token uuid,
  ADD COLUMN IF NOT EXISTS reschedule_token uuid,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by_actor appointment_cancelled_by,
  ADD COLUMN IF NOT EXISTS last_rescheduled_at timestamptz;

-- Booking allows client-less internal meetings (D-BK).
ALTER TABLE vibetb.appointment ALTER COLUMN client_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS appointment_cancel_token_uk
  ON vibetb.appointment (cancel_token) WHERE cancel_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS appointment_reschedule_token_uk
  ON vibetb.appointment (reschedule_token) WHERE reschedule_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointment_client_status_idx
  ON vibetb.appointment (client_id, status) WHERE client_id IS NOT NULL;

-- 3. appointment_staff (multi-staff join) ----------------------------
-- calendar_event_id is the TB calendar_events mirror row (drives
-- update/delete via CalendarWriteService, mirroring how external_ref
-- worked single-lead); provider_event_id/calendar_id are the provider's
-- own handles (informational, per spec).
CREATE TABLE IF NOT EXISTS vibetb.appointment_staff (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id        uuid NOT NULL REFERENCES vibetb.appointment(id) ON DELETE CASCADE,
  staff_id              uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  calendar_event_id     uuid REFERENCES vibetb.calendar_events(id) ON DELETE SET NULL,
  provider_event_id     text,
  provider_calendar_id  text,
  provider_write_status provider_write_status NOT NULL DEFAULT 'pending',
  provider_write_error  text,
  written_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS appointment_staff_appt_staff_uk
  ON vibetb.appointment_staff (appointment_id, staff_id);
CREATE INDEX IF NOT EXISTS appointment_staff_appt_idx
  ON vibetb.appointment_staff (appointment_id);
CREATE INDEX IF NOT EXISTS appointment_staff_staff_appt_idx
  ON vibetb.appointment_staff (staff_id, appointment_id);

-- 4. appointment_participant -----------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.appointment_participant (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id       uuid NOT NULL REFERENCES vibetb.appointment(id) ON DELETE CASCADE,
  client_contact_id    uuid NOT NULL REFERENCES vibetb.client_contact(id) ON DELETE CASCADE,
  rsvp_status          appointment_rsvp_status NOT NULL DEFAULT 'pending',
  confirmation_sent_at timestamptz,
  cancellation_sent_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS appointment_participant_appt_contact_uk
  ON vibetb.appointment_participant (appointment_id, client_contact_id);
CREATE INDEX IF NOT EXISTS appointment_participant_appt_idx
  ON vibetb.appointment_participant (appointment_id);

-- 5. appointment_reschedule_request ----------------------------------
CREATE TABLE IF NOT EXISTS vibetb.appointment_reschedule_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id         uuid NOT NULL REFERENCES vibetb.appointment(id) ON DELETE CASCADE,
  requested_by_contact_id uuid REFERENCES vibetb.client_contact(id) ON DELETE SET NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  message                text,
  status                 reschedule_request_status NOT NULL DEFAULT 'pending',
  resolved_at            timestamptz,
  resolved_by_staff_id   uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS appointment_reschedule_request_appt_idx
  ON vibetb.appointment_reschedule_request (appointment_id);
CREATE INDEX IF NOT EXISTS appointment_reschedule_request_status_idx
  ON vibetb.appointment_reschedule_request (status);

-- 6. appointment_engagement_note -------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.appointment_engagement_note (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES vibetb.appointment(id) ON DELETE CASCADE,
  engagement_id  uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  note_id        uuid NOT NULL REFERENCES vibetb.engagement_note(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointment_engagement_note_appt_idx
  ON vibetb.appointment_engagement_note (appointment_id);

-- 7. staff_availability ----------------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.staff_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  day_of_week integer NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_availability_dow_ck CHECK (day_of_week BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS staff_availability_staff_dow_idx
  ON vibetb.staff_availability (staff_id, day_of_week);

-- 8. staff_booking_settings ------------------------------------------
CREATE TABLE IF NOT EXISTS vibetb.staff_booking_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id              uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  buffer_before_minutes integer NOT NULL DEFAULT 0,
  buffer_after_minutes  integer NOT NULL DEFAULT 0,
  min_notice_hours      integer NOT NULL DEFAULT 1,
  slot_increment_minutes integer NOT NULL DEFAULT 30,
  booking_enabled       boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_booking_settings_staff_uk
  ON vibetb.staff_booking_settings (staff_id);

-- 9. Backfill appointment_staff from existing single-lead rows -------
-- Each existing appointment with a lead becomes one appointment_staff
-- row; if it had a mirrored calendar event (external_ref = the
-- calendar_events id) carry it across as 'written'.
INSERT INTO vibetb.appointment_staff
  (appointment_id, staff_id, calendar_event_id, provider_write_status, written_at)
-- 'written' only when external_ref is a real calendar_events UUID we can
-- carry into calendar_event_id; otherwise leave 'pending' (a later
-- reschedule/retry will create the event) so status never claims "written"
-- without a usable event handle.
SELECT a.id,
       a.lead_app_user_id,
       CASE WHEN a.external_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN a.external_ref::uuid ELSE NULL END,
       CASE WHEN a.external_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN 'written'::provider_write_status ELSE 'pending'::provider_write_status END,
       CASE WHEN a.external_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN a.created_at ELSE NULL END
FROM vibetb.appointment a
WHERE a.lead_app_user_id IS NOT NULL
ON CONFLICT (appointment_id, staff_id) DO NOTHING;
