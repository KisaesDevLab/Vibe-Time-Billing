-- =====================================================================
-- Migration: 0159_client_credentials.sql
--
-- Per-client credential vault. Stores client login credentials (IRS
-- e-Services, state portals, bank/payroll, software logins) encrypted at
-- rest: each row carries a per-record DEK wrapped by the firm MFK, and the
-- *_enc columns hold ciphertext under that DEK (mirrors intake/messaging/
-- calendar). Only title/category/hint are plaintext (list preview). Reveal
-- is gated by RBAC + step-up + audit; no plaintext secret columns.
--
-- NOTE: no `DO $$ ... $$` blocks (the pglite test harness strips them);
-- bare statements only. Migrate runner wraps each file in one txn.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vibetb.client_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES vibetb.client(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  hint text,
  wrapped_dek bytea NOT NULL,
  username_enc bytea,
  password_enc bytea,
  url_enc bytea,
  notes_enc bytea,
  status text NOT NULL DEFAULT 'ACTIVE',
  last_revealed_at timestamptz,
  last_revealed_by uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_by uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_credential_status_ck CHECK (status IN ('ACTIVE', 'ARCHIVED'))
);

CREATE INDEX IF NOT EXISTS client_credential_firm_idx
  ON vibetb.client_credential (firm_id);

CREATE INDEX IF NOT EXISTS client_credential_client_idx
  ON vibetb.client_credential (client_id, status, created_at DESC);
