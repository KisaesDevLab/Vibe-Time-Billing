-- =====================================================================
-- Migration: 0147_role_permission_override.sql
--
-- Firm-editable permission matrix. Role templates remain the code-level
-- baseline (@vibe/core/rbac); this table stores per-firm deltas toggled
-- from Admin → Permission matrix: granted=true adds a key the template
-- lacks, granted=false revokes one it has. requirePermission merges the
-- deltas at request time. The admin role is never overridable — it
-- always holds every key (lockout guard: matrix edits themselves
-- require firm:settings:write, which only admin templates grant).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare IF NOT EXISTS only. Migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.role_permission_override (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  -- 'partner' | 'manager' | 'senior' | 'staff' (admin excluded by CHECK)
  role_slug       text NOT NULL,
  permission_key  text NOT NULL,
  granted         boolean NOT NULL,
  updated_by      uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permission_override_role_ck
    CHECK (role_slug IN ('partner', 'manager', 'senior', 'staff'))
);

CREATE UNIQUE INDEX IF NOT EXISTS role_permission_override_uk
  ON vibetb.role_permission_override (firm_id, role_slug, permission_key);
CREATE INDEX IF NOT EXISTS role_permission_override_firm_idx
  ON vibetb.role_permission_override (firm_id);
