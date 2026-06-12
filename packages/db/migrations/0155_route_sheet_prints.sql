-- =====================================================================
-- Migration: 0155_route_sheet_prints.sql
--
-- Route Sheet printing: staff print a "File Routing Sheet" for a client
-- from the client list. Each print records who/when/note and, per
-- selected engagement, the workflow-state change (before/after) plus a
-- JSON snapshot of the rendered payload so a reprint is faithful even
-- after the engagement moves on. One parent row per print; one item row
-- per engagement on the sheet.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.route_sheet_print (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  created_by_app_user_id uuid REFERENCES vibetb.app_user(id),
  note text,
  printed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS route_sheet_print_firm_client_idx
  ON vibetb.route_sheet_print (firm_id, client_id, printed_at DESC);

CREATE TABLE IF NOT EXISTS vibetb.route_sheet_print_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_sheet_print_id uuid NOT NULL REFERENCES vibetb.route_sheet_print(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id) ON DELETE CASCADE,
  workflow_state_before text,
  workflow_state_after text,
  snapshot_json jsonb
);

CREATE INDEX IF NOT EXISTS route_sheet_print_item_print_idx
  ON vibetb.route_sheet_print_item (route_sheet_print_id);
