-- 0202 — firm-level estimated labor percentage. Used when a recurring
-- engagement rolls forward: the spawned engagement's budgeted fee is derived
-- from the prior engagement's cost of labor divided by this percentage
-- (labor is assumed to be estimated_labor_pct% of the target fee). Default 40.
ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS estimated_labor_pct integer NOT NULL DEFAULT 40;
