-- =====================================================================
-- Migration: 0143_portal_access_request.sql
--
-- Self-service portal access requests. An unauthenticated visitor to the
-- client portal enters an email/phone; if it matches a firm `person`, we
-- capture a verification id (last-4 SSN or entity EIN) and queue ONE
-- request per client that person is a contact of. Staff review each under
-- Approvals and approve (granting portal access) or deny.
--
-- Enumeration-safe: the portal always returns the same generic response,
-- so rows are only created server-side on a real match. The id_value is
-- captured display-only (last-4 / EIN) for staff to eyeball; no automatic
-- cross-check against the firm's stored tax-id hash.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare IF NOT EXISTS only. Migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.portal_access_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- groups the fan-out rows created from one portal submission.
  submission_id     uuid NOT NULL,
  person_id         uuid NOT NULL REFERENCES vibetb.person(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  -- the directory association at submission time (nullable; informational).
  client_contact_id uuid REFERENCES vibetb.client_contact(id) ON DELETE SET NULL,
  submitted_email   text,
  submitted_phone   text,
  -- 'SSN_LAST4' | 'EIN'
  id_type           text NOT NULL,
  -- display-only: the last-4 digits of SSN, or the entity EIN as entered.
  id_value          text NOT NULL,
  -- 'PENDING' | 'APPROVED' | 'DENIED'
  status            text NOT NULL DEFAULT 'PENDING',
  decided_by        uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_access_request_firm_status_idx
  ON vibetb.portal_access_request (firm_id, status);
CREATE INDEX IF NOT EXISTS portal_access_request_person_idx
  ON vibetb.portal_access_request (person_id);
CREATE INDEX IF NOT EXISTS portal_access_request_client_idx
  ON vibetb.portal_access_request (client_id);
CREATE INDEX IF NOT EXISTS portal_access_request_submission_idx
  ON vibetb.portal_access_request (submission_id);

-- At most one OPEN (pending) request per (person, client) — re-submitting
-- while one is already queued is a no-op, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_request_pending_uk
  ON vibetb.portal_access_request (person_id, client_id)
  WHERE status = 'PENDING';
