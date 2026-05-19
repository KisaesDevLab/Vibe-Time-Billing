-- =====================================================================
-- Migration: 0002_adjustment_sum_trigger.sql
--
-- Enforce that the sum of adjustment_allocation.adjustment_amount_cents
-- for a given adjustment equals adjustment.total_amount_cents.
--
-- Implemented as a DEFERRABLE INITIALLY DEFERRED constraint trigger so
-- multi-row inserts within a single transaction are validated AT COMMIT,
-- not after each row. This matters because the allocation rows are written
-- after the parent adjustment in the same transaction.
--
-- Tolerance: ±1 cent total, to accommodate proportional rounding in the
-- allocation algorithms. The application code distributes the remainder
-- deterministically (largest absolute value entry absorbs it) so this
-- tolerance is rarely exercised but provides safety.
--
-- This protects the non-negotiable from CLAUDE.md:
--   "Per-timekeeper allocation grain: adjustment_allocation rows at
--    (adjustment_id, time_entry_id, app_user_id)"
--
-- Apply after both adjustment and adjustment_allocation tables exist.
-- =====================================================================

CREATE OR REPLACE FUNCTION check_adjustment_allocation_sum()
RETURNS TRIGGER AS $$
DECLARE
  adj_total BIGINT;
  alloc_sum BIGINT;
  adj_id UUID;
BEGIN
  -- Determine which adjustment changed
  IF TG_OP = 'DELETE' THEN
    adj_id := OLD.adjustment_id;
  ELSE
    adj_id := NEW.adjustment_id;
  END IF;

  -- Fetch the parent total
  SELECT total_amount_cents INTO adj_total
  FROM adjustment
  WHERE id = adj_id;

  IF adj_total IS NULL THEN
    -- Parent doesn't exist (likely a cascading delete in progress) — skip
    RETURN NULL;
  END IF;

  -- Sum the allocations
  SELECT COALESCE(SUM(adjustment_amount_cents), 0) INTO alloc_sum
  FROM adjustment_allocation
  WHERE adjustment_id = adj_id;

  -- Allow ±1 cent for proportional rounding
  IF ABS(alloc_sum - adj_total) > 1 THEN
    RAISE EXCEPTION 'adjustment_allocation sum (%) does not equal adjustment total (%) for adjustment %',
      alloc_sum, adj_total, adj_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Constraint trigger fires at end of transaction (DEFERRED)
CREATE CONSTRAINT TRIGGER adjustment_allocation_sum_check
  AFTER INSERT OR UPDATE OR DELETE ON adjustment_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_adjustment_allocation_sum();

-- Also enforce on the parent side: if adjustment.total_amount_cents changes,
-- re-validate the sum. This catches the case where someone updates the
-- adjustment after the allocations were already in place.
CREATE OR REPLACE FUNCTION check_adjustment_total_against_allocations()
RETURNS TRIGGER AS $$
DECLARE
  alloc_sum BIGINT;
BEGIN
  IF NEW.total_amount_cents IS DISTINCT FROM OLD.total_amount_cents THEN
    SELECT COALESCE(SUM(adjustment_amount_cents), 0) INTO alloc_sum
    FROM adjustment_allocation
    WHERE adjustment_id = NEW.id;

    IF ABS(alloc_sum - NEW.total_amount_cents) > 1 THEN
      RAISE EXCEPTION 'cannot change adjustment total — existing allocations sum to %, new total is %',
        alloc_sum, NEW.total_amount_cents
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER adjustment_total_check
  AFTER UPDATE ON adjustment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_adjustment_total_against_allocations();

-- =====================================================================
-- Usage notes:
--
-- Application code creating an adjustment + allocations in a transaction:
--
--   BEGIN;
--   INSERT INTO adjustment (...) VALUES (...) RETURNING id;  -- ✓ no check yet
--   INSERT INTO adjustment_allocation (...) VALUES (...);    -- ✓ no check yet
--   INSERT INTO adjustment_allocation (...) VALUES (...);    -- ✓ no check yet
--   INSERT INTO adjustment_allocation (...) VALUES (...);    -- ✓ no check yet
--   COMMIT;                                                  -- check fires here
--
-- If the sum doesn't match the parent total, COMMIT raises an exception
-- and the entire transaction rolls back atomically. This is what we want:
-- the database refuses to persist an inconsistent adjustment.
--
-- For reversal, the application creates a new adjustment with negated
-- total and negated allocation amounts in a single transaction. Same check
-- applies.
-- =====================================================================
