-- Down: 0171_engagement_template_recurrence_trigger.sql
ALTER TABLE vibetb.engagement_template
  DROP COLUMN IF EXISTS default_recurrence_trigger_mode;
