-- =====================================================================
-- Migration: 0094_storage_settings.sql
--
-- UI-configurable file storage. Until now the appliance only honored
-- STORAGE_PROVIDER + B2_* / MINIO_* env vars read at boot. This adds a
-- per-firm settings row so admins can flip the provider + paste
-- credentials from Admin → Storage without editing .env files.
--
-- Credentials are written as encrypted bytea (sealed with the firm's
-- Master Firm Key via wrapTDek) so a DB dump never leaks them. We
-- also store a short "_hint" (last 4 chars) so the UI can render a
-- masked preview without ever decrypting.
--
-- Boot resolution order: storage_settings row → env vars → mock default.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.storage_settings (
  firm_id uuid PRIMARY KEY REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'mock',

  -- B2 fields (non-secret)
  b2_endpoint text,
  b2_region text,
  b2_bucket text,
  b2_key_id_encrypted bytea,
  b2_application_key_encrypted bytea,
  b2_key_id_hint text,

  -- MinIO fields (non-secret)
  minio_endpoint text,
  minio_region text,
  minio_bucket text,
  minio_access_key_encrypted bytea,
  minio_secret_key_encrypted bytea,
  minio_access_key_hint text,

  -- Last successful test (so the UI can show "verified at …").
  last_tested_at timestamptz,
  last_tested_provider text,
  last_test_error text,

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,

  CONSTRAINT storage_settings_provider_ck
    CHECK (provider IN ('mock', 'b2', 'minio'))
);
