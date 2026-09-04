DROP INDEX IF EXISTS vibetb.message_engagement_video_idx;
ALTER TABLE vibetb.message DROP COLUMN IF EXISTS engagement_video_id;
ALTER TABLE vibetb.firm_settings
  DROP COLUMN IF EXISTS video_default_delete_after_days,
  DROP COLUMN IF EXISTS video_default_delete_days_after_play;
DROP TABLE IF EXISTS vibetb.engagement_video_play;
DROP TABLE IF EXISTS vibetb.engagement_video;
