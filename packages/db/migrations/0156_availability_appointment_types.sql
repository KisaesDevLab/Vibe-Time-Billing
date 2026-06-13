-- =====================================================================
-- Migration: 0156_availability_appointment_types.sql
--
-- Per-type bookable windows: a staff availability window may be limited
-- to specific appointment types (e.g. "Tax Prep consults only on Tuesday
-- mornings"). NULL/empty = all types allowed, mirroring how
-- location_types (0120) treats its empty state. The slot engine filters
-- windows by the requested appointment type the same way it already
-- filters by meeting location and saved location preset.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

ALTER TABLE vibetb.staff_availability
  ADD COLUMN IF NOT EXISTS appointment_type_ids uuid[];
