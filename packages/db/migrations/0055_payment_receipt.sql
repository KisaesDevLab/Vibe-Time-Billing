-- =====================================================================
-- Migration: 0055_payment_receipt.sql
--
-- Receive-Payment feature. Introduces payment_receipt as the parent row
-- for the N payment rows that come from a single "receive" operation
-- (one check or card charge applied across multiple invoices, possibly
-- across multiple client entities owned by the same payer).
--
-- Existing payment rows stay one-per-invoice. The new receipt_id FK
-- links them; for legacy /payments/auto-apply payments the FK is NULL.
--
-- Also adds a CHECK on invoice.paid_cents <= total_cents as a backstop
-- against concurrent receives racing on the same invoice (the route
-- transactions use SELECT FOR UPDATE; this is belt-and-suspenders).
-- =====================================================================

-- ---------------------------------------------------------------------
-- payment_receipt
-- ---------------------------------------------------------------------
-- mode = 'RECORD' | 'CHARGE'
-- provider mirrors payment.provider: 'STRIPE' | 'CPACHARGE' | 'MANUAL'
-- status = 'PENDING' (charge in flight) | 'SUCCEEDED' | 'FAILED' | 'VOIDED'
-- allocations_pending is set only while status='PENDING' (Stripe in
-- flight); the webhook materializes payment rows from this on success.
CREATE TABLE payment_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  payer_client_id uuid NOT NULL REFERENCES client(id),
  payment_date date NOT NULL,
  reference text,
  payment_method text NOT NULL,
  mode text NOT NULL,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  provider text NOT NULL,
  provider_charge_id text,
  status text NOT NULL DEFAULT 'PENDING',
  allocations_pending jsonb,
  created_by_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_receipt_mode_ck
    CHECK (mode IN ('RECORD', 'CHARGE')),
  CONSTRAINT payment_receipt_status_ck
    CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'VOIDED')),
  CONSTRAINT payment_receipt_provider_ck
    CHECK (provider IN ('STRIPE', 'CPACHARGE', 'MANUAL'))
);

CREATE INDEX payment_receipt_firm_date_idx
  ON payment_receipt (firm_id, payment_date DESC);
CREATE INDEX payment_receipt_payer_idx
  ON payment_receipt (payer_client_id, payment_date DESC);
CREATE INDEX payment_receipt_provider_charge_idx
  ON payment_receipt (provider_charge_id)
  WHERE provider_charge_id IS NOT NULL;
CREATE INDEX payment_receipt_status_idx
  ON payment_receipt (status)
  WHERE status = 'PENDING';

-- ---------------------------------------------------------------------
-- payment.receipt_id — nullable FK. Legacy rows (auto-apply) stay NULL.
-- ---------------------------------------------------------------------
ALTER TABLE payment
  ADD COLUMN receipt_id uuid REFERENCES payment_receipt(id) ON DELETE SET NULL;

CREATE INDEX payment_receipt_idx ON payment (receipt_id) WHERE receipt_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- invoice.paid_cents bounded by total_cents — concurrency backstop.
-- ---------------------------------------------------------------------
ALTER TABLE invoice
  ADD CONSTRAINT invoice_paid_within_total
  CHECK (paid_cents <= total_cents);
