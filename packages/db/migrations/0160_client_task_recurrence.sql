-- =====================================================================
-- Migration: 0160_client_task_recurrence.sql
--
-- Recurring tasks. A task may carry a recurrence cadence; completing it opens
-- a fresh copy with the next due date (handled inline in the task PATCH
-- handlers). NULL recurrence = a one-off task (the default).
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. The migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TYPE vibetb.client_task_recurrence AS ENUM (
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL'
);

ALTER TABLE vibetb.client_task
  ADD COLUMN IF NOT EXISTS recurrence vibetb.client_task_recurrence;
