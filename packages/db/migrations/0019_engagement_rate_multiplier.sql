-- =====================================================================
-- Migration: 0019_engagement_rate_multiplier.sql
--
-- Engagement-level premium/discount multiplier (Phase 7 #13).
-- Stored as basis points: 10000 = 1.0x (default), 11000 = 1.1x (10%
-- premium), 8500 = 0.85x (15% discount). The resolved rate from the
-- standard hierarchy is multiplied by (rate_multiplier_bps / 10000)
-- before snapshotting onto the time entry.
--
-- Range [1000, 50000] — practical bounds 0.1x..5x; outside this range
-- is almost certainly a mistake. CHECK enforces.
-- =====================================================================

ALTER TABLE engagement
  ADD COLUMN IF NOT EXISTS rate_multiplier_bps INTEGER NOT NULL DEFAULT 10000;

ALTER TABLE engagement
  ADD CONSTRAINT engagement_rate_multiplier_bps_range
    CHECK (rate_multiplier_bps BETWEEN 1000 AND 50000);
