-- =====================================================================
-- Migration: 0039_engagement_workflow.sql
--
-- v2 Part 2 — operational workflow state + priority on engagements, to
-- back the new top-level /engagements list view (Canopy "Tasks"-style).
--
-- The existing `status` enum (PROPOSED/ACTIVE/PAUSED/CLOSED/ARCHIVED) is
-- billing-relevant and stays. The new `workflow_state` is operational:
-- where this engagement sits in the staff's day-to-day workflow.
--
-- Priority is a separate axis: how urgent is this engagement.
--
-- Backfill: map existing lifecycle status → reasonable workflow state.
-- Existing engagements with no explicit workflow_state get sensible
-- defaults so the list view isn't full of "No status" rows on first run.
-- =====================================================================

CREATE TYPE engagement_workflow_state AS ENUM (
  'NO_STATUS',
  'NOT_STARTED',
  'READY',
  'IN_PROGRESS',
  'ON_HOLD',
  'NEEDS_REVIEW',
  'WITH_CLIENT',
  'COMPLETED',
  'CANCELED',
  'DRAFT'
);

CREATE TYPE engagement_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

ALTER TABLE engagement
  ADD COLUMN workflow_state engagement_workflow_state NOT NULL DEFAULT 'NO_STATUS',
  ADD COLUMN priority engagement_priority NOT NULL DEFAULT 'MEDIUM';

-- Backfill workflow_state from lifecycle status.
UPDATE engagement SET workflow_state = 'IN_PROGRESS' WHERE status = 'ACTIVE';
UPDATE engagement SET workflow_state = 'NOT_STARTED' WHERE status = 'PROPOSED';
UPDATE engagement SET workflow_state = 'ON_HOLD'     WHERE status = 'PAUSED';
UPDATE engagement SET workflow_state = 'COMPLETED'   WHERE status = 'CLOSED';
UPDATE engagement SET workflow_state = 'CANCELED'    WHERE status = 'ARCHIVED';

CREATE INDEX IF NOT EXISTS engagement_workflow_state_idx
  ON engagement (workflow_state);

-- For the "My Work" sub-tab, partner + manager are the two assignee
-- vectors. A composite index on each makes the OR-of-two query cheap.
CREATE INDEX IF NOT EXISTS engagement_partner_workflow_idx
  ON engagement (partner_id, workflow_state)
  WHERE partner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS engagement_manager_workflow_idx
  ON engagement (manager_id, workflow_state)
  WHERE manager_id IS NOT NULL;
