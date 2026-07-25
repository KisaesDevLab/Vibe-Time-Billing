-- =====================================================================
-- Migration: 0001_audit_log_immutability.sql
--
-- Enforce audit log immutability at the database role level.
--
-- The app role (used by api and worker processes) has INSERT and SELECT
-- privileges on audit_log but NOT UPDATE or DELETE. This means even if
-- application code has a bug that tries to mutate an audit row, Postgres
-- refuses.
--
-- This is one of the non-negotiable invariants from CLAUDE.md:
--   "Audit log immutability: app role has no UPDATE/DELETE on audit_log;
--    every mutation creates a row"
--
-- Apply after the audit_log table is created (per BUILD_PLAN.md Phase 2).
-- =====================================================================

-- The app role is created at appliance bootstrap. If you change the role
-- name, update this migration accordingly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vibe_app') THEN
    CREATE ROLE vibe_app NOLOGIN;
  END IF;
END
$$;

-- Grant minimum privileges
REVOKE ALL ON audit_log FROM vibe_app;
GRANT INSERT, SELECT ON audit_log TO vibe_app;
-- Explicitly do NOT grant UPDATE, DELETE, TRUNCATE

-- Same for the time_entry_version append-only history table
REVOKE ALL ON time_entry_version FROM vibe_app;
GRANT INSERT, SELECT ON time_entry_version TO vibe_app;

-- =====================================================================
-- TRIGGER: prevent app role from somehow circumventing via direct SQL
-- (belt and suspenders — REVOKE alone should suffice, but this catches
-- bugs in privilege grants on future schema changes).
-- =====================================================================

CREATE OR REPLACE FUNCTION audit_log_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable — UPDATE/DELETE blocked'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE OR REPLACE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE OR REPLACE TRIGGER time_entry_version_no_update
  BEFORE UPDATE ON time_entry_version
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

CREATE OR REPLACE TRIGGER time_entry_version_no_delete
  BEFORE DELETE ON time_entry_version
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- =====================================================================
-- Notes for operators:
--
-- - The vibe_app role is used by the api/worker connection pool.
-- - A separate vibe_admin role (with full privileges) exists for migrations
--   and ops. Migration scripts run as vibe_admin; runtime code runs as
--   vibe_app.
-- - To purge audit_log for retention (per QUESTIONS.md Q11/Phase 19), use a
--   privileged maintenance script that connects as vibe_admin. The app
--   role can never do this.
-- =====================================================================
