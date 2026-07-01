-- 0195 — engagement templates carry a default lifecycle status for NEW
-- engagements created from them (distinct from default_recurrence_status, which
-- applies to recurrence-spawned engagements). NULL falls back to the engagement
-- table default ('PROPOSED') at create time.
ALTER TABLE vibetb.engagement_template
  ADD COLUMN IF NOT EXISTS default_engagement_status engagement_status;
