-- 0223 — AI file naming (router-mode only). Firm naming convention + the
-- auto-rename toggle live on firm_settings; per-file provenance (original
-- name, confidence, stored low-confidence suggestion) on files.
ALTER TABLE vibetb.firm_settings
  ADD COLUMN IF NOT EXISTS auto_rename_uploads boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS file_naming_pattern text NOT NULL DEFAULT '{year} {doc_type} - {issuer} - {client}',
  ADD COLUMN IF NOT EXISTS file_naming_examples text NOT NULL DEFAULT E'2024 W-2 - Acme Corp - Smith John\n2023 Form 1040 - Smith John\n2024-Q3 Bank Statement - Chase - Smith Family Trust',
  ADD COLUMN IF NOT EXISTS file_naming_min_confidence real NOT NULL DEFAULT 0.7;

ALTER TABLE vibetb.files
  ADD COLUMN IF NOT EXISTS original_upload_filename text,
  ADD COLUMN IF NOT EXISTS ai_rename_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_renamed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_rename_confidence real,
  ADD COLUMN IF NOT EXISTS ai_suggested_filename text,
  ADD COLUMN IF NOT EXISTS ai_rename_model text;

CREATE INDEX IF NOT EXISTS files_ai_rename_pending_ix ON vibetb.files (firm_id)
  WHERE ai_rename_attempted_at IS NULL AND deleted_at IS NULL AND pending_upload = false;
