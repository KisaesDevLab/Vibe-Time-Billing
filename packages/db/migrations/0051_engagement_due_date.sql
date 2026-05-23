-- =====================================================================
-- Migration: 0051_engagement_due_date.sql
--
-- Adds an explicit due_date to engagement. Distinct from end_date
-- (when work concludes) — due_date is the external deadline the client
-- owes the engagement against (filing deadline, audit report date, etc).
-- Displayed on dashboard "My active engagements" + engagements list +
-- detail. NULL means no deadline tracked.
-- =====================================================================

ALTER TABLE engagement
  ADD COLUMN due_date date;

-- Partial index for "active engagements with a due date in the future"
-- — supports the dashboard sort/filter without scanning the whole table.
CREATE INDEX IF NOT EXISTS engagement_due_date_idx
  ON engagement (due_date)
  WHERE due_date IS NOT NULL;
