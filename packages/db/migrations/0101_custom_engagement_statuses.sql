-- =====================================================================
-- Migration: 0101_custom_engagement_statuses.sql
--
-- Make engagement "progress status" (workflow_state) an UNLIMITED,
-- firm-editable catalog with client-facing text.
--
--  * Relax workflow_state from the engagement_workflow_state ENUM to
--    plain text on both engagement and engagement_status_config, then
--    drop the now-unused type.
--  * engagement_status_config gains is_system + client_label /
--    client_description / client_visible.
--  * Mark the 10 originals is_system, and backfill them for every firm
--    so the catalog is complete (generalizes the prior GET self-heal).
--
-- No DB FK from engagement.workflow_state: the engagement table has no
-- firm_id column (it scopes via client_id -> client.firm_id), so a
-- composite (firm_id, workflow_state) FK isn't available. Validity on
-- set and the in-use guard on delete are enforced in the API layer
-- (firm resolved from the session).
-- =====================================================================

-- 1. Relax the enum columns to text.
ALTER TABLE vibetb.engagement ALTER COLUMN workflow_state DROP DEFAULT;
ALTER TABLE vibetb.engagement
  ALTER COLUMN workflow_state TYPE text USING workflow_state::text;
ALTER TABLE vibetb.engagement ALTER COLUMN workflow_state SET DEFAULT 'NO_STATUS';

ALTER TABLE vibetb.engagement_status_config
  ALTER COLUMN workflow_state TYPE text USING workflow_state::text;

-- 2. Drop the now-unused enum type (both columns are text now).
DROP TYPE IF EXISTS engagement_workflow_state;

-- 3. New catalog columns.
ALTER TABLE vibetb.engagement_status_config
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_label text,
  ADD COLUMN IF NOT EXISTS client_description text,
  ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT true;

-- 4. Everything that exists now is a built-in.
UPDATE vibetb.engagement_status_config SET is_system = true;

-- 5. Backfill the 10 built-ins for every firm missing any of them.
INSERT INTO vibetb.engagement_status_config
  (firm_id, workflow_state, label, color, sort_order, kanban_visible,
   triggers_client_comm, is_system, client_visible)
SELECT f.id, v.ws, v.label, v.color, v.sort_order, true, false, true, true
FROM vibetb.firm f
CROSS JOIN (VALUES
  ('DRAFT',        'Draft',        '#9ca3af',  0),
  ('NOT_STARTED',  'Not started',  '#6b7280', 10),
  ('READY',        'Ready',        '#3b82f6', 20),
  ('IN_PROGRESS',  'In progress',  '#f59e0b', 30),
  ('ON_HOLD',      'On hold',      '#a855f7', 40),
  ('NEEDS_REVIEW', 'Needs review', '#ec4899', 50),
  ('WITH_CLIENT',  'With client',  '#0ea5e9', 60),
  ('COMPLETED',    'Completed',    '#22c55e', 70),
  ('CANCELED',     'Canceled',     '#737373', 80),
  ('NO_STATUS',    'No status',    '#94a3b8', 90)
) AS v(ws, label, color, sort_order)
ON CONFLICT (firm_id, workflow_state) DO NOTHING;
