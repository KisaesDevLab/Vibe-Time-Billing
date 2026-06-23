-- =====================================================================
-- Migration: 0180_backup_scheduling.sql
--
-- Configurable appliance backup (Q12 revision). Adds a control plane the
-- Admin → Operations → Backup tab manages; the executor stays in
-- ops/scripts/backup.sh (the only container with pg_dump + the /backups
-- volume), which reads backup_config and writes backup_run.
--
-- backup_config is appliance-global (a single 'default' row) — the dump is
-- whole-database and the app keys are appliance-wide, so this is not
-- firm-scoped (mirrors job_schedule / job_run, 0175).
--
--   * frequency + time_of_day_utc + retention_days  → the schedule
--   * destination_path                              → /backups or an
--                                                     external-drive mount
--   * include_app_keys                              → also bundle the
--                                                     encrypted key archive
--                                                     (KMS_KEY, JWT secrets,
--                                                     DB password) so a
--                                                     restored DB can decrypt
--                                                     its at-rest columns
--   * manual_requested_at                           → set by the API's
--                                                     /backup/trigger; the
--                                                     executor runs once then
--                                                     clears it
--   * last_run_at / last_success_at / last_status   → executor bookkeeping
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.backup_config (
  id                  text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  enabled             boolean NOT NULL DEFAULT true,
  -- daily | every_2_days | weekly
  frequency           text NOT NULL DEFAULT 'daily',
  -- "HH:MM" 24h UTC (the appliance runs UTC).
  time_of_day_utc     text NOT NULL DEFAULT '02:00',
  retention_days      integer NOT NULL DEFAULT 30,
  destination_path    text NOT NULL DEFAULT '/backups',
  include_app_keys    boolean NOT NULL DEFAULT true,
  -- last 14 encrypted key bundles kept (keys change rarely).
  key_bundle_keep     integer NOT NULL DEFAULT 14,
  manual_requested_at timestamptz,
  last_run_at         timestamptz,
  last_success_at     timestamptz,
  -- null | running | completed | failed
  last_status         text,
  last_error          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton so the API/UI always have a row to read + patch.
INSERT INTO vibetb.backup_config (id) VALUES ('default')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS vibetb.backup_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- scheduled | manual
  kind             text NOT NULL,
  -- running | completed | failed
  status           text NOT NULL,
  destination_path text,
  db_file          text,
  db_bytes         bigint,
  -- null when include_app_keys was off; 'skipped:<reason>' on a non-fatal
  -- key-bundle failure (e.g. passphrase not configured).
  keys_file        text,
  keys_bytes       bigint,
  retention_days   integer,
  pruned_count     integer,
  triggered_by     text,
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);

CREATE INDEX IF NOT EXISTS backup_run_started_idx ON vibetb.backup_run (started_at DESC);
