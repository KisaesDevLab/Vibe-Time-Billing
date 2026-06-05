-- =====================================================================
-- Migration: 0118_public_booking_stub.sql  (BK-8, v2 stub)
--
-- Schema-only groundwork for v2 client self-booking public links. The
-- feature is gated by FEATURE_PUBLIC_BOOKING (default false); the route
-- returns 501 until v2. Shipping the table now keeps the v2 upgrade a
-- pure code change (no migration ordering surprises).
--
-- NOTE: bare IF NOT EXISTS only (pglite harness strips DO $$ blocks).
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.staff_public_booking_link (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  staff_id                    uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  slug                        text NOT NULL,
  is_active                   boolean NOT NULL DEFAULT true,
  -- null = all active appointment types; else a jsonb array of type ids.
  allowed_appointment_type_ids jsonb,
  custom_message              text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_public_booking_link_slug_uk
  ON vibetb.staff_public_booking_link (slug);
CREATE INDEX IF NOT EXISTS staff_public_booking_link_staff_idx
  ON vibetb.staff_public_booking_link (staff_id);
