DROP TABLE IF EXISTS vibetb.sms_template;
ALTER TABLE vibetb.intake_sessions DROP CONSTRAINT IF EXISTS intake_sessions_source_ck;
ALTER TABLE vibetb.intake_sessions ADD CONSTRAINT intake_sessions_source_ck
  CHECK (source IN ('public', 'tokenized_link'));
DROP TABLE IF EXISTS vibetb.sms_media;
DROP TABLE IF EXISTS vibetb.sms_message;
DROP TABLE IF EXISTS vibetb.sms_conversation;
DROP TRIGGER IF EXISTS person_sync_phone_e164_trg ON vibetb.person;
DROP FUNCTION IF EXISTS vibetb.person_sync_phone_e164();
DROP INDEX IF EXISTS vibetb.person_firm_mobile_e164_idx;
DROP INDEX IF EXISTS vibetb.person_firm_phone_e164_idx;
ALTER TABLE vibetb.person DROP CONSTRAINT IF EXISTS person_sms_consent_source_ck;
ALTER TABLE vibetb.person
  DROP COLUMN IF EXISTS phone_e164,
  DROP COLUMN IF EXISTS mobile_e164,
  DROP COLUMN IF EXISTS sms_opt_out_at,
  DROP COLUMN IF EXISTS sms_opt_out_source,
  DROP COLUMN IF EXISTS sms_consent_at,
  DROP COLUMN IF EXISTS sms_consent_source,
  DROP COLUMN IF EXISTS sms_consent_by_user_id;
DROP FUNCTION IF EXISTS vibetb.normalize_phone_e164(text);
