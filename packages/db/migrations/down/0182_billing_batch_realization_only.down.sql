-- Down: 0182_billing_batch_realization_only.sql
ALTER TABLE vibetb.billing_batch DROP COLUMN IF EXISTS realization_only;
