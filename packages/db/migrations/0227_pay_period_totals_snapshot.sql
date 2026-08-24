-- 0227 — snapshot per-employee payroll totals at period lock. The review
-- and payroll exports for a LOCKED period are served from this snapshot,
-- so later changes to work-code payroll categories, exempt/full-time
-- flags, standard hours, or the workweek setting can no longer rewrite a
-- period that was already approved and paid. Re-locking overwrites the
-- snapshot; OPEN periods keep computing live.

ALTER TABLE vibetb.pay_period_employee
  ADD COLUMN IF NOT EXISTS totals_snapshot jsonb;
