-- =====================================================================
-- Migration: 0063_time_entry_cost_snapshot.sql
--
-- Locks the cost rate on every time entry the same way the bill rate
-- is locked. Before this migration:
--
--   time_entry.standard_rate_snapshot_cents  ← bill rate, snapshotted on write
--   profitability_view.loaded_cost_cents     ← cost recomputed at READ time
--                                              via LATERAL JOIN on
--                                              staff_rate_snapshot.cost_rate_cents
--                                              (asymmetric — violates
--                                              CLAUDE.md non-negotiable #3
--                                              for the cost side)
--
-- After:
--
--   time_entry.standard_rate_snapshot_cents  ← unchanged
--   time_entry.cost_rate_snapshot_cents      ← NEW, snapshotted on write
--   profitability_view + reports + engagements all read te.cost_rate_snapshot_cents
--
-- Backfill: every existing row gets its cost_rate_snapshot_cents from
-- the most recent staff_rate_snapshot whose effective_date <=
-- time_entry.entry_date. Rows where no snapshot exists for the user
-- stay NULL and downstream sums COALESCE to 0 (same as before).
--
-- Companion fix: drop the orphan app_user.cost_rate_cents column added
-- in 0062. Per the rate-process review, nothing reads it — the cost
-- rate that drives reports is the snapshot, not a per-user single
-- value. Removing it eliminates the write-only field and the
-- single-vs-snapshot ambiguity.
-- =====================================================================

-- 1. Add the column (nullable so existing rows + future rows where no
--    cost rate exists can sit at NULL without violating the constraint).
ALTER TABLE vibetb.time_entry ADD COLUMN cost_rate_snapshot_cents bigint;

-- 2. Backfill from staff_rate_snapshot using the same LATERAL pattern
--    that profitability_view used to use at read time.
UPDATE vibetb.time_entry te
SET cost_rate_snapshot_cents = (
  SELECT srs.cost_rate_cents
    FROM vibetb.staff_rate_snapshot srs
   WHERE srs.app_user_id = te.app_user_id
     AND srs.effective_date <= te.entry_date
   ORDER BY srs.effective_date DESC
   LIMIT 1
)
WHERE te.cost_rate_snapshot_cents IS NULL;

-- 3. Drop the orphan column from 0062 (never read by resolver, reports,
--    or any materialized view — the cost rate that matters lives on
--    staff_rate_snapshot and now on time_entry).
ALTER TABLE vibetb.app_user DROP COLUMN cost_rate_cents;

-- 4. Rewrite profitability_view: cost is now sourced from
--    te.cost_rate_snapshot_cents directly. No more LATERAL join.
DROP MATERIALIZED VIEW IF EXISTS vibetb.profitability_view;

CREATE MATERIALIZED VIEW vibetb.profitability_view AS
SELECT
  c.firm_id                                                                AS firm_id,
  e.id                                                                     AS engagement_id,
  e.client_id                                                              AS client_id,
  COALESCE(SUM(inv.total_cents), 0)::BIGINT                                AS billed_cents,
  COALESCE(
    SUM(te.hours::numeric * COALESCE(te.cost_rate_snapshot_cents, 0)),
    0
  )::NUMERIC                                                               AS loaded_cost_cents,
  COALESCE(SUM(inv.total_cents), 0)::NUMERIC
    - COALESCE(
        SUM(te.hours::numeric * COALESCE(te.cost_rate_snapshot_cents, 0)),
        0
      )::NUMERIC                                                           AS profit_cents
FROM vibetb.engagement e
JOIN vibetb.client c          ON c.id = e.client_id
LEFT JOIN vibetb.invoice inv  ON inv.primary_engagement_id = e.id
                             AND inv.status IN ('SENT','PARTIALLY_PAID','PAID')
LEFT JOIN vibetb.time_entry te ON te.engagement_id = e.id
GROUP BY c.firm_id, e.id, e.client_id;

CREATE UNIQUE INDEX profitability_view_uk
  ON vibetb.profitability_view (firm_id, engagement_id);

-- The view is unindexed beyond the unique key by design — `REFRESH
-- MATERIALIZED VIEW CONCURRENTLY` from the view-refresh worker
-- requires that unique index and nothing else.
