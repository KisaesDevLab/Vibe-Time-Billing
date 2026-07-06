-- =====================================================================
-- Migration: 0192_client_payment_plan.sql
--
-- Staff-managed recurring installment plan that charges a client's saved
-- payment method a fixed amount each cycle and applies it to the client's
-- open invoices (oldest-first) until the balance is cleared. Charging +
-- settlement reuse the off-session charge service + the Stripe webhook
-- ledger; this table is just the schedule.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.client_payment_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  payment_method_id uuid NOT NULL REFERENCES vibetb.payment_method(id) ON DELETE RESTRICT,
  frequency text NOT NULL,
  next_run_date date NOT NULL,
  installment_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  consecutive_failure_count integer NOT NULL DEFAULT 0,
  pause_threshold integer NOT NULL DEFAULT 3,
  paused_reason text,
  authorized_by_app_user_id uuid,
  authorized_at timestamptz,
  authorization_note text,
  last_run_at timestamptz,
  next_retry_at timestamptz,
  notes text,
  created_by_app_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_payment_plan_status_ck
    CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT client_payment_plan_frequency_ck
    CHECK (frequency IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL')),
  CONSTRAINT client_payment_plan_installment_ck CHECK (installment_cents > 0)
);

CREATE INDEX IF NOT EXISTS client_payment_plan_due_idx
  ON vibetb.client_payment_plan (status, next_run_date);
CREATE INDEX IF NOT EXISTS client_payment_plan_firm_client_idx
  ON vibetb.client_payment_plan (firm_id, client_id);
