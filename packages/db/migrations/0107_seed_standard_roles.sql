-- =====================================================================
-- Migration: 0107_seed_standard_roles.sql
--
-- RBAC enforcement maps a user's role NAME to one of the five built-in
-- templates (admin/partner/manager/senior/staff → permission set). Early
-- appliances were bootstrapped with only the 'admin' role row, leaving the
-- other four un-assignable — so any non-admin staff ended up with zero
-- permissions ("forbidden" everywhere). Seed the four standard roles for
-- every firm that is missing them (idempotent; matched case-insensitively).
-- =====================================================================

INSERT INTO vibetb.role (firm_id, name, system_flag)
SELECT f.id, v.name, true
FROM vibetb.firm f
CROSS JOIN (VALUES ('partner'), ('manager'), ('senior'), ('staff')) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM vibetb.role r
  WHERE r.firm_id = f.id AND lower(r.name) = v.name
);
