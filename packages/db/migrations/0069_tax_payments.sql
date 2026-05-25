-- =====================================================================
-- Migration: 0069_tax_payments.sql  (Stage CP1)
--
-- Tax Payments addendum — staff-entered scheduled tax obligations
-- surfaced to clients in the portal. Per the build plan §2.7, this is
-- a flagship feature that eliminates the support burden of clients
-- emailing "what do I owe and when?" during tax season.
--
-- Source of truth: staff-entered manually (v1 default). A reserved
-- external_ref column keeps the door open for a future Vibe MyBooks
-- import without committing to that integration shape now.
--
-- Soft-delete via status='VOIDED' per CLAUDE.md #3 (never DELETE).
-- Audit log captures every mutation (handled by application code).
-- =====================================================================

-- --- (1) enum --------------------------------------------------------

CREATE TYPE tax_payment_status AS ENUM ('SCHEDULED', 'PAID', 'VOIDED');

-- --- (2) tax_payment table -------------------------------------------

CREATE TABLE vibetb.tax_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE RESTRICT,
  -- Engagement linkage is OPTIONAL — many tax payments aren't tied to
  -- a single engagement (e.g. a client's personal 1040 obligation
  -- independent of any active engagement).
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE RESTRICT,

  -- Free text for v1; firm guidance via tooltip ("Federal" / "State - XX"
  -- / "Local - city"). Constrained enum deferred — firms vary.
  jurisdiction text NOT NULL,
  payment_type text NOT NULL,  -- "Estimated", "Extension", "Balance due", "Quarterly", etc.
  tax_year integer,

  amount_cents bigint NOT NULL,
  due_date date NOT NULL,

  status tax_payment_status NOT NULL DEFAULT 'SCHEDULED',
  paid_date date,
  confirmation_number text,
  notes text,  -- firm-internal; portal API strips this column

  -- Reserved for future MyBooks connector wiring; staff-entered rows
  -- leave NULL. Per QUESTIONS.md R6.1 the integration shape is still
  -- operator-blocked.
  external_ref text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  CONSTRAINT tax_payment_amount_nonneg CHECK (amount_cents >= 0)
);

-- Sweep + listing indexes.
CREATE INDEX tax_payment_firm_status_due_idx
  ON vibetb.tax_payment (firm_id, status, due_date);

CREATE INDEX tax_payment_client_status_due_idx
  ON vibetb.tax_payment (client_id, status, due_date);

-- Partial — most rows don't reference an engagement.
CREATE INDEX tax_payment_engagement_idx
  ON vibetb.tax_payment (engagement_id)
  WHERE engagement_id IS NOT NULL;
