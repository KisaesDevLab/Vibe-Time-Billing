-- 0204 — firm-level "auto due date from drop-off" offset. When a drop-off date
-- is entered for an engagement that has no due date yet, the due date is set to
-- this many days after the drop-off. NULL = feature disabled (no auto due date).
ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS dropoff_due_offset_days integer;
