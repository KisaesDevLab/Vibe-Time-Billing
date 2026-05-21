-- =====================================================================
-- Migration: 0028_client_task.sql
--
-- v2 Sprint C — per-client task list (workstream 1.3). Modeled after
-- Canopy's Tasks tab on the client detail page. A task is firm-internal
-- (CPA assigns work to themselves or staff) and optionally engagement-
-- scoped. Status enum mirrors the typical workflow stages, priority
-- gives admins a sort key, dueDate drives reminders.
--
-- Indexes:
--   (clientId, status) — Home tab "active tasks" card
--   (assigneeUserId, status, dueDate) — "My tasks" view (future)
--   (firmId, dueDate) — overdue reporting
-- =====================================================================

CREATE TYPE client_task_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE client_task_status AS ENUM (
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'CANCELED'
);

CREATE TABLE IF NOT EXISTS client_task (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  engagement_id UUID REFERENCES engagement(id) ON DELETE SET NULL,
  assignee_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority client_task_priority NOT NULL DEFAULT 'MEDIUM',
  status client_task_status NOT NULL DEFAULT 'OPEN',
  due_date DATE,
  created_by_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS client_task_client_status_idx
  ON client_task (client_id, status);
CREATE INDEX IF NOT EXISTS client_task_assignee_idx
  ON client_task (assignee_user_id, status, due_date)
  WHERE status NOT IN ('DONE', 'CANCELED');
CREATE INDEX IF NOT EXISTS client_task_due_idx
  ON client_task (firm_id, due_date)
  WHERE due_date IS NOT NULL AND status NOT IN ('DONE', 'CANCELED');
