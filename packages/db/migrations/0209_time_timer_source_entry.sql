-- 0209 — provenance for "continue" timers. A ▶ continue on a logged entry
-- starts a NEW timer prefilled from that row; recording which entry spawned
-- it lets the time views show a live running indicator on that exact row
-- (and offer pause/stop there) instead of guessing by engagement+work-code.
-- SET NULL on entry archive/delete: the timer keeps running, it just loses
-- the row link.

ALTER TABLE vibetb.time_timer
  ADD COLUMN IF NOT EXISTS source_time_entry_id uuid
    REFERENCES vibetb.time_entry(id) ON DELETE SET NULL;
