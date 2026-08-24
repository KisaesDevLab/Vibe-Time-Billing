-- 0226 — payroll timekeeping. Turns logged time into payroll input:
-- exempt/non-exempt OT classification, PTO/Sick/Comp accrual policies with
-- an append-only credit ledger (usage is DERIVED live from time entries
-- whose work code carries a payroll bank category — never mirrored, so
-- entry edits/archives self-correct balances), materialized pay periods
-- with per-employee approval + a payroll lock separate from billing locks,
-- and a time-off request workflow that creates ordinary time entries on
-- the 0208 firm-admin engagement when approved.
--
-- Numbered 0226 (0225 is reserved on an unmerged branch). Text + CHECK
-- over pg enums per the post-0101 idiom. Idempotent throughout.

-- ---------------------------------------------------------------------
-- Column adds
-- ---------------------------------------------------------------------

-- How the payroll rollup buckets a work code's hours. REGULAR = worked.
-- PTO/SICK/COMP_USED additionally deduct from that bank's balance.
ALTER TABLE vibetb.work_code
  ADD COLUMN IF NOT EXISTS payroll_category text NOT NULL DEFAULT 'REGULAR';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'work_code_payroll_category_ck'
  ) THEN
    ALTER TABLE vibetb.work_code
      ADD CONSTRAINT work_code_payroll_category_ck CHECK (
        payroll_category IN ('REGULAR','PTO','SICK','HOLIDAY','COMP_USED','UNPAID')
      );
  END IF;
END
$$;

-- Employment classification. overtime_exempt defaults true (no phantom OT
-- until admin marks staff non-exempt); is_full_time gates accrual — only
-- full-timers accrue and get holiday credit.
ALTER TABLE vibetb.app_user
  ADD COLUMN IF NOT EXISTS overtime_exempt boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_full_time boolean NOT NULL DEFAULT true;

-- Firm payroll knobs. workweek_start_day: 0=Sunday..6=Saturday (FLSA
-- workweek for the weekly-over-40 OT rule). anchor_date is a known period
-- START for WEEKLY/BIWEEKLY; SEMI_MONTHLY is fixed 1–15/16–EOM and
-- MONTHLY is the calendar month (anchor unused for those).
ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS payroll_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payroll_workweek_start_day smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payroll_period_frequency text NOT NULL DEFAULT 'BIWEEKLY',
  ADD COLUMN IF NOT EXISTS payroll_period_anchor_date date,
  ADD COLUMN IF NOT EXISTS payroll_holiday_default_hours numeric(4,2) NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS payroll_comp_ot_multiplier numeric(3,2) NOT NULL DEFAULT 1.5;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'firm_settings_payroll_workweek_ck'
  ) THEN
    ALTER TABLE vibetb.firm_settings
      ADD CONSTRAINT firm_settings_payroll_workweek_ck
        CHECK (payroll_workweek_start_day BETWEEN 0 AND 6),
      ADD CONSTRAINT firm_settings_payroll_frequency_ck
        CHECK (payroll_period_frequency IN ('WEEKLY','BIWEEKLY','SEMI_MONTHLY','MONTHLY'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Accrual policies
-- ---------------------------------------------------------------------

-- One policy per bank; assigned per employee. method decides which rate
-- columns apply: FIXED_PER_PERIOD → hours_per_period; PER_HOURS_WORKED →
-- earn_hours per per_worked_hours (e.g. 1 per 30); ANNUAL_GRANT →
-- annual_grant_hours at annual_grant_timing. Tenure tiers (below)
-- override the method's primary rate at ≥ min_years_service.
CREATE TABLE IF NOT EXISTS vibetb.accrual_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  bank text NOT NULL CHECK (bank IN ('PTO','SICK','COMP')),
  name text NOT NULL,
  method text NOT NULL CHECK (method IN ('FIXED_PER_PERIOD','PER_HOURS_WORKED','ANNUAL_GRANT')),
  hours_per_period numeric(6,2) CHECK (hours_per_period > 0),
  earn_hours numeric(6,2) CHECK (earn_hours > 0),
  per_worked_hours numeric(6,2) CHECK (per_worked_hours > 0),
  annual_grant_hours numeric(6,2) CHECK (annual_grant_hours > 0),
  annual_grant_timing text CHECK (annual_grant_timing IN ('CALENDAR_YEAR','ANNIVERSARY')),
  -- Days after hired_date before accrual starts / usage is allowed.
  accrual_waiting_days integer NOT NULL DEFAULT 0 CHECK (accrual_waiting_days >= 0),
  usage_waiting_days integer NOT NULL DEFAULT 0 CHECK (usage_waiting_days >= 0),
  -- NULL = no ceiling. Accrual clamps so balance never exceeds this.
  max_balance_hours numeric(7,2) CHECK (max_balance_hours > 0),
  -- NULL = unlimited carryover. Jan-1 job forfeits the excess.
  carryover_cap_hours numeric(7,2) CHECK (carryover_cap_hours >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accrual_policy_firm_idx
  ON vibetb.accrual_policy (firm_id, bank);

CREATE TABLE IF NOT EXISTS vibetb.accrual_policy_tier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES vibetb.accrual_policy(id) ON DELETE CASCADE,
  min_years_service integer NOT NULL CHECK (min_years_service >= 0),
  rate_hours numeric(6,2) NOT NULL CHECK (rate_hours > 0),
  UNIQUE (policy_id, min_years_service)
);

-- bank is denormalized from the policy so the one-active-assignment rule
-- can be a plain partial unique index.
CREATE TABLE IF NOT EXISTS vibetb.accrual_policy_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL REFERENCES vibetb.accrual_policy(id) ON DELETE CASCADE,
  bank text NOT NULL CHECK (bank IN ('PTO','SICK','COMP')),
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accrual_assignment_one_active_idx
  ON vibetb.accrual_policy_assignment (app_user_id, bank) WHERE end_date IS NULL;
CREATE INDEX IF NOT EXISTS accrual_assignment_policy_idx
  ON vibetb.accrual_policy_assignment (policy_id);

-- ---------------------------------------------------------------------
-- Time-off ledger (credits only; usage derived from time entries)
-- ---------------------------------------------------------------------

-- Append-only. delta_hours is signed: ACCRUAL/GRANT/COMP_EARNED positive,
-- CARRYOVER_FORFEIT negative, ADJUSTMENT either. period_key makes job
-- writes idempotent ('PP:<pay_period_id>', 'ANNUAL:2026', 'ANNIV:2026',
-- 'CY:2026'); manual rows leave it NULL. created_by NULL = system job.
CREATE TABLE IF NOT EXISTS vibetb.time_off_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  bank text NOT NULL CHECK (bank IN ('PTO','SICK','COMP')),
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  delta_hours numeric(7,2) NOT NULL CHECK (delta_hours <> 0),
  reason text NOT NULL CHECK (
    reason IN ('ACCRUAL','GRANT','COMP_EARNED','CARRYOVER_FORFEIT','ADJUSTMENT')
  ),
  policy_id uuid REFERENCES vibetb.accrual_policy(id) ON DELETE SET NULL,
  pay_period_id uuid,
  period_key text,
  note text NOT NULL DEFAULT '',
  created_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS time_off_ledger_period_key_idx
  ON vibetb.time_off_ledger (app_user_id, bank, reason, period_key)
  WHERE period_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_off_ledger_user_bank_idx
  ON vibetb.time_off_ledger (app_user_id, bank, entry_date);
CREATE INDEX IF NOT EXISTS time_off_ledger_firm_idx
  ON vibetb.time_off_ledger (firm_id, created_at);

-- Append-only at the DB level, same belt-and-suspenders as audit_log.
CREATE OR REPLACE FUNCTION vibetb.time_off_ledger_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'time_off_ledger is append-only — UPDATE/DELETE blocked'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER time_off_ledger_no_update
  BEFORE UPDATE ON vibetb.time_off_ledger
  FOR EACH ROW EXECUTE FUNCTION vibetb.time_off_ledger_block_mutation();
CREATE OR REPLACE TRIGGER time_off_ledger_no_delete
  BEFORE DELETE ON vibetb.time_off_ledger
  FOR EACH ROW EXECUTE FUNCTION vibetb.time_off_ledger_block_mutation();

-- ---------------------------------------------------------------------
-- Pay periods
-- ---------------------------------------------------------------------

-- Materialized periods (generated on demand + nightly, next 3 kept ahead).
-- LOCKED freezes every time entry dated inside the range for all users —
-- enforced in createTimeEntryCore / PATCH / DELETE, distinct from the
-- billing locked_at/billing_batch_id concepts.
CREATE TABLE IF NOT EXISTS vibetb.pay_period (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED')),
  locked_at timestamptz,
  locked_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, start_date)
);
CREATE INDEX IF NOT EXISTS pay_period_firm_status_idx
  ON vibetb.pay_period (firm_id, status, end_date);

-- Per-employee sign-off within a period, plus OT→comp conversion hours
-- (reduces reported OT without mutating entries).
CREATE TABLE IF NOT EXISTS vibetb.pay_period_employee (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_period_id uuid NOT NULL REFERENCES vibetb.pay_period(id) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  approved_at timestamptz,
  approved_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  comp_converted_hours numeric(6,2) NOT NULL DEFAULT 0 CHECK (comp_converted_hours >= 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pay_period_id, app_user_id)
);
CREATE INDEX IF NOT EXISTS pay_period_employee_user_idx
  ON vibetb.pay_period_employee (app_user_id);

-- time_off_ledger.pay_period_id FK, added after pay_period exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'time_off_ledger_pay_period_fk'
  ) THEN
    ALTER TABLE vibetb.time_off_ledger
      ADD CONSTRAINT time_off_ledger_pay_period_fk
        FOREIGN KEY (pay_period_id) REFERENCES vibetb.pay_period(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Time-off requests
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.time_off_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  app_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('PTO','SICK','COMP','UNPAID')),
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  total_hours numeric(6,2) NOT NULL CHECK (total_hours > 0),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DENIED','CANCELLED')),
  note text NOT NULL DEFAULT '',
  approver_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_off_request_firm_status_idx
  ON vibetb.time_off_request (firm_id, status, start_date);
CREATE INDEX IF NOT EXISTS time_off_request_user_idx
  ON vibetb.time_off_request (app_user_id, created_at);

-- Per-day hour rows; time_entry_id set on approval (one ordinary entry
-- per day, created through createTimeEntryCore on the firm-admin
-- engagement with the kind's seeded work code).
CREATE TABLE IF NOT EXISTS vibetb.time_off_request_day (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES vibetb.time_off_request(id) ON DELETE CASCADE,
  day date NOT NULL,
  hours numeric(5,2) NOT NULL CHECK (hours > 0),
  time_entry_id uuid REFERENCES vibetb.time_entry(id) ON DELETE SET NULL,
  UNIQUE (request_id, day)
);

-- ---------------------------------------------------------------------
-- Seed payroll work codes on the Internal service line (0208 idiom).
-- Non-billable; the 0208 firm-admin engagement's work-code picker shows
-- codes on its Internal line, so these appear there automatically.
-- ---------------------------------------------------------------------

INSERT INTO vibetb.work_code (firm_id, service_line_id, key, name, billable_default, payroll_category)
SELECT f.id, sl.id, wc.key, wc.name, false, wc.payroll_category
FROM vibetb.firm f
JOIN vibetb.service_line sl ON sl.firm_id = f.id AND sl.category = 'internal'
CROSS JOIN (VALUES
  ('pto', 'PTO / Vacation', 'PTO'),
  ('sick_leave', 'Sick leave', 'SICK'),
  ('holiday', 'Holiday', 'HOLIDAY'),
  ('comp_time_used', 'Comp time used', 'COMP_USED'),
  ('unpaid_leave', 'Unpaid leave', 'UNPAID')
) AS wc(key, name, payroll_category)
ON CONFLICT (firm_id, key) DO NOTHING;

-- Existing installs may have the codes from a partial run without the
-- category (idempotent re-tag; safe because these keys are seed-owned).
UPDATE vibetb.work_code wc SET payroll_category = v.payroll_category
FROM (VALUES
  ('pto', 'PTO'),
  ('sick_leave', 'SICK'),
  ('holiday', 'HOLIDAY'),
  ('comp_time_used', 'COMP_USED'),
  ('unpaid_leave', 'UNPAID')
) AS v(key, payroll_category)
WHERE wc.key = v.key AND wc.payroll_category = 'REGULAR';
