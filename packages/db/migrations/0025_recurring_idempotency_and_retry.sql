-- =====================================================================
-- Migration: 0025_recurring_idempotency_and_retry.sql
--
-- Phase 10 #35 — explicit idempotency key on billing_batch. The unique
-- (engagement_id, period_start) index was already the dedup boundary
-- for recurring ticks, but it doesn't survive being re-keyed (e.g.
-- when the recurring scheduler fires twice within the same second on
-- a clock skew). idempotency_key is a deterministic
-- 'recurring:<plan_id>:<period_start>' string and a UNIQUE constraint
-- makes double-runs a true no-op.
--
-- Phase 10 #28 — scheduled retry on failed autopay. payments grows
-- retry_count + next_retry_at columns. The payment-retry worker reads
-- these and attempts the charge on day 3, day 7, day 14 after the
-- first failure (configurable). Auto-pause threshold on
-- recurring_billing_plan still kicks in if all retries fail.
-- =====================================================================

ALTER TABLE billing_batch
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS billing_batch_idempotency_key_uk
  ON billing_batch (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS payment_retry_idx
  ON payment (status, next_retry_at)
  WHERE status = 'FAILED' AND next_retry_at IS NOT NULL;

-- Phase 13 #6 — firm-style invoice template picker. Three variants
-- ship: 'modern' (default), 'classic', 'minimal'. CHECK constrains
-- the column to those values.
ALTER TABLE firm_settings
  ADD COLUMN IF NOT EXISTS invoice_template_style TEXT NOT NULL DEFAULT 'modern';

ALTER TABLE firm_settings
  ADD CONSTRAINT firm_settings_invoice_template_style_chk
    CHECK (invoice_template_style IN ('modern', 'classic', 'minimal'));
