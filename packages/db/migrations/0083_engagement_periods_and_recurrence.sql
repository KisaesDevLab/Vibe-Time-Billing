-- =====================================================================
-- Migration: 0083_engagement_periods_and_recurrence.sql
--
-- Two related capabilities:
--
-- A. Template name patterns + period fields on engagement
--    - engagement_template.name_pattern — Mustache-style template
--      resolved at engagement-creation time using {{client.name}},
--      {{period.year/month/label}}, {{today}}, {{engagement.*}} tokens.
--      NULL = use the static `name` field as before (backward-compat).
--    - engagement.period_year / period_month / period_label — three
--      optional inputs captured at creation time so a single "Monthly
--      Bookkeeping" template can spawn "Bookkeeping 4/2026", etc.
--
-- B. engagement_recurrence table — subscribes a (client × template)
--    pair to a cadence. Worker spawns the next engagement either on a
--    schedule (next_run_date <= today) or when the previous one
--    completes. Collision case (previous still ACTIVE) routes through
--    the approval queue per Q23.
-- =====================================================================

-- --- (A) name_pattern + period fields -----------------------------------

ALTER TABLE vibetb.engagement_template
  ADD COLUMN IF NOT EXISTS name_pattern text;

ALTER TABLE vibetb.engagement
  ADD COLUMN IF NOT EXISTS period_year integer,
  ADD COLUMN IF NOT EXISTS period_month smallint,
  ADD COLUMN IF NOT EXISTS period_label text;

ALTER TABLE vibetb.engagement
  ADD CONSTRAINT engagement_period_month_range_ck
  CHECK (period_month IS NULL OR (period_month BETWEEN 1 AND 12));

-- --- (B) engagement_recurrence ------------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.engagement_recurrence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id              uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id            uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  template_id          uuid NOT NULL REFERENCES vibetb.engagement_template(id)
                         ON DELETE RESTRICT,
  frequency            recurring_frequency NOT NULL,
  trigger_mode         text NOT NULL,
  next_run_date        date,
  -- Seed period for the FIRST run. After the first spawn the worker
  -- derives the next period from last_engagement.period_year/month
  -- via advancePeriod(). Free-text label always re-uses the seed
  -- value (the user can edit on the engagement after spawn).
  seed_period_year     integer,
  seed_period_month    smallint,
  seed_period_label    text,
  last_engagement_id   uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  last_run_at          timestamptz,
  status               text NOT NULL DEFAULT 'ACTIVE',
  notes                text,
  created_by_id        uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_recurrence_trigger_mode_ck
    CHECK (trigger_mode IN ('SCHEDULE', 'ON_COMPLETION')),
  CONSTRAINT engagement_recurrence_status_ck
    CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  CONSTRAINT engagement_recurrence_schedule_has_date_ck
    CHECK ((trigger_mode = 'SCHEDULE') = (next_run_date IS NOT NULL)),
  CONSTRAINT engagement_recurrence_seed_month_range_ck
    CHECK (seed_period_month IS NULL OR (seed_period_month BETWEEN 1 AND 12))
);

CREATE INDEX IF NOT EXISTS engagement_recurrence_firm_status_idx
  ON vibetb.engagement_recurrence (firm_id, status);

-- Worker hot path 1: scheduled recurrences due to fire.
CREATE INDEX IF NOT EXISTS engagement_recurrence_next_run_idx
  ON vibetb.engagement_recurrence (next_run_date)
  WHERE status = 'ACTIVE' AND trigger_mode = 'SCHEDULE';

-- Worker hot path 2: completion-triggered recurrences waiting on a
-- previous engagement's close.
CREATE INDEX IF NOT EXISTS engagement_recurrence_completion_idx
  ON vibetb.engagement_recurrence (last_engagement_id)
  WHERE status = 'ACTIVE' AND trigger_mode = 'ON_COMPLETION';

CREATE INDEX IF NOT EXISTS engagement_recurrence_client_idx
  ON vibetb.engagement_recurrence (client_id);
