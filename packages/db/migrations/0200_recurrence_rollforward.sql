-- 0200 — recurring-engagement rollforward toggles.
-- When a recurring engagement spawns the next period, staff may opt to also
-- roll the source engagement's appointment(s) and drop-off(s) forward,
-- preserving the ISO week-of-year + weekday (annual cadence). A rolled-forward
-- drop-off is created PENDING; the spawned engagement is set to the DRAFT
-- workflow state so staff review it before it goes live.

ALTER TABLE vibetb.engagement_recurrence
  ADD COLUMN IF NOT EXISTS rollforward_appointment boolean NOT NULL DEFAULT false;

ALTER TABLE vibetb.engagement_recurrence
  ADD COLUMN IF NOT EXISTS rollforward_dropoff boolean NOT NULL DEFAULT false;
