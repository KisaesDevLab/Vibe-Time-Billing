-- 0134 — link tax payments to a tax return.
--
-- Lets staff create the estimated-payment vouchers / balance-due
-- payments associated with a specific return from the return detail
-- page, and list them back on the return. Nullable + ON DELETE SET NULL
-- so deleting a return (guarded hard delete) detaches its payments
-- rather than cascading them away.
--
-- Note: the table is vibetb.tax_payment (singular); tax_returns lives in
-- the same schema after 0057's public→vibetb rename.

ALTER TABLE vibetb.tax_payment
  ADD COLUMN tax_return_id uuid REFERENCES vibetb.tax_returns(id) ON DELETE SET NULL;

CREATE INDEX tax_payment_return_idx
  ON vibetb.tax_payment (tax_return_id)
  WHERE tax_return_id IS NOT NULL;
