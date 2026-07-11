-- 0207 — pause-and-hold stopwatch timers for time logging. Durable in
-- Postgres (not Redis) because a timer is unbilled revenue: paused timers
-- may live for hours or days and must survive restarts. One RUNNING timer
-- per user (partial unique index); any number PAUSED. Classification
-- (client/engagement/work code) is nullable until save — timers can start
-- blank and be classified while running. Elapsed time is
-- accumulated_seconds plus (now - last_started_at) while RUNNING. On save
-- the timer converts to a normal time_entry through the standard create
-- path and the row is deleted; discard deletes it outright.

CREATE TABLE IF NOT EXISTS vibetb.time_timer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id),
  -- UI hint so a client-page-started timer can filter the engagement
  -- picker before an engagement is chosen; backfilled when engagement set.
  client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  work_code_id uuid REFERENCES vibetb.work_code(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','PAUSED')),
  accumulated_seconds integer NOT NULL DEFAULT 0 CHECK (accumulated_seconds >= 0),
  last_started_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the server auto-pauses a forgotten timer (8h cap); cleared
  -- on resume. Drives the "you left a timer running" prompt.
  auto_paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'RUNNING') = (last_started_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS time_timer_user_idx
  ON vibetb.time_timer (app_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS time_timer_one_running_idx
  ON vibetb.time_timer (app_user_id) WHERE status = 'RUNNING';
