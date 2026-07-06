-- 0201 — per-appointment rollforward inclusion. When a recurring engagement
-- with the "roll forward appointment" toggle spawns the next period, only the
-- appointments flagged rollforward_include are carried forward. Defaults to
-- true so the existing "roll every scheduled appointment" behavior is
-- preserved; staff uncheck the ones they don't want rolled on the engagement.

ALTER TABLE vibetb.appointment
  ADD COLUMN IF NOT EXISTS rollforward_include boolean NOT NULL DEFAULT true;
