-- =====================================================================
-- Migration: 0050_tier_1_3_sweep.sql
--
-- Tier 1–3 UX/feature sweep. Schema scaffolding for:
--   • client mailing address (structured) + customFields GIN index
--   • time_entry.out_of_scope_override (manual override on top of
--     computed in_scope_flag; preserves Q20 semantics)
--   • billing_batch.kind + retainer target amount
--   • engagement.retainer_locked_at (locks time-entry create/update
--     against an engagement when its retainer is locked)
--   • engagement_assignment join table (multi-staff per engagement,
--     widens "My Work" filter; partner_id/manager_id stay for BC)
--   • engagement_status_config (per-firm × workflow_state config —
--     label, color, sort, kanban visibility, client-comm trigger flag)
--   • invoice_reminder_log (rate-limit manual reminders + audit auto
--     dunning runs)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Client mailing address (structured)
-- ---------------------------------------------------------------------
ALTER TABLE client
  ADD COLUMN mailing_street1 text,
  ADD COLUMN mailing_street2 text,
  ADD COLUMN mailing_city text,
  ADD COLUMN mailing_state text,
  ADD COLUMN mailing_postal text,
  ADD COLUMN mailing_country text;

-- GIN index supports trigram-style search across custom field values.
-- jsonb_path_ops keeps the index small; we use jsonb @? / @@ predicates
-- and string-containment via casting to text in queries.
CREATE INDEX IF NOT EXISTS client_custom_fields_gin
  ON client USING GIN (custom_fields jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 2. Time entry — manual out-of-scope override
-- ---------------------------------------------------------------------
-- Q20 says in_scope_flag is computed at write time from
-- engagement.in_scope_work_code_ids. This override is a user-controlled
-- veto, additive (does not mutate the computed flag). Effective scope
-- in reporting = in_scope_flag AND NOT out_of_scope_override.
ALTER TABLE time_entry
  ADD COLUMN out_of_scope_override boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS time_entry_out_of_scope_idx
  ON time_entry (out_of_scope_override)
  WHERE out_of_scope_override = true;

-- ---------------------------------------------------------------------
-- 3. Billing batch kind + retainer target
-- ---------------------------------------------------------------------
CREATE TYPE billing_batch_kind AS ENUM ('STANDARD', 'RETAINER');

ALTER TABLE billing_batch
  ADD COLUMN kind billing_batch_kind NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN retainer_target_amount_cents bigint;

-- A retainer batch must declare its target. Standard batches must not.
ALTER TABLE billing_batch
  ADD CONSTRAINT billing_batch_retainer_target_present
  CHECK (
    (kind = 'RETAINER' AND retainer_target_amount_cents IS NOT NULL AND retainer_target_amount_cents > 0)
    OR
    (kind = 'STANDARD' AND retainer_target_amount_cents IS NULL)
  );

CREATE INDEX IF NOT EXISTS billing_batch_kind_idx
  ON billing_batch (kind);

-- ---------------------------------------------------------------------
-- 4. Engagement retainer lock
-- ---------------------------------------------------------------------
ALTER TABLE engagement
  ADD COLUMN retainer_locked_at timestamptz;

-- ---------------------------------------------------------------------
-- 5. engagement_assignment — multi-staff-per-engagement join table
-- ---------------------------------------------------------------------
CREATE TYPE engagement_assignment_role AS ENUM (
  'PARTNER',
  'MANAGER',
  'REVIEWER',
  'PREPARER',
  'STAFF'
);

CREATE TABLE engagement_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role engagement_assignment_role NOT NULL DEFAULT 'STAFF',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_id uuid REFERENCES app_user(id)
);

CREATE UNIQUE INDEX engagement_assignment_uk
  ON engagement_assignment (engagement_id, app_user_id, role);

CREATE INDEX engagement_assignment_engagement_idx
  ON engagement_assignment (engagement_id);

-- "My Work" filter joins on app_user_id. Composite with engagement_id
-- for the membership check on a given user across their engagements.
CREATE INDEX engagement_assignment_user_idx
  ON engagement_assignment (app_user_id, engagement_id);

-- ---------------------------------------------------------------------
-- 6. engagement_status_config — per-firm × workflow_state config
-- ---------------------------------------------------------------------
-- Hybrid model: workflow_state stays as a pg enum (type safety + cheap
-- joins); this table layers per-firm presentation + automation flags
-- on top. No insert/delete from the app side — rows are seeded by
-- migration and any future enum additions seed-in via follow-up.
CREATE TABLE engagement_status_config (
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  workflow_state engagement_workflow_state NOT NULL,
  label text NOT NULL,
  color text NOT NULL DEFAULT '#6b7280',
  sort_order integer NOT NULL DEFAULT 0,
  kanban_visible boolean NOT NULL DEFAULT true,
  triggers_client_comm boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (firm_id, workflow_state)
);

CREATE INDEX engagement_status_config_firm_sort_idx
  ON engagement_status_config (firm_id, sort_order);

-- Seed one row per firm × enum value with sane defaults. CANCELED is
-- hidden from kanban by default since it's a terminal state.
INSERT INTO engagement_status_config (firm_id, workflow_state, label, color, sort_order, kanban_visible, triggers_client_comm)
SELECT f.id, v.state, v.label, v.color, v.sort_order, v.kanban_visible, false
FROM firm f
CROSS JOIN (VALUES
  ('NO_STATUS'::engagement_workflow_state,    'No status',    '#6b7280',  0, true),
  ('DRAFT'::engagement_workflow_state,        'Draft',        '#9ca3af', 10, true),
  ('NOT_STARTED'::engagement_workflow_state,  'Not started',  '#94a3b8', 20, true),
  ('READY'::engagement_workflow_state,        'Ready',        '#3b82f6', 30, true),
  ('IN_PROGRESS'::engagement_workflow_state,  'In progress',  '#10b981', 40, true),
  ('NEEDS_REVIEW'::engagement_workflow_state, 'Needs review', '#8b5cf6', 50, true),
  ('WITH_CLIENT'::engagement_workflow_state,  'With client',  '#06b6d4', 60, true),
  ('ON_HOLD'::engagement_workflow_state,      'On hold',      '#f59e0b', 70, true),
  ('COMPLETED'::engagement_workflow_state,    'Completed',    '#22c55e', 80, true),
  ('CANCELED'::engagement_workflow_state,     'Canceled',     '#ef4444', 90, false)
) AS v(state, label, color, sort_order, kanban_visible);

-- ---------------------------------------------------------------------
-- 7. invoice_reminder_log — manual reminder rate-limit + audit auto-runs
-- ---------------------------------------------------------------------
CREATE TYPE invoice_reminder_kind AS ENUM ('AUTO', 'MANUAL');

CREATE TABLE invoice_reminder_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  actor_app_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  kind invoice_reminder_kind NOT NULL,
  template text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Cooldown query reads the most recent row per invoice. Composite index
-- on (invoice_id, sent_at desc) makes the lookup index-only.
CREATE INDEX invoice_reminder_log_invoice_sent_idx
  ON invoice_reminder_log (invoice_id, sent_at DESC);
