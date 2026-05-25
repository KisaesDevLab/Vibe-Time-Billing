-- =====================================================================
-- Migration: 0073_appointments.sql  (Stage CP12)
--
-- Client-visible appointments (Build Plan §2.6).
--
-- v1 ships as a read-only mirror — the firm enters appointments
-- manually via /admin/appointments or via a future webhook from
-- Google Calendar / Microsoft 365 / Calendly that POSTs into the
-- staff API.  First-party booking ("client picks a time from
-- availability") is deferred.
--
-- The portal surface is strictly read — no client-initiated changes.
-- RSVP / reschedule actions land in a follow-up commit when the
-- firm-side scheduling integration is wired.
--
-- external_ref is reserved for the future webhook integration so we
-- don't have to alter the schema again to track which calendar event
-- backs a given row.
-- =====================================================================

CREATE TYPE appointment_status AS ENUM (
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE appointment_location AS ENUM (
  'VIDEO',
  'PHONE',
  'IN_PERSON'
);

CREATE TABLE vibetb.appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  -- Optional engagement linkage. Tax-prep follow-up calls naturally
  -- tie to one engagement; an annual partner check-in might not.
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE RESTRICT,

  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location appointment_location NOT NULL DEFAULT 'VIDEO',
  -- e.g. Zoom URL, phone number, office room name.  Free-text since
  -- it varies by location type.
  location_detail text,

  -- The staff lead (the one the client should show up to meet).
  lead_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  status appointment_status NOT NULL DEFAULT 'SCHEDULED',
  cancelled_reason text,
  cancelled_at timestamptz,
  cancelled_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  -- Reserved for a future Calendar-API import. Staff-entered rows
  -- leave NULL.
  external_ref text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  CONSTRAINT appointment_time_order CHECK (ends_at > starts_at)
);

CREATE INDEX appointment_firm_starts_idx
  ON vibetb.appointment (firm_id, starts_at);
CREATE INDEX appointment_client_starts_idx
  ON vibetb.appointment (client_id, starts_at);
CREATE INDEX appointment_lead_starts_idx
  ON vibetb.appointment (lead_app_user_id, starts_at)
  WHERE lead_app_user_id IS NOT NULL;
