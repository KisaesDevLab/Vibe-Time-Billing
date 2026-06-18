-- =====================================================================
-- Migration: 0168_public_booking.sql  (public self-booking, request->confirm)
--
-- Turns the BK-8 stub (staff_public_booking_link, migration 0118) into a
-- working public booking page: each page has its OWN availability windows,
-- a per-page approver list + a separate notify list, and a booking_request
-- queue. A PENDING (non-expired) booking_request doubles as the slot HOLD,
-- so no separate reservation table is needed. The appointment row is only
-- created when a staff approver confirms the request.
--
-- NOTE: bare IF NOT EXISTS only (pglite test harness strips DO $$ blocks).
-- =====================================================================

-- Per-page booking rules + hold/abuse settings on the existing link table.
ALTER TABLE vibetb.staff_public_booking_link
  ADD COLUMN IF NOT EXISTS hold_expiry_hours        integer NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS slot_increment_minutes   integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS min_notice_hours         integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS buffer_before_minutes    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buffer_after_minutes     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_duration_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS require_captcha          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS daily_cap                integer;

-- The page's OWN weekly availability windows (mirrors staff_availability,
-- but scoped to a booking link instead of a staff member).
CREATE TABLE IF NOT EXISTS vibetb.public_booking_availability (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_link_id       uuid NOT NULL REFERENCES vibetb.staff_public_booking_link(id) ON DELETE CASCADE,
  day_of_week           integer NOT NULL,
  start_time            time NOT NULL,
  end_time              time NOT NULL,
  -- 0144-style: optional location preset applied to bookings in this window.
  location_option_id    uuid REFERENCES vibetb.appointment_location_option(id) ON DELETE SET NULL,
  -- 0156-style: restrict this window to specific appointment types; null = all.
  appointment_type_ids  uuid[],
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_booking_availability_dow_ck CHECK (day_of_week BETWEEN 0 AND 6)
);
CREATE INDEX IF NOT EXISTS public_booking_availability_link_dow_idx
  ON vibetb.public_booking_availability (booking_link_id, day_of_week);

-- Who may approve a request for this page.
CREATE TABLE IF NOT EXISTS vibetb.public_booking_link_approver (
  booking_link_id  uuid NOT NULL REFERENCES vibetb.staff_public_booking_link(id) ON DELETE CASCADE,
  app_user_id      uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_link_id, app_user_id)
);

-- To whom the request notification is sent (separate from approvers).
CREATE TABLE IF NOT EXISTS vibetb.public_booking_link_notify (
  booking_link_id  uuid NOT NULL REFERENCES vibetb.staff_public_booking_link(id) ON DELETE CASCADE,
  app_user_id      uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  -- which channels to use for this recipient, e.g. {EMAIL,SMS}.
  channels         text[] NOT NULL DEFAULT '{EMAIL}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_link_id, app_user_id)
);

-- The pending booking request. A PENDING row with hold_expires_at in the
-- future is the slot HOLD; the availability engine counts it as busy.
CREATE TABLE IF NOT EXISTS vibetb.booking_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  booking_link_id       uuid REFERENCES vibetb.staff_public_booking_link(id) ON DELETE SET NULL,
  staff_id              uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  appointment_type_id   uuid REFERENCES vibetb.appointment_type(id) ON DELETE SET NULL,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  duration_minutes      integer NOT NULL,
  visitor_name          text NOT NULL,
  visitor_email         text NOT NULL,
  visitor_phone         text,
  notes                 text,
  person_id             uuid REFERENCES vibetb.person(id) ON DELETE SET NULL,
  client_contact_id     uuid REFERENCES vibetb.client_contact(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'PENDING',
  hold_expires_at       timestamptz NOT NULL,
  decided_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  decided_at            timestamptz,
  decline_reason        text,
  created_appointment_id uuid REFERENCES vibetb.appointment(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_request_status_ck
    CHECK (status IN ('PENDING','APPROVED','DECLINED','EXPIRED','CANCELLED'))
);
-- Busy-overlap lookup for the slot engine (active holds for a staff member).
CREATE INDEX IF NOT EXISTS booking_request_staff_status_starts_idx
  ON vibetb.booking_request (staff_id, status, starts_at);
-- Staff queue + the worker expiry sweep.
CREATE INDEX IF NOT EXISTS booking_request_firm_status_idx
  ON vibetb.booking_request (firm_id, status);
CREATE INDEX IF NOT EXISTS booking_request_hold_expiry_idx
  ON vibetb.booking_request (status, hold_expires_at);
