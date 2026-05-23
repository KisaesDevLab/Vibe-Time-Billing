-- =====================================================================
-- Migration: 0056_credit_memos.sql
--
-- Open credits (credit memos) and credit applications.
--
-- A credit memo represents money the client has on file that hasn't
-- been applied to a specific invoice yet. Sources:
--   MANUAL          — staff entry (retainer, owed-back, etc.)
--   OVERPAYMENT     — sum(allocations) < amount_received on /receive
--   REFUND_EXCESS   — Stripe refund > invoice's recoverable balance
--
-- Applying a credit to an invoice writes BOTH:
--   - a credit_application row (ledger entry on the credit side)
--   - a payment row with provider='CREDIT' (ledger entry on the
--     invoice side; recompute_invoice_paid is provider-agnostic so
--     these automatically count toward paid_cents).
--
-- Cross-entity application within a firm is allowed: a credit owned
-- by client A can fund an invoice on client B as long as both belong
-- to the same firm. The /credits router enforces firm scope, not
-- client match.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. credit_memo — one row per outstanding credit
-- ---------------------------------------------------------------------
CREATE TABLE credit_memo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES client(id),
  issued_date date NOT NULL,
  original_amount_cents bigint NOT NULL,
  source text NOT NULL,
  reference text,
  notes text,
  status text NOT NULL DEFAULT 'OPEN',
  -- Provenance back-links. Both nullable; only one will be set per row
  -- (or neither, for source='MANUAL').
  source_receipt_id uuid REFERENCES payment_receipt(id) ON DELETE SET NULL,
  source_payment_id uuid REFERENCES payment(id) ON DELETE SET NULL,
  -- Void state
  voided_at timestamptz,
  voided_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  void_reason text,
  -- Provenance
  created_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_memo_amount_positive
    CHECK (original_amount_cents > 0),
  CONSTRAINT credit_memo_source_ck
    CHECK (source IN ('MANUAL', 'OVERPAYMENT', 'REFUND_EXCESS')),
  CONSTRAINT credit_memo_status_ck
    CHECK (status IN ('OPEN', 'PARTIALLY_APPLIED', 'FULLY_APPLIED', 'VOIDED'))
);

CREATE INDEX credit_memo_firm_client_status_idx
  ON credit_memo (firm_id, client_id, status);
CREATE INDEX credit_memo_source_receipt_idx
  ON credit_memo (source_receipt_id)
  WHERE source_receipt_id IS NOT NULL;
CREATE INDEX credit_memo_source_payment_idx
  ON credit_memo (source_payment_id)
  WHERE source_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. credit_application — links a credit_memo to an invoice
-- ---------------------------------------------------------------------
-- payment_id is the sibling provider='CREDIT' payment row that does
-- the invoice-side bookkeeping. RESTRICT delete so void must go
-- through the void endpoint (which flips the payment to REFUNDED).
CREATE TABLE credit_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_memo_id uuid NOT NULL REFERENCES credit_memo(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES invoice(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES payment(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  receipt_id uuid REFERENCES payment_receipt(id) ON DELETE SET NULL,
  voided_at timestamptz,
  voided_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL,

  CONSTRAINT credit_application_amount_positive
    CHECK (amount_cents > 0)
);

CREATE INDEX credit_application_credit_memo_active_idx
  ON credit_application (credit_memo_id)
  WHERE voided_at IS NULL;
CREATE INDEX credit_application_invoice_idx
  ON credit_application (invoice_id);
CREATE INDEX credit_application_receipt_idx
  ON credit_application (receipt_id)
  WHERE receipt_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. Relax provider CHECKs to allow 'CREDIT'
-- ---------------------------------------------------------------------
-- payment_receipt already has a CHECK from 0055 — drop & re-add.
ALTER TABLE payment_receipt DROP CONSTRAINT payment_receipt_provider_ck;
ALTER TABLE payment_receipt
  ADD CONSTRAINT payment_receipt_provider_ck
  CHECK (provider IN ('STRIPE', 'CPACHARGE', 'MANUAL', 'CREDIT'));

-- payment had no CHECK historically (it was a pgEnum until the column
-- was widened to text). Add one now so a future bad provider write
-- fails fast at the DB rather than silently corrupting reconciliation.
ALTER TABLE payment
  ADD CONSTRAINT payment_provider_ck
  CHECK (provider IN ('STRIPE', 'CPACHARGE', 'MANUAL', 'CREDIT'));
