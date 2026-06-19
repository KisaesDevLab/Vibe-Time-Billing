-- =====================================================================
-- Migration: 0175_job_admin.sql
--
-- Background-job admin: enable/disable + run history. Appliance-global
-- (jobs aren't firm-scoped). The worker writes a job_run row per
-- execution and skips a job whose job_schedule.enabled = false.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.job_schedule (
  job_name      text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT true,
  cron_override text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vibetb.job_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     text NOT NULL,
  status       text NOT NULL,
  item_count   integer,
  error        text,
  triggered_by text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS job_run_job_idx ON vibetb.job_run (job_name, started_at);
