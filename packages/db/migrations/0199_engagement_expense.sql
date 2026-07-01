-- 0199 — engagement expenses. Out-of-pocket costs (filing fees, courier,
-- travel) billed to the client at cost + markup%. Deliberately NOT time_entry
-- rows and never adjustment_allocation rows, so they carry no timekeeper and
-- stay out of per-timekeeper realization (CLAUDE.md non-negotiable #4). A
-- billing batch pulls them in via billing_batch_expense and applies the same
-- INCLUDE / DEFER / WRITE_OFF actions as time.

DO $$ BEGIN
  CREATE TYPE expense_status AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS vibetb.engagement_expense (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  engagement_id uuid NOT NULL REFERENCES vibetb.engagement(id),
  expense_date date NOT NULL,
  description text NOT NULL,
  cost_cents bigint NOT NULL,
  category text,
  vendor text,
  -- Availability governor — mirrors time_entry.billing_batch_id. Set when
  -- claimed into a batch; cleared on DEFER/release so a future batch re-claims.
  billing_batch_id uuid,
  status expense_status NOT NULL DEFAULT 'ACTIVE',
  created_by_id uuid REFERENCES vibetb.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_expense_cost_nonnegative CHECK (cost_cents >= 0)
);

CREATE INDEX IF NOT EXISTS engagement_expense_firm_engagement_status_idx
  ON vibetb.engagement_expense (firm_id, engagement_id, status);
CREATE INDEX IF NOT EXISTS engagement_expense_batch_idx
  ON vibetb.engagement_expense (billing_batch_id);

-- Expense↔batch association — parallels billing_batch_entry. Reuses the
-- billing_batch_entry_action enum; billed_amount_cents is the resolved
-- cost+markup amount for this batch.
CREATE TABLE IF NOT EXISTS vibetb.billing_batch_expense (
  billing_batch_id uuid NOT NULL REFERENCES vibetb.billing_batch(id) ON DELETE CASCADE,
  expense_id uuid NOT NULL REFERENCES vibetb.engagement_expense(id),
  action billing_batch_entry_action NOT NULL DEFAULT 'INCLUDE',
  billed_amount_cents bigint,
  comment text,
  CONSTRAINT billing_batch_expense_pk PRIMARY KEY (billing_batch_id, expense_id)
);

CREATE INDEX IF NOT EXISTS billing_batch_expense_expense_idx
  ON vibetb.billing_batch_expense (expense_id);
