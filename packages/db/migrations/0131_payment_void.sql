-- 0131_payment_void.sql
-- Void of a manually-recorded payment: keep the row for audit, but exclude it
-- from paid recompute + listing totals.

ALTER TABLE vibetb.payment
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason text;
