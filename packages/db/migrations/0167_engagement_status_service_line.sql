-- =====================================================================
-- Migration: 0167_engagement_status_service_line.sql
--
-- Maps a firm's engagement workflow statuses to the service lines they
-- apply to. A status with zero rows here is unrestricted (offered for
-- every engagement); rows restrict it to only the listed service lines.
-- Mirrors the existing work_code -> service_line scoping pattern. No
-- backfill: empty mappings reproduce today's "all statuses everywhere"
-- behavior.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.engagement_status_service_line (
  firm_id         uuid NOT NULL REFERENCES vibetb.firm (id) ON DELETE CASCADE,
  workflow_state  text NOT NULL,
  service_line_id uuid NOT NULL REFERENCES vibetb.service_line (id) ON DELETE CASCADE,
  PRIMARY KEY (firm_id, workflow_state, service_line_id),
  FOREIGN KEY (firm_id, workflow_state)
    REFERENCES vibetb.engagement_status_config (firm_id, workflow_state) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS engagement_status_service_line_sl_idx
  ON vibetb.engagement_status_service_line (firm_id, service_line_id);
