-- =====================================================================
-- Migration: 0103_intake.sql  (Document Intake Addendum — foundations)
--
-- Anonymous-friendly public document intake. PII/content columns are
-- MFK-wrapped: each session/link carries a per-record DEK (wrapped_dek)
-- that encrypts its *_enc columns (see apps/api/src/intake/crypto.ts).
-- Feature is license-gated + per-firm (firm_config.intake_enabled).
-- =====================================================================

ALTER TABLE vibetb.firm_config
  ADD COLUMN IF NOT EXISTS intake_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS vibetb.intake_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  target_staff_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz,
  wrapped_dek bytea,
  recipient_email_enc bytea,
  recipient_phone_enc bytea,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_links_firm_idx ON vibetb.intake_links (firm_id);

CREATE TABLE IF NOT EXISTS vibetb.intake_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  target_staff_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  wrapped_dek bytea NOT NULL,
  client_name_enc bytea,
  client_email_enc bytea,
  client_phone_enc bytea,
  message_enc bytea,
  source text NOT NULL DEFAULT 'public'
    CHECK (source IN ('public', 'tokenized_link')),
  link_token_id uuid REFERENCES vibetb.intake_links(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_scan'
    CHECK (status IN ('pending_scan', 'processing', 'received', 'disposed', 'rejected')),
  matched_client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_sessions_firm_status_idx ON vibetb.intake_sessions (firm_id, status);
CREATE INDEX IF NOT EXISTS intake_sessions_target_staff_idx ON vibetb.intake_sessions (target_staff_id);

CREATE TABLE IF NOT EXISTS vibetb.intake_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES vibetb.intake_sessions(id) ON DELETE CASCADE,
  original_filename_enc bytea,
  object_key text NOT NULL,
  mime_type text,
  byte_size bigint NOT NULL,
  kind text NOT NULL DEFAULT 'upload' CHECK (kind IN ('upload', 'scan')),
  scan_status text NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending', 'clean', 'infected')),
  assembled_pdf_object_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_files_session_idx ON vibetb.intake_files (session_id);

CREATE TABLE IF NOT EXISTS vibetb.intake_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES vibetb.intake_sessions(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  action text NOT NULL
    CHECK (action IN ('move', 'assign', 'review', 'archive', 'reject', 'leave')),
  target_client_id uuid REFERENCES vibetb.client(id) ON DELETE SET NULL,
  target_engagement_id uuid REFERENCES vibetb.engagement(id) ON DELETE SET NULL,
  target_folder_id uuid REFERENCES vibetb.client_folders(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intake_actions_session_idx ON vibetb.intake_actions (session_id);

CREATE TABLE IF NOT EXISTS vibetb.intake_staff_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES vibetb.app_user(id) ON DELETE CASCADE,
  is_visible boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  accepting_uploads boolean NOT NULL DEFAULT true,
  display_title text,
  headshot_object_key text,
  notify_email boolean NOT NULL DEFAULT true,
  notify_sms boolean NOT NULL DEFAULT false,
  notify_in_app boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS intake_staff_cards_firm_user_uk
  ON vibetb.intake_staff_cards (firm_id, user_id);
CREATE INDEX IF NOT EXISTS intake_staff_cards_firm_visible_idx
  ON vibetb.intake_staff_cards (firm_id, is_visible);

-- Seed a hidden card for every active staff user (idempotent).
INSERT INTO vibetb.intake_staff_cards (firm_id, user_id, is_visible, accepting_uploads)
SELECT u.firm_id, u.id, false, true
FROM vibetb.app_user u
WHERE u.status = 'ACTIVE'
ON CONFLICT (firm_id, user_id) DO NOTHING;
