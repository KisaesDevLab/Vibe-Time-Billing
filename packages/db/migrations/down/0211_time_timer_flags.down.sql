ALTER TABLE vibetb.time_timer
  DROP COLUMN IF EXISTS billable_flag,
  DROP COLUMN IF EXISTS out_of_scope_override;
