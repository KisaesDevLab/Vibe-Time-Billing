-- =====================================================================
-- Migration: 0054_rate_codes_and_staff_profile.sql
--
-- Introduces firm-scoped rate codes and replaces the flat
-- timekeeper_rate table with effective-dated per-staff snapshots that
-- carry one billing rate per code (plus a single cost rate).
--
-- Resolution chain after this migration:
--   engagement_rate_override → client_rate_override → service_line_rate
--     → staff_rate_snapshot row for engagement.default_rate_code_id
--     → staff_rate_snapshot row for the firm's "StandardRate" code
--     → 0
--
-- Also widens app_user with structured profile fields (Main +
-- Contact Info tabs from the legacy CCH-style staff record).
--
-- Engagement-letter / engagement starter templates can declare a
-- default_rate_code_id; engagements inherit from the template at
-- create time and may be overridden per engagement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. rate_code — firm-scoped catalog
-- ---------------------------------------------------------------------
CREATE TABLE rate_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firm(id) ON DELETE CASCADE,
  code text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  -- StandardRate (and any future seeded codes) are system rows: the API
  -- refuses to delete them and refuses to rename the `code` column.
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rate_code_firm_code_uk ON rate_code (firm_id, code);
CREATE INDEX rate_code_firm_active_idx ON rate_code (firm_id, active);

-- Seed "StandardRate" for every existing firm. This is the resolver's
-- terminal fallback — every staff snapshot must have an entry here.
INSERT INTO rate_code (firm_id, code, description, sort_order, is_system)
SELECT id, 'StandardRate', 'Default billing rate', 0, true FROM firm;

-- ---------------------------------------------------------------------
-- 2. staff_rate_snapshot — one effective_date row per staff
-- ---------------------------------------------------------------------
CREATE TABLE staff_rate_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  effective_date date NOT NULL,
  cost_rate_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One snapshot per (staff, effective_date). Updating an existing
-- effective period is forbidden by the API (append-only); inserting a
-- new effective period creates a fresh snapshot row.
CREATE UNIQUE INDEX staff_rate_snapshot_user_date_uk
  ON staff_rate_snapshot (app_user_id, effective_date);
CREATE INDEX staff_rate_snapshot_user_idx
  ON staff_rate_snapshot (app_user_id, effective_date DESC);

-- ---------------------------------------------------------------------
-- 3. staff_rate_snapshot_entry — (snapshot × rate_code) → bill rate
-- ---------------------------------------------------------------------
CREATE TABLE staff_rate_snapshot_entry (
  snapshot_id uuid NOT NULL REFERENCES staff_rate_snapshot(id) ON DELETE CASCADE,
  rate_code_id uuid NOT NULL REFERENCES rate_code(id) ON DELETE RESTRICT,
  bill_rate_cents bigint NOT NULL,
  PRIMARY KEY (snapshot_id, rate_code_id),
  CHECK (bill_rate_cents >= 0)
);

CREATE INDEX staff_rate_snapshot_entry_code_idx
  ON staff_rate_snapshot_entry (rate_code_id);

-- ---------------------------------------------------------------------
-- 4. Migrate timekeeper_rate → snapshots (one StandardRate entry per row)
-- ---------------------------------------------------------------------
-- Insert a snapshot for every existing timekeeper_rate row, preserving
-- the effective_start as the snapshot's effective_date and copying the
-- cost rate verbatim. Rate-resolution-by-date still works because
-- snapshots are sorted by effective_date desc at query time.
WITH migrated AS (
  INSERT INTO staff_rate_snapshot (id, app_user_id, effective_date, cost_rate_cents, created_at)
  SELECT
    tr.id,
    tr.app_user_id,
    tr.effective_start,
    tr.cost_rate_cents,
    tr.created_at
  FROM timekeeper_rate tr
  RETURNING id, app_user_id
)
INSERT INTO staff_rate_snapshot_entry (snapshot_id, rate_code_id, bill_rate_cents)
SELECT
  m.id,
  rc.id,
  tr.bill_rate_cents
FROM migrated m
JOIN timekeeper_rate tr ON tr.id = m.id
JOIN app_user au ON au.id = m.app_user_id
JOIN rate_code rc ON rc.firm_id = au.firm_id AND rc.code = 'StandardRate';

-- ---------------------------------------------------------------------
-- 5. Recreate profitability_view (it joins timekeeper_rate), then drop
--    the old table. New view loads cost rate from the most recent
--    snapshot whose effective_date <= entry_date.
-- ---------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS profitability_view;

DROP TABLE timekeeper_rate;

CREATE MATERIALIZED VIEW profitability_view AS
SELECT
  c.firm_id                                                AS firm_id,
  e.id                                                     AS engagement_id,
  e.client_id                                              AS client_id,
  COALESCE(SUM(inv.total_cents), 0)::BIGINT                AS billed_cents,
  COALESCE(
    SUM(te.hours::numeric * COALESCE(tk_cost.cost_rate_cents, 0)),
    0
  )::NUMERIC                                               AS loaded_cost_cents,
  COALESCE(SUM(inv.total_cents), 0)::NUMERIC
    - COALESCE(
        SUM(te.hours::numeric * COALESCE(tk_cost.cost_rate_cents, 0)),
        0
      )::NUMERIC                                           AS profit_cents
FROM engagement e
JOIN client c          ON c.id = e.client_id
LEFT JOIN invoice inv  ON inv.primary_engagement_id = e.id AND inv.status IN ('SENT','PARTIALLY_PAID','PAID')
LEFT JOIN time_entry te ON te.engagement_id = e.id
LEFT JOIN LATERAL (
  SELECT srs.cost_rate_cents
    FROM staff_rate_snapshot srs
   WHERE srs.app_user_id = te.app_user_id
     AND srs.effective_date <= te.entry_date
   ORDER BY srs.effective_date DESC
   LIMIT 1
) tk_cost ON true
GROUP BY c.firm_id, e.id, e.client_id;

CREATE UNIQUE INDEX profitability_view_uk
  ON profitability_view (firm_id, engagement_id);

-- ---------------------------------------------------------------------
-- 6. app_user — structured profile fields (Main + Contact Info tabs)
-- ---------------------------------------------------------------------
ALTER TABLE app_user
  ADD COLUMN first_name text,
  ADD COLUMN middle_name text,
  ADD COLUMN last_name text,
  ADD COLUMN title text,
  ADD COLUMN salutation text,
  ADD COLUMN business_phone text,
  ADD COLUMN home_phone text,
  ADD COLUMN fax_phone text,
  ADD COLUMN mobile_phone text,
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city text,
  ADD COLUMN state text,
  ADD COLUMN zip text,
  ADD COLUMN hired_date date,
  ADD COLUMN left_date date;

-- Best-effort backfill: split full_name on the first whitespace. The
-- Main tab UI lets staff fix any rows where the split was wrong.
UPDATE app_user
SET
  first_name = COALESCE(NULLIF(split_part(full_name, ' ', 1), ''), full_name),
  last_name = NULLIF(
    trim(BOTH ' ' FROM substring(full_name FROM position(' ' IN full_name))),
    ''
  )
WHERE first_name IS NULL;

-- ---------------------------------------------------------------------
-- 7. engagement_template + engagement — default_rate_code_id
-- ---------------------------------------------------------------------
-- NULL means "fall back to the firm's StandardRate code at resolution
-- time", per the agreed default-on-create behavior. We do not backfill
-- with the StandardRate id because NULL is meaningful (lets the firm
-- rename / replace StandardRate later without touching every row).
ALTER TABLE engagement_template
  ADD COLUMN default_rate_code_id uuid REFERENCES rate_code(id) ON DELETE SET NULL;

ALTER TABLE engagement
  ADD COLUMN default_rate_code_id uuid REFERENCES rate_code(id) ON DELETE SET NULL;

CREATE INDEX engagement_default_rate_code_idx
  ON engagement (default_rate_code_id)
  WHERE default_rate_code_id IS NOT NULL;
