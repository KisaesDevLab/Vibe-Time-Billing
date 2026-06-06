-- 0120 — Per-availability-window location types.
--
-- A staff availability window can be restricted to specific meeting location
-- types (e.g. mornings in-person only, afternoons video). NULL or empty =
-- the window allows every location (back-compat with existing rows).
-- Combined with multiple rows per (staff, day_of_week) — already supported by
-- the table — this gives split shifts with per-window location rules.

ALTER TABLE vibetb.staff_availability
  ADD COLUMN IF NOT EXISTS location_types text[];
