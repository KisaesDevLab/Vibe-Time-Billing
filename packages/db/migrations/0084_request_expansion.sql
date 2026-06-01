-- =====================================================================
-- Migration: 0084_request_expansion.sql
--
-- Client request feature expansion:
--   A. Adds NEEDS_INFO status, priority + tags + reminder + reply
--      fields on client_request.
--   B. Adds request_template + request_template_item for repeatable
--      checklists, with Mustache name patterns resolved at spawn time.
--   C. Adds client_request_item for multi-item per-request checklists
--      (each item fulfilled separately).
--   D. Adds client_request_attachment for portal-side file uploads.
--
-- Status is a TEXT column with a CHECK constraint (not a pgEnum), so
-- adding NEEDS_INFO is just DROP + RECREATE of the check — no
-- ALTER TYPE dance needed.
--
-- The new request_priority IS a pgEnum (small fixed set, won't extend).
-- =====================================================================

-- --- (A) NEEDS_INFO status + priority enum + new client_request columns

ALTER TABLE vibetb.client_request
  DROP CONSTRAINT IF EXISTS client_request_status_ck;

ALTER TABLE vibetb.client_request
  ADD CONSTRAINT client_request_status_ck
  CHECK (status IN ('OPEN', 'FULFILLED', 'DISMISSED', 'EXPIRED', 'NEEDS_INFO'));

CREATE TYPE request_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

ALTER TABLE vibetb.client_request
  ADD COLUMN IF NOT EXISTS priority request_priority NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS template_id uuid,
  ADD COLUMN IF NOT EXISTS reminder_days_before integer,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_reply_text text;

ALTER TABLE vibetb.client_request
  ADD CONSTRAINT client_request_reminder_days_ck
  CHECK (reminder_days_before IS NULL OR reminder_days_before BETWEEN 0 AND 365);

CREATE INDEX IF NOT EXISTS client_request_priority_idx
  ON vibetb.client_request(firm_id, priority, status)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS client_request_tags_gin
  ON vibetb.client_request USING GIN (tags);

-- Reminder worker hot path.
CREATE INDEX IF NOT EXISTS client_request_reminder_due_idx
  ON vibetb.client_request(due_date)
  WHERE status IN ('OPEN', 'NEEDS_INFO')
    AND reminder_days_before IS NOT NULL
    AND due_date IS NOT NULL;

-- --- (B) request_template + items ---------------------------------------

CREATE TABLE IF NOT EXISTS vibetb.request_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  title_pattern text NOT NULL,
  body_pattern text NOT NULL DEFAULT '',
  default_priority request_priority NOT NULL DEFAULT 'MEDIUM',
  default_due_offset_days integer,
  default_reminder_days_before integer,
  default_assigned_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  CONSTRAINT request_template_key_pattern_ck CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT request_template_status_ck CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT request_template_due_offset_ck
    CHECK (default_due_offset_days IS NULL OR default_due_offset_days BETWEEN 0 AND 365),
  CONSTRAINT request_template_reminder_ck
    CHECK (default_reminder_days_before IS NULL OR default_reminder_days_before BETWEEN 0 AND 365)
);

CREATE UNIQUE INDEX IF NOT EXISTS request_template_firm_key_uk
  ON vibetb.request_template(firm_id, key);
CREATE INDEX IF NOT EXISTS request_template_firm_status_idx
  ON vibetb.request_template(firm_id, status);

ALTER TABLE vibetb.client_request
  ADD CONSTRAINT client_request_template_fk
  FOREIGN KEY (template_id) REFERENCES vibetb.request_template(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS vibetb.request_template_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES vibetb.request_template(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  label text NOT NULL,
  body text NOT NULL DEFAULT '',
  item_kind text NOT NULL DEFAULT 'QUESTION',
  required boolean NOT NULL DEFAULT true,
  default_due_offset_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_template_item_kind_ck
    CHECK (item_kind IN ('QUESTION', 'DOCUMENT', 'SIGNATURE')),
  CONSTRAINT request_template_item_label_ck CHECK (length(label) BETWEEN 1 AND 200),
  CONSTRAINT request_template_item_offset_ck
    CHECK (default_due_offset_days IS NULL OR default_due_offset_days BETWEEN 0 AND 365)
);

CREATE UNIQUE INDEX IF NOT EXISTS request_template_item_ordinal_uk
  ON vibetb.request_template_item(template_id, ordinal);

-- --- (C) client_request_item — per-request checklist ---------------------

CREATE TABLE IF NOT EXISTS vibetb.client_request_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL REFERENCES vibetb.client_request(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  label text NOT NULL,
  body text NOT NULL DEFAULT '',
  item_kind text NOT NULL DEFAULT 'QUESTION',
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'OPEN',
  due_date date,
  fulfilled_at timestamptz,
  fulfilled_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  fulfilled_by_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE SET NULL,
  fulfilled_by_file_id uuid REFERENCES vibetb.files(id) ON DELETE SET NULL,
  fulfilled_text text,
  dismissed_at timestamptz,
  dismissed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_request_item_kind_ck
    CHECK (item_kind IN ('QUESTION', 'DOCUMENT', 'SIGNATURE')),
  CONSTRAINT client_request_item_status_ck
    CHECK (status IN ('OPEN', 'FULFILLED', 'DISMISSED', 'NEEDS_INFO')),
  CONSTRAINT client_request_item_label_ck CHECK (length(label) BETWEEN 1 AND 200),
  CONSTRAINT client_request_item_fulfilled_actor_ck CHECK (
    status != 'FULFILLED'
    OR (
      (fulfilled_by_app_user_id IS NOT NULL AND fulfilled_by_portal_identity_id IS NULL)
      OR (fulfilled_by_app_user_id IS NULL AND fulfilled_by_portal_identity_id IS NOT NULL)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS client_request_item_ordinal_uk
  ON vibetb.client_request_item(client_request_id, ordinal);
CREATE INDEX IF NOT EXISTS client_request_item_request_status_idx
  ON vibetb.client_request_item(client_request_id, status);

-- --- (D) client_request_attachment — portal/staff file uploads -----------

CREATE TABLE IF NOT EXISTS vibetb.client_request_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL REFERENCES vibetb.client_request(id) ON DELETE CASCADE,
  client_request_item_id uuid REFERENCES vibetb.client_request_item(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES vibetb.files(id) ON DELETE CASCADE,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by_app_user_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  uploaded_by_portal_identity_id uuid REFERENCES vibetb.portal_identity(id) ON DELETE SET NULL,
  CONSTRAINT client_request_attachment_actor_ck CHECK (
    (uploaded_by_app_user_id IS NOT NULL AND uploaded_by_portal_identity_id IS NULL)
    OR (uploaded_by_app_user_id IS NULL AND uploaded_by_portal_identity_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS client_request_attachment_request_idx
  ON vibetb.client_request_attachment(client_request_id, uploaded_at);
