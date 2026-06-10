-- =====================================================================
-- Migration: 0144_appointment_location_option.sql
--
-- A firm-managed list of reusable appointment locations, selectable at
-- booking time in addition to typing a one-off location, and attachable to
-- a staff availability window (so a booked slot can default to that
-- location). Each preset = a meeting type + a free-text detail (address /
-- video link / phone number).
--
-- The appointment keeps its canonical location enum + location_detail text
-- (populated from the preset at booking time), so every existing reader
-- keeps working; location_option_id only records which preset was used.
--
-- NOTE: bare IF NOT EXISTS only (the pglite test harness strips DO $$ … $$).
-- The table name is `appointment_location_option` (NOT `appointment_location`,
-- which is the enum type's name).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.appointment_location_option (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  name          text NOT NULL,
  location_type appointment_location NOT NULL DEFAULT 'IN_PERSON',
  detail        text,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_location_option_firm_sort_idx
  ON vibetb.appointment_location_option (firm_id, sort_order);

-- Appointment: record which preset (if any) was used.
ALTER TABLE vibetb.appointment
  ADD COLUMN IF NOT EXISTS location_option_id uuid
    REFERENCES vibetb.appointment_location_option(id) ON DELETE SET NULL;

-- Staff availability window: optional location for the window.
ALTER TABLE vibetb.staff_availability
  ADD COLUMN IF NOT EXISTS location_option_id uuid
    REFERENCES vibetb.appointment_location_option(id) ON DELETE SET NULL;
