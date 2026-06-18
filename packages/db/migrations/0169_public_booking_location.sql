-- =====================================================================
-- Migration: 0169_public_booking_location.sql
--
-- Lets a public booking page mirror the staff wizard's location handling:
-- each page availability window can restrict which contact types it allows
-- (in-person / phone / video), and a booking_request captures the visitor's
-- chosen location so the approved appointment reflects it.
--
-- NOTE: bare IF NOT EXISTS only (pglite test harness strips DO $$ blocks).
-- =====================================================================

-- Allowed contact types for a page window (mirrors staff_availability
-- .location_types, 0120). NULL/empty = all locations allowed.
ALTER TABLE vibetb.public_booking_availability
  ADD COLUMN IF NOT EXISTS location_types text[];

-- The visitor's chosen meeting location, carried onto the approved appointment.
ALTER TABLE vibetb.booking_request
  ADD COLUMN IF NOT EXISTS location           text,
  ADD COLUMN IF NOT EXISTS location_option_id uuid REFERENCES vibetb.appointment_location_option(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_detail    text;
