-- =====================================================================
-- Migration: 0062_staff_profile_expansion.sql
--
-- Expands the staff profile to match the CCH-style 9-tab profile (Main,
-- Contact Info, Skill Set, Rates, Targets, Security, Notes). Per the Q&A:
--   - SSN field intentionally NOT added (firms use external HR)
--   - Benefits tab intentionally NOT built
--   - Custom Fields intentionally NOT built
--   - Cost rate = single column on app_user (no rate-snapshot column)
--
-- Changes:
--   1. New columns on app_user covering the gaps in existing Main/Contact/
--      Notes/Rates tabs
--   2. New staff_skill table (Skill Set tab) — many-to-many app_user ↔
--      work_code with proficiency
--   3. New staff_target table (Targets tab) — annual goals per staff
-- =====================================================================

-- ---------------------------------------------------------------------
-- app_user extensions
-- ---------------------------------------------------------------------

-- Display fields (Main tab "ID" and "Description" rows). display_id is
-- the short login-style identifier ("ADMIN", "SCHEN") that staff type
-- into operator-facing UIs; description is the free-text label shown
-- alongside (e.g. "Administrator").
ALTER TABLE vibetb.app_user ADD COLUMN display_id text;
ALTER TABLE vibetb.app_user ADD COLUMN description text;
ALTER TABLE vibetb.app_user ADD COLUMN photo_url text;

-- Cost rate (single value per Q&A). What the firm pays this staff
-- person per hour. Used by profitability reports (revenue − cost).
-- Effective-dated cost-rate history is intentionally deferred; the
-- current value is used for all historical time entries.
ALTER TABLE vibetb.app_user ADD COLUMN cost_rate_cents bigint;

-- Notes tab.
ALTER TABLE vibetb.app_user ADD COLUMN internal_notes text;

-- Phone extensions for each phone slot (Contact Info shows an
-- extension column to the right of each phone field).
ALTER TABLE vibetb.app_user ADD COLUMN business_phone_ext text;
ALTER TABLE vibetb.app_user ADD COLUMN home_phone_ext text;
ALTER TABLE vibetb.app_user ADD COLUMN fax_phone_ext text;
ALTER TABLE vibetb.app_user ADD COLUMN mobile_phone_ext text;

-- Secondary email + country on address.
ALTER TABLE vibetb.app_user ADD COLUMN secondary_email text;
ALTER TABLE vibetb.app_user ADD COLUMN address_country text DEFAULT 'US';

-- Home address (separate from business address already on the table).
ALTER TABLE vibetb.app_user ADD COLUMN home_address_line1 text;
ALTER TABLE vibetb.app_user ADD COLUMN home_address_line2 text;
ALTER TABLE vibetb.app_user ADD COLUMN home_city text;
ALTER TABLE vibetb.app_user ADD COLUMN home_state text;
ALTER TABLE vibetb.app_user ADD COLUMN home_zip text;
ALTER TABLE vibetb.app_user ADD COLUMN home_country text;

-- display_id is per-firm unique when set; NULL allowed for staff that
-- haven't been assigned one yet.
CREATE UNIQUE INDEX app_user_firm_display_id_uk
  ON vibetb.app_user (firm_id, display_id)
  WHERE display_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- staff_skill — Skill Set tab
-- ---------------------------------------------------------------------
-- Pairs a staff person with the work codes they can perform, with an
-- optional proficiency tag. Used for engagement-assignment suggestions
-- and capacity planning. PK is (app_user_id, work_code_id) so the row
-- is naturally upsertable.
CREATE TABLE vibetb.staff_skill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  work_code_id uuid NOT NULL REFERENCES vibetb.work_code(id) ON DELETE CASCADE,
  proficiency text NOT NULL DEFAULT 'COMPETENT',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_skill_unique UNIQUE (app_user_id, work_code_id),
  CONSTRAINT staff_skill_proficiency_ck
    CHECK (proficiency IN ('LEARNING', 'COMPETENT', 'PROFICIENT', 'EXPERT')),
  CONSTRAINT staff_skill_notes_len_ck CHECK (notes IS NULL OR length(notes) <= 1000)
);

CREATE INDEX staff_skill_user_idx ON vibetb.staff_skill(app_user_id);
CREATE INDEX staff_skill_code_idx ON vibetb.staff_skill(work_code_id);

-- ---------------------------------------------------------------------
-- staff_target — Targets tab
-- ---------------------------------------------------------------------
-- Annual goals per staff member. One row per (app_user_id, target_year)
-- enforced by UNIQUE. Realization + utilization stored as basis points
-- (0-10000 = 0-100%) matching how other percentage fields are stored
-- across the schema.
--
-- Already-existing billable_target_hours_per_month on app_user is left
-- alone — it remains useful as a monthly default. staff_target gives
-- the firm fine-grained per-year tracking against actuals.
CREATE TABLE vibetb.staff_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  target_year integer NOT NULL,
  annual_billable_hours numeric(8,2),
  annual_total_hours numeric(8,2),
  target_realization_pct_bps integer,
  target_utilization_pct_bps integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_target_unique UNIQUE (app_user_id, target_year),
  CONSTRAINT staff_target_year_ck CHECK (target_year BETWEEN 2000 AND 2100),
  CONSTRAINT staff_target_billable_ck
    CHECK (annual_billable_hours IS NULL OR annual_billable_hours >= 0),
  CONSTRAINT staff_target_total_ck
    CHECK (annual_total_hours IS NULL OR annual_total_hours >= 0),
  CONSTRAINT staff_target_realization_ck
    CHECK (target_realization_pct_bps IS NULL
      OR target_realization_pct_bps BETWEEN 0 AND 10000),
  CONSTRAINT staff_target_utilization_ck
    CHECK (target_utilization_pct_bps IS NULL
      OR target_utilization_pct_bps BETWEEN 0 AND 10000),
  CONSTRAINT staff_target_notes_len_ck CHECK (notes IS NULL OR length(notes) <= 2000)
);

CREATE INDEX staff_target_user_year_idx ON vibetb.staff_target(app_user_id, target_year DESC);
