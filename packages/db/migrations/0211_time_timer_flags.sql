-- 0211 — QA: a ▶ "continue" from a non-billable or out-of-scope entry must
-- not produce a billable entry on save. The timer now carries the source
-- row's billable/OOS flags (null = unspecified → the create default). Save
-- uses them when the save payload doesn't override.

ALTER TABLE vibetb.time_timer
  ADD COLUMN IF NOT EXISTS billable_flag boolean,
  ADD COLUMN IF NOT EXISTS out_of_scope_override boolean;
