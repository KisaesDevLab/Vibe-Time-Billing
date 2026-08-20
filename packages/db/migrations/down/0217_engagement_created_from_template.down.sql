DROP INDEX IF EXISTS vibetb.engagement_created_from_template_idx;
ALTER TABLE vibetb.engagement DROP COLUMN IF EXISTS created_from_template_id;
