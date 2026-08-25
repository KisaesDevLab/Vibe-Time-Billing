ALTER TABLE vibetb.inbox_routing_log DROP CONSTRAINT IF EXISTS inbox_routing_log_action_ck;
ALTER TABLE vibetb.inbox_routing_log
  ADD CONSTRAINT inbox_routing_log_action_ck
  CHECK (action IN ('filed', 'tax_flagged', 'skipped', 'failed'));
ALTER TABLE vibetb.inbox_routing_profiles DROP CONSTRAINT IF EXISTS inbox_routing_profiles_k1_year_behavior_ck;
ALTER TABLE vibetb.inbox_routing_profiles DROP COLUMN IF EXISTS k1_year_behavior;
ALTER TABLE vibetb.inbox_routing_profiles DROP COLUMN IF EXISTS k1_target_path;
ALTER TABLE vibetb.inbox_items DROP CONSTRAINT IF EXISTS inbox_items_k1_status_ck;
ALTER TABLE vibetb.inbox_items DROP COLUMN IF EXISTS k1_override_folder;
ALTER TABLE vibetb.inbox_items DROP COLUMN IF EXISTS k1_status;
ALTER TABLE vibetb.inbox_items DROP COLUMN IF EXISTS k1_match_score;
ALTER TABLE vibetb.inbox_items DROP COLUMN IF EXISTS k1_matched_client;
ALTER TABLE vibetb.inbox_items DROP COLUMN IF EXISTS k1_recipient_name;
