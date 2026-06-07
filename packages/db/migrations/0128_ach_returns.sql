-- 0128_ach_returns.sql
-- ACH return / late-failure dispute ledger (Phase 22). Drives mandate
-- invalidation, payment-method blocking, and dunning-halt decisions.

CREATE TABLE IF NOT EXISTS vibetb.ach_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES vibetb.payment(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES vibetb.invoice(id) ON DELETE SET NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_payment_method_id text,
  return_code text NOT NULL,
  category text NOT NULL,
  retriable boolean NOT NULL DEFAULT false,
  invalidated_mandate boolean NOT NULL DEFAULT false,
  blocked_payment_method boolean NOT NULL DEFAULT false,
  amount_cents bigint NOT NULL DEFAULT 0,
  fee_cents bigint NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'failure',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ach_returns_firm_idx ON vibetb.ach_returns (firm_id, created_at);
CREATE INDEX IF NOT EXISTS ach_returns_pi_idx ON vibetb.ach_returns (stripe_payment_intent_id);
