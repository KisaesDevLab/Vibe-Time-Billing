-- 0125_package_price_override.sql
-- Optional flat tier price for packages. When set, it overrides the computed
-- sum-of-included-services price shown in the catalog and the proposal Package
-- block. (Per-tier descriptions reuse the existing packages.description column.)

ALTER TABLE vibetb.packages
  ADD COLUMN IF NOT EXISTS price_override_cents bigint;
