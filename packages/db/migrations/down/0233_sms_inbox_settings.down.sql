DROP INDEX IF EXISTS vibetb.sms_line_firm_idx;
DROP INDEX IF EXISTS vibetb.sms_line_default_uk;
DROP TABLE IF EXISTS vibetb.sms_line;
ALTER TABLE vibetb.firm_settings DROP CONSTRAINT IF EXISTS firm_settings_sms_a2p_status_ck;
ALTER TABLE vibetb.firm_settings
  DROP COLUMN IF EXISTS sms_inbox_enabled,
  DROP COLUMN IF EXISTS sms_public_base_url,
  DROP COLUMN IF EXISTS sms_poll_interval_minutes,
  DROP COLUMN IF EXISTS sms_unassigned_retention_days,
  DROP COLUMN IF EXISTS sms_spam_retention_days,
  DROP COLUMN IF EXISTS sms_default_work_code_id,
  DROP COLUMN IF EXISTS sms_pii_warnings_enabled,
  DROP COLUMN IF EXISTS sms_consent_enforced,
  DROP COLUMN IF EXISTS sms_a2p_status,
  DROP COLUMN IF EXISTS sms_a2p_checked_at,
  DROP COLUMN IF EXISTS sms_a2p_override_allow,
  DROP COLUMN IF EXISTS sms_last_inbound_webhook_at,
  DROP COLUMN IF EXISTS sms_last_status_webhook_at,
  DROP COLUMN IF EXISTS sms_last_poll_at,
  DROP COLUMN IF EXISTS sms_last_send_at,
  DROP COLUMN IF EXISTS sms_health;
