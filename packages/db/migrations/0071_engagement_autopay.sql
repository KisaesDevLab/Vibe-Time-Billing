-- =====================================================================
-- Migration: 0071_engagement_autopay.sql  (Stage CP9)
--
-- Per-engagement autopay control (Build Plan §2.2).
--
-- Until now autopay was a single flag on recurring_billing_plan. Clients
-- want finer control — autopay the bookkeeping engagement, but manually
-- review the one-off advisory engagement. These columns let a client
-- override the plan-level autopay on a per-engagement basis from the
-- portal, AND pause autopay temporarily without blowing away the
-- configuration.
--
-- Resolution order in recurring-billing:
--   1. engagement.autopay_method_id  (if set) — use it
--      AND engagement.autopay_paused_until IS NULL OR < today
--   2. recurring_billing_plan.auto_pay_payment_method_id (legacy
--      plan-level autopay)
--   3. Else skip — portal shows the unpaid invoice
-- =====================================================================

ALTER TABLE vibetb.engagement
  ADD COLUMN IF NOT EXISTS autopay_method_id uuid REFERENCES vibetb.payment_method(id)
    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS autopay_paused_until date;

CREATE INDEX IF NOT EXISTS engagement_autopay_method_idx
  ON vibetb.engagement (autopay_method_id)
  WHERE autopay_method_id IS NOT NULL;
