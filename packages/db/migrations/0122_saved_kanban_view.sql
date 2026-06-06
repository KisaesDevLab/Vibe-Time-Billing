-- 0122_saved_kanban_view.sql
-- Per-user named "column views" for the engagements kanban board. Each row
-- is one staff user's saved set of visible status columns for a board type.
-- Mirrors saved_report (per-user, named, JSON config), but private only —
-- no shared_flag. visible_columns is an ordered array of workflow_state keys.

CREATE TABLE IF NOT EXISTS vibetb.saved_kanban_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  name text NOT NULL,
  board_type text NOT NULL DEFAULT 'engagement',
  visible_columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_kanban_view_owner_idx
  ON vibetb.saved_kanban_view (owner_id, board_type);

CREATE UNIQUE INDEX IF NOT EXISTS saved_kanban_view_owner_board_name_uk
  ON vibetb.saved_kanban_view (owner_id, board_type, name);
