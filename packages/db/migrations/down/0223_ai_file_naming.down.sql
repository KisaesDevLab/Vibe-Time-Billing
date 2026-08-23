DROP INDEX IF EXISTS vibetb.files_ai_rename_pending_ix;
ALTER TABLE vibetb.files
  DROP COLUMN IF EXISTS original_upload_filename,
  DROP COLUMN IF EXISTS ai_rename_attempted_at,
  DROP COLUMN IF EXISTS ai_renamed_at,
  DROP COLUMN IF EXISTS ai_rename_confidence,
  DROP COLUMN IF EXISTS ai_suggested_filename,
  DROP COLUMN IF EXISTS ai_rename_model;
ALTER TABLE vibetb.firm_settings
  DROP COLUMN IF EXISTS auto_rename_uploads,
  DROP COLUMN IF EXISTS file_naming_pattern,
  DROP COLUMN IF EXISTS file_naming_examples,
  DROP COLUMN IF EXISTS file_naming_min_confidence;
